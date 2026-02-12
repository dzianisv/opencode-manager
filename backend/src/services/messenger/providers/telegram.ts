import { Bot, GrammyError, HttpError } from 'grammy'
import type { Context } from 'grammy'
import { logger } from '../../../utils/logger'
import { 
  chunkText,
} from '@opencode-manager/shared'
import type { 
  Channel, 
  ChannelCapabilities, 
  ChannelStatus, 
  InboundMessage, 
  OutboundMessage, 
  MessageHandler 
} from '@opencode-manager/shared'

const STT_ENDPOINT = process.env.STT_ENDPOINT || 'http://localhost:5001/api/stt'
const MAX_MESSAGE_LENGTH = 4096
const TYPING_INTERVAL_MS = 5000

const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  chatTypes: ['direct', 'group', 'channel'],
  media: true,
  voice: true,
  reactions: true,
  threads: true,
  maxMessageLength: MAX_MESSAGE_LENGTH,
}

export class TelegramProvider implements Channel {
  readonly id = 'telegram' as const
  readonly name = 'Telegram'
  readonly capabilities = TELEGRAM_CAPABILITIES

  private bot: Bot | null = null
  private botToken: string | null = null
  private startedAt: number | null = null
  private messageHandlers: MessageHandler[] = []

  constructor(token?: string) {
    if (token) {
        this.botToken = token
    }
  }

  isRunning(): boolean {
    return this.bot !== null
  }

  private async emitMessage(message: InboundMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      try {
        await handler(message)
      } catch (error) {
        logger.error(`Error in Telegram message handler:`, error)
      }
    }
  }

  async start(token?: string): Promise<void> {
    const botToken = token || this.botToken || process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) {
      // If no token, we just don't start, or throw? 
      // Previous implementation threw error.
      // But if initialized without token (e.g. from generic start), it might be valid to just log warning.
      // However, start() is explicit.
      if (!this.botToken && !process.env.TELEGRAM_BOT_TOKEN) {
         // Don't throw if just auto-starting without config
         logger.info('Telegram token not configured, skipping start')
         return
      }
      throw new Error('Telegram bot token not provided')
    }
    this.botToken = botToken

    if (this.bot) {
      logger.warn('Telegram bot already running, stopping first')
      await this.stop()
    }

    logger.info('Starting Telegram bot...')
    this.bot = new Bot(botToken)

    this.bot.on('message:text', async (ctx) => {
      const chatId = String(ctx.chat.id)
      const text = ctx.message.text

      const inboundMessage: InboundMessage = {
        id: String(ctx.message.message_id),
        channelId: 'telegram',
        chatId,
        senderId: ctx.from?.id ? String(ctx.from.id) : undefined,
        senderName: ctx.from?.first_name || ctx.from?.username,
        type: 'text',
        text,
        timestamp: ctx.message.date * 1000,
        raw: ctx.message,
      }

      // We don't check allowlist here anymore - MessengerService does that
      await this.emitMessage(inboundMessage)
    })

    this.bot.on('message:voice', async (ctx) => {
      const chatId = String(ctx.chat.id)
      await this.handleVoiceMessage(ctx, chatId)
    })

    this.bot.on('message:audio', async (ctx) => {
        const chatId = String(ctx.chat.id)
        await this.handleVoiceMessage(ctx, chatId, true)
    })

    this.bot.catch((err) => {
      const ctx = err.ctx
      logger.error(`Telegram error while handling update ${ctx.update.update_id}:`)
      const e = err.error
      if (e instanceof GrammyError) {
        logger.error(`Grammy error: ${e.description}`)
      } else if (e instanceof HttpError) {
        logger.error(`HTTP error: ${e}`)
      } else {
        logger.error(`Unknown error: ${e}`)
      }
    })

    try {
      const me = await this.bot.api.getMe()
      logger.info(`Telegram bot @${me.username} started successfully`)
      
      this.startedAt = Date.now()
      
      void this.bot.start({
        onStart: () => {
          logger.info('Telegram bot polling started')
        },
      })
    } catch (error) {
      this.bot = null
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      logger.info('Stopping Telegram bot...')
      await this.bot.stop()
      this.bot = null
      this.startedAt = null
      logger.info('Telegram bot stopped')
    }
  }

  getStatus(): ChannelStatus {
    return {
      running: this.isRunning(),
      connectedAt: this.startedAt ?? undefined,
      metadata: {
        botUsername: this.bot?.botInfo?.username
      }
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler)
  }

  async send(chatId: string, message: OutboundMessage): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot not running')
    }

    if (message.text) {
      const chunks = chunkText(message.text)
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk)
      }
    }

    // Handle media if necessary...
  }

  private async handleVoiceMessage(ctx: Context, chatId: string, isAudio: boolean = false): Promise<void> {
    // Send typing action
    const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {})
    }, TYPING_INTERVAL_MS)

    try {
        await ctx.replyWithChatAction('typing')

        const voice = isAudio ? ctx.message?.audio : ctx.message?.voice
        if (!voice) {
            await ctx.reply('Could not process voice message.')
            return
        }

        const fileId = voice.file_id
        const file = await ctx.api.getFile(fileId)
        const filePath = file.file_path
        if (!filePath) return

        const token = this.bot?.token
        const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`
        
        const audioResponse = await fetch(fileUrl)
        if (!audioResponse.ok) throw new Error('Failed to download voice file')
        
        const audioBuffer = Buffer.from(await audioResponse.arrayBuffer())
        const audioBase64 = audioBuffer.toString('base64')
        
        const format = filePath.endsWith('.oga') || filePath.endsWith('.ogg') 
            ? 'ogg' 
            : filePath.split('.').pop() || 'ogg'

        // Transcribe using STT service
        const sttResponse = await fetch(`${STT_ENDPOINT}/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                audio: audioBase64,
                format: format,
                language: 'auto'
            }),
            signal: AbortSignal.timeout(60000)
        })

        if (!sttResponse.ok) {
            throw new Error(`STT failed: ${sttResponse.status}`)
        }

        const sttResult = await sttResponse.json() as { text: string }
        const transcribedText = sttResult.text?.trim()

        if (transcribedText) {
             await ctx.reply(`🎤 "${transcribedText}"`)
             
             // Emit as InboundMessage
             const inboundMessage: InboundMessage = {
                id: String(ctx.message?.message_id),
                channelId: 'telegram',
                chatId,
                senderId: ctx.from?.id ? String(ctx.from.id) : undefined,
                senderName: ctx.from?.first_name || ctx.from?.username,
                type: 'voice',
                text: transcribedText, // IMPORTANT: Provide text for MessengerService to use
                timestamp: (ctx.message?.date || Date.now() / 1000) * 1000,
                raw: ctx.message,
             }
             
             await this.emitMessage(inboundMessage)
        } else {
             await ctx.reply('Could not understand voice message.')
        }

    } catch (error) {
        logger.error(`Telegram voice processing error:`, error)
        await ctx.reply('Error processing voice message.')
    } finally {
        clearInterval(typingInterval)
    }
  }
}
