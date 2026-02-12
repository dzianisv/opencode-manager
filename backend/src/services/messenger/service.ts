import { Database } from 'bun:sqlite'
import { logger } from '../../utils/logger'
import { opencodeSdkClient } from '../opencode-sdk-client'
import { channelRegistry } from '../channel-registry'
import { 
  chunkText,
} from '@opencode-manager/shared'
import type {
  InboundMessage, 
  OutboundMessage, 
  ChannelId 
} from '@opencode-manager/shared'

export class MessengerService {
  private db: Database | null = null
  private startedAt: number | null = null

  setDatabase(db: Database): void {
    this.db = db
  }

  async start(): Promise<void> {
    if (!this.db) throw new Error('Database not set')
    
    this.startedAt = Date.now()
    logger.info('Starting Messenger Service...')
    
    this.seedAllowlistFromEnv()

    // Register generic message handler
    channelRegistry.onMessage(this.handleMessage.bind(this))

    // Start all registered channels
    await channelRegistry.startAll()
  }

  async stop(): Promise<void> {
    logger.info('Stopping Messenger Service...')
    await channelRegistry.stopAll()
    this.startedAt = null
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const { channelId, chatId, text, type } = message
    
    // Authorization Check
    if (!this.isAllowed(channelId, chatId)) {
      logger.warn(`Messenger: Unauthorized access attempt from ${channelId} chat ${chatId}`)
      await channelRegistry.send(channelId, chatId, { text: 'Access denied. Contact the administrator to add your chat ID to the allowlist.' })
      return
    }

    // Process Message
    // Note: Provider should have already handled STT if type was 'voice' but converted to 'text', 
    // OR passed 'text' along with 'voice'. 
    // If text is present, we process it.
    if (!text) {
        // If it's a voice message without text (transcription failed or not handled by provider), we might ignore or reply error
        if (type === 'voice') {
            // If the provider didn't transcribe it, we can't do much here yet unless we move STT logic here.
            // For now, assume provider handles STT and sends text.
             await channelRegistry.send(channelId, chatId, { text: 'Voice message received but no text transcription available.' })
        }
        return
    }

    try {
        if (!opencodeSdkClient.isConfigured()) {
            await channelRegistry.send(channelId, chatId, { text: 'OpenCode server is not available. Please try again later.' })
            return
        }

        const session = await this.getOrCreateSession(channelId, chatId)

        const response = await this.sendToOpenCode(session.opencode_session_id, text)

        if (!response) {
            await channelRegistry.send(channelId, chatId, { text: 'No response received from OpenCode.' })
            return
        }

        const chunks = chunkText(response)
        for (const chunk of chunks) {
            await channelRegistry.send(channelId, chatId, { text: chunk })
        }
        
        this.updateSessionTimestamp(channelId, chatId)

    } catch (error) {
        logger.error(`Messenger: Error handling message from ${channelId}:${chatId}:`, error)
        await channelRegistry.send(channelId, chatId, { text: 'An error occurred while processing your message. Please try again.' })
    }
  }

