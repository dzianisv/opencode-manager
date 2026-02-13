import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { Hono } from 'hono'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn()
}))

vi.mock('../../src/services/messenger/service', () => ({
  messengerService: {
    setDatabase: vi.fn(),
    getAllSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn().mockReturnValue(true),
    getAllowlist: vi.fn().mockReturnValue([]),
    addToAllowlist: vi.fn(),
    removeFromAllowlist: vi.fn().mockReturnValue(true),
  }
}))

vi.mock('../../src/services/channel-registry', () => ({
  channelRegistry: {
    get: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      running: false,
      activeSessions: 0,
      allowlistCount: 0,
    }),
    stop: vi.fn(),
  }
}))



vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}))

import { createTelegramRoutes } from '../../src/routes/telegram'
import { messengerService } from '../../src/services/messenger/service'
import { channelRegistry } from '../../src/services/channel-registry'

describe('Telegram Routes', () => {
  let app: Hono
  let mockDb: any
  let mockTelegramChannel: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = {}
    
    mockTelegramChannel = {
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ running: true }),
    }
    
    app = new Hono()
    app.route('/api/telegram', createTelegramRoutes(mockDb))
  })

  describe('GET /api/telegram/status', () => {
    it('should return bot status', async () => {
      const res = await app.request('/api/telegram/status')
      
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toHaveProperty('running')
    })

    it('should return running status when bot is active', async () => {
      (channelRegistry.getStatus as Mock).mockReturnValueOnce({
        running: true,
        activeSessions: 5,
        allowlistCount: 3,
        startedAt: Date.now(),
      })
      
      const res = await app.request('/api/telegram/status')
      const data = await res.json()
      
      expect(data.running).toBe(true)
      expect(data.activeSessions).toBe(5)
    })
  })

  describe('POST /api/telegram/start', () => {
    it('should start bot with provided token', async () => {
      (channelRegistry.get as Mock).mockReturnValue(mockTelegramChannel)
      
      const res = await app.request('/api/telegram/start', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-token' }),
        headers: { 'Content-Type': 'application/json' }
      })
      
      expect(res.status).toBe(200)
      expect(mockTelegramChannel.start).toHaveBeenCalledWith('test-token')
    })

    it('should use env token if not provided', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token'
      ;(channelRegistry.get as Mock).mockReturnValue(mockTelegramChannel)
      
      const res = await app.request('/api/telegram/start', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' }
      })
      
      expect(res.status).toBe(200)
      expect(mockTelegramChannel.start).toHaveBeenCalledWith('env-token')
      
      delete process.env.TELEGRAM_BOT_TOKEN
    })

    it('should use env token when no body is sent', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token'
      ;(channelRegistry.get as Mock).mockReturnValue(mockTelegramChannel)
      
      const res = await app.request('/api/telegram/start', {
        method: 'POST',
      })
      
      expect(res.status).toBe(200)
      expect(mockTelegramChannel.start).toHaveBeenCalledWith('env-token')
      
      delete process.env.TELEGRAM_BOT_TOKEN
    })

    it('should return 400 if no token available', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN
      ;(channelRegistry.get as Mock).mockReturnValue(mockTelegramChannel)
      
      const res = await app.request('/api/telegram/start', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' }
      })
      
      expect(res.status).toBe(400)
    })

    it('should return 400 if no body and no env token', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN
      ;(channelRegistry.get as Mock).mockReturnValue(mockTelegramChannel)
      
      const res = await app.request('/api/telegram/start', {
        method: 'POST',
      })
      
      expect(res.status).toBe(400)
    })

    it('should return 500 if channel not registered', async () => {
      (channelRegistry.get as Mock).mockReturnValue(null)
      
      const res = await app.request('/api/telegram/start', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-token' }),
        headers: { 'Content-Type': 'application/json' }
      })
      
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Telegram channel not registered')
    })

    it('should return 500 on start failure', async () => {
      (channelRegistry.get as Mock).mockReturnValue(mockTelegramChannel)
      mockTelegramChannel.start.mockRejectedValueOnce(new Error('Invalid token'))
      
      const res = await app.request('/api/telegram/start', {
        method: 'POST',
        body: JSON.stringify({ token: 'bad-token' }),
        headers: { 'Content-Type': 'application/json' }
      })
      
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Invalid token')
    })
  })

  describe('POST /api/telegram/stop', () => {
    it('should stop the bot', async () => {
      const res = await app.request('/api/telegram/stop', { method: 'POST' })
      
      expect(res.status).toBe(200)
      expect(channelRegistry.stop).toHaveBeenCalledWith('telegram')
    })

    it('should return 500 on stop failure', async () => {
      (channelRegistry.stop as Mock).mockRejectedValueOnce(new Error('Stop failed'))
      
      const res = await app.request('/api/telegram/stop', { method: 'POST' })
      
      expect(res.status).toBe(500)
    })
  })

  describe('GET /api/telegram/sessions', () => {
    it('should return empty sessions list', async () => {
      const res = await app.request('/api/telegram/sessions')
      
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual([])
    })

    it('should return sessions list', async () => {
      (messengerService.getAllSessions as Mock).mockReturnValueOnce([
        { id: 1, provider_chat_id: '111', opencode_session_id: 'sess-1', created_at: Date.now(), updated_at: Date.now() }
      ])
      
      const res = await app.request('/api/telegram/sessions')
      const data = await res.json()
      
      expect(data).toHaveLength(1)
      expect(data[0].provider_chat_id).toBe('111')
    })
  })

  describe('DELETE /api/telegram/sessions/:chatId', () => {
    it('should delete session', async () => {
      const res = await app.request('/api/telegram/sessions/12345', { method: 'DELETE' })
      
      expect(res.status).toBe(200)
      expect(messengerService.deleteSession).toHaveBeenCalledWith('telegram', '12345')
    })

    it('should return 404 if session not found', async () => {
      (messengerService.deleteSession as Mock).mockReturnValueOnce(false)
      
      const res = await app.request('/api/telegram/sessions/99999', { method: 'DELETE' })
      
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/telegram/allowlist', () => {
    it('should return empty allowlist', async () => {
      const res = await app.request('/api/telegram/allowlist')
      
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual([])
    })

    it('should return allowlist entries', async () => {
      (messengerService.getAllowlist as Mock).mockReturnValueOnce([
        { id: 1, provider_chat_id: '111', added_at: Date.now() },
        { id: 2, provider_chat_id: '222', added_at: Date.now() }
      ])
      
      const res = await app.request('/api/telegram/allowlist')
      const data = await res.json()
      
      expect(data).toHaveLength(2)
    })
  })

  describe('POST /api/telegram/allowlist', () => {
    it('should add chat ID to allowlist', async () => {
      const res = await app.request('/api/telegram/allowlist', {
        method: 'POST',
        body: JSON.stringify({ chatId: '12345' }),
        headers: { 'Content-Type': 'application/json' }
      })
      
      expect(res.status).toBe(200)
      expect(messengerService.addToAllowlist).toHaveBeenCalledWith('telegram', '12345')
    })

    it('should return 400 if chatId missing', async () => {
      const res = await app.request('/api/telegram/allowlist', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' }
      })
      
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /api/telegram/allowlist/:chatId', () => {
    it('should remove chat ID from allowlist', async () => {
      const res = await app.request('/api/telegram/allowlist/12345', { method: 'DELETE' })
      
      expect(res.status).toBe(200)
      expect(messengerService.removeFromAllowlist).toHaveBeenCalledWith('telegram', '12345')
    })

    it('should return 404 if chat ID not found', async () => {
      (messengerService.removeFromAllowlist as Mock).mockReturnValueOnce(false)
      
      const res = await app.request('/api/telegram/allowlist/99999', { method: 'DELETE' })
      
      expect(res.status).toBe(404)
    })
  })
})
