import { Hono } from 'hono'
import { z } from 'zod'
import { Database } from 'bun:sqlite'
import { messengerService } from '../services/messenger/service'
import { channelRegistry } from '../services/channel-registry'
import { TelegramProvider } from '../services/messenger/providers/telegram'
import { logger } from '../utils/logger'

const AddToAllowlistSchema = z.object({
  chatId: z.string().min(1),
})

const StartBotSchema = z.object({
  token: z.string().min(1),
})

export function createTelegramRoutes(db: Database) {
  const app = new Hono()

  // Note: Database is already set in messengerService by index.ts

  app.get('/status', async (c) => {
    const status = channelRegistry.getStatus('telegram')
    return c.json(status || { running: false })
  })

  app.post('/start', async (c) => {
    try {
      const body = await c.req.json()
      const parsed = StartBotSchema.safeParse(body)
      
      const channel = channelRegistry.get('telegram')
      if (!channel) {
          return c.json({ error: 'Telegram channel not registered' }, 500)
      }

      // Cast to specific provider to access specific start method signature if needed
      const telegramProvider = channel as TelegramProvider

      if (!parsed.success) {
        const token = process.env.TELEGRAM_BOT_TOKEN
        if (!token) {
          return c.json({ error: 'No token provided and TELEGRAM_BOT_TOKEN not set' }, 400)
        }
        await telegramProvider.start(token)
      } else {
        await telegramProvider.start(parsed.data.token)
      }
      
      return c.json({ success: true, status: channel.getStatus() })
    } catch (error) {
      logger.error('Failed to start Telegram bot:', error)
      return c.json({ 
        error: error instanceof Error ? error.message : 'Failed to start bot' 
      }, 500)
    }
  })

  app.post('/stop', async (c) => {
    try {
      await channelRegistry.stop('telegram')
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to stop Telegram bot:', error)
      return c.json({ 
        error: error instanceof Error ? error.message : 'Failed to stop bot' 
      }, 500)
    }
  })

  app.get('/sessions', async (c) => {
    const sessions = messengerService.getAllSessions('telegram')
    return c.json(sessions)
  })

  app.delete('/sessions/:chatId', async (c) => {
    const chatId = c.req.param('chatId')
    const deleted = messengerService.deleteSession('telegram', chatId)
    
    if (deleted) {
      return c.json({ success: true })
    }
    return c.json({ error: 'Session not found' }, 404)
  })

  app.get('/allowlist', async (c) => {
    const allowlist = messengerService.getAllowlist('telegram')
    return c.json(allowlist)
  })

  app.post('/allowlist', async (c) => {
    try {
      const body = await c.req.json()
      const parsed = AddToAllowlistSchema.safeParse(body)
      
      if (!parsed.success) {
        return c.json({ error: 'Invalid request: chatId is required' }, 400)
      }
      
      messengerService.addToAllowlist('telegram', parsed.data.chatId)
      return c.json({ success: true })
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Failed to add to allowlist' 
      }, 500)
    }
  })

  app.delete('/allowlist/:chatId', async (c) => {
    const chatId = c.req.param('chatId')
    const removed = messengerService.removeFromAllowlist('telegram', chatId)
    
    if (removed) {
      return c.json({ success: true })
    }
    return c.json({ error: 'Chat ID not found in allowlist' }, 404)
  })

  return app
}