  private async sendToOpenCode(sessionId: string, message: string): Promise<string | null> {
      try {
        const baseUrl = opencodeSdkClient.getBaseUrl()
        
        const response = await fetch(`${baseUrl}/session/${sessionId}/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            parts: [{ type: 'text', text: message }],
          }),
          signal: AbortSignal.timeout(120000),
        })
  
        if (!response.ok) {
          throw new Error(`OpenCode API error: ${response.status}`)
        }
  
        let fullResponse = ''
        const reader = response.body?.getReader()
        
        if (!reader) {
          throw new Error('No response body')
        }
  
        const decoder = new TextDecoder()
        
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          
          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split('\n')
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (data.type === 'part' && data.part?.type === 'text') {
                  fullResponse += data.part.text || ''
                }
              } catch {
              }
            }
          }
        }
  
        return fullResponse.trim() || null
      } catch (error) {
        logger.error('Error sending to OpenCode:', error)
        throw error
      }
    }

    private async getOrCreateSession(provider: string, chatId: string): Promise<{ opencode_session_id: string }> {
        if (!this.db) throw new Error('Database not set')

        const existing = this.db
            .prepare('SELECT opencode_session_id FROM messenger_sessions WHERE provider = ? AND provider_chat_id = ?')
            .get(provider, chatId) as { opencode_session_id: string } | undefined
        
        if (existing) return existing

        const baseUrl = opencodeSdkClient.getBaseUrl()
        const createResponse = await fetch(`${baseUrl}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `${provider} Chat ${chatId}`,
            }),
        })

        if (!createResponse.ok) {
            throw new Error(`Failed to create OpenCode session: ${createResponse.status}`)
        }

        const sessionData = await createResponse.json() as { id: string }
        const now = Date.now()

        this.db.prepare(`
            INSERT INTO messenger_sessions (provider, provider_chat_id, opencode_session_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(provider, chatId, sessionData.id, now, now)

        logger.info(`Created new ${provider} session for chat ${chatId}`)

        return { opencode_session_id: sessionData.id }
    }

    private updateSessionTimestamp(provider: string, chatId: string): void {
        if (!this.db) return
        this.db.prepare('UPDATE messenger_sessions SET updated_at = ? WHERE provider = ? AND provider_chat_id = ?')
            .run(Date.now(), provider, chatId)
    }

    isAllowed(provider: string, chatId: string): boolean {
        if (!this.db) return false
        
        const count = (this.db.prepare('SELECT COUNT(*) as count FROM messenger_allowlist').get() as { count: number }).count
        if (count === 0) return true

        const entry = this.db.prepare('SELECT 1 FROM messenger_allowlist WHERE provider = ? AND provider_chat_id = ?')
            .get(provider, chatId)
        
        return !!entry
    }

    addToAllowlist(provider: string, chatId: string): void {
        if (!this.db) throw new Error('Database not set')
        this.db.prepare('INSERT OR IGNORE INTO messenger_allowlist (provider, provider_chat_id, added_at) VALUES (?, ?, ?)')
            .run(provider, chatId, Date.now())
        logger.info(`Added chat ${chatId} (${provider}) to allowlist`)
    }

    removeFromAllowlist(provider: string, chatId: string): boolean {
        if (!this.db) throw new Error('Database not set')
        const result = this.db.prepare('DELETE FROM messenger_allowlist WHERE provider = ? AND provider_chat_id = ?')
            .run(provider, chatId)
        return result.changes > 0
    }

    getAllSessions(provider?: string): any[] {
        if (!this.db) return []
        let sql = 'SELECT * FROM messenger_sessions'
        const params: any[] = []
        if (provider) {
            sql += ' WHERE provider = ?'
            params.push(provider)
        }
        sql += ' ORDER BY updated_at DESC'
        return this.db.prepare(sql).all(...params)
    }

    getAllowlist(provider?: string): any[] {
        if (!this.db) return []
        let sql = 'SELECT * FROM messenger_allowlist'
        const params: any[] = []
        if (provider) {
            sql += ' WHERE provider = ?'
            params.push(provider)
        }
        sql += ' ORDER BY added_at DESC'
        return this.db.prepare(sql).all(...params)
    }
    
    deleteSession(provider: string, chatId: string): boolean {
        if (!this.db) throw new Error('Database not set')
        const result = this.db.prepare('DELETE FROM messenger_sessions WHERE provider = ? AND provider_chat_id = ?')
            .run(provider, chatId)
        return result.changes > 0
    }

    private seedAllowlistFromEnv(): void {
        // Legacy Telegram Support
        const telegramAllowlist = process.env.TELEGRAM_ALLOWLIST
        if (telegramAllowlist) {
            const chatIds = telegramAllowlist.split(',').map(id => id.trim()).filter(Boolean)
            for (const id of chatIds) {
                this.addToAllowlist('telegram', id)
            }
        }
    }
}

export const messengerService = new MessengerService()
