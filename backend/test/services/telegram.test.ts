import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockBotInstance = {
  on: vi.fn(),
  catch: vi.fn(),
  api: {
    getMe: vi.fn().mockResolvedValue({ username: 'test_bot' }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  },
  init: vi.fn().mockResolvedValue(undefined),
  start: vi.fn(),
  stop: vi.fn(),
  token: 'test-token',
  botInfo: { username: 'test_bot' },
}

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => mockBotInstance),
  GrammyError: class GrammyError extends Error {},
  HttpError: class HttpError extends Error {},
}))

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}))

const { TelegramProvider } = await import('../../src/services/messenger/providers/telegram')
const { Bot } = await import('grammy')

describe('TelegramProvider', () => {
  let provider: InstanceType<typeof TelegramProvider>

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new TelegramProvider()
  })

  afterEach(async () => {
    if (provider) {
      await provider.stop()
    }
  })

  describe('constructor', () => {
    it('should create provider without token', () => {
      const p = new TelegramProvider()
      expect(p.id).toBe('telegram')
      expect(p.name).toBe('Telegram')
    })

    it('should create provider with token', () => {
      const p = new TelegramProvider('my-token')
      expect(p.id).toBe('telegram')
    })
  })

  describe('capabilities', () => {
    it('should have correct capabilities', () => {
      expect(provider.capabilities.chatTypes).toContain('direct')
      expect(provider.capabilities.chatTypes).toContain('group')
      expect(provider.capabilities.media).toBe(true)
      expect(provider.capabilities.voice).toBe(true)
      expect(provider.capabilities.maxMessageLength).toBe(4096)
    })
  })

  describe('isRunning', () => {
    it('should return false when not started', () => {
      expect(provider.isRunning()).toBe(false)
    })

    it('should return true after starting', async () => {
      await provider.start('test-token')
      expect(provider.isRunning()).toBe(true)
    })
  })

  describe('start', () => {
    it('should start the bot successfully', async () => {
      await provider.start('test-token')
      
      expect(Bot).toHaveBeenCalledWith('test-token')
      expect(provider.isRunning()).toBe(true)
    })

    it('should register message handlers', async () => {
      await provider.start('test-token')
      
      expect(mockBotInstance.on).toHaveBeenCalledWith('message:text', expect.any(Function))
      expect(mockBotInstance.on).toHaveBeenCalledWith('message:voice', expect.any(Function))
      expect(mockBotInstance.on).toHaveBeenCalledWith('message:audio', expect.any(Function))
    })

    it('should register error handler', async () => {
      await provider.start('test-token')
      
      expect(mockBotInstance.catch).toHaveBeenCalledWith(expect.any(Function))
    })

    it('should call init to verify token', async () => {
      await provider.start('test-token')
      
      expect(mockBotInstance.init).toHaveBeenCalled()
    })

    it('should stop existing bot before starting new one', async () => {
      await provider.start('token-1')
      mockBotInstance.stop.mockClear()
      
      await provider.start('token-2')
      expect(mockBotInstance.stop).toHaveBeenCalled()
    })

    it('should not start without token if not configured', async () => {
      const originalEnv = process.env.TELEGRAM_BOT_TOKEN
      delete process.env.TELEGRAM_BOT_TOKEN
      
      const p = new TelegramProvider()
      await p.start()
      expect(p.isRunning()).toBe(false)
      
      process.env.TELEGRAM_BOT_TOKEN = originalEnv
    })
  })

  describe('stop', () => {
    it('should stop the bot', async () => {
      await provider.start('test-token')
      await provider.stop()
      
      expect(provider.isRunning()).toBe(false)
    })

    it('should not throw if bot not started', async () => {
      await expect(provider.stop()).resolves.toBeUndefined()
    })
  })

  describe('getStatus', () => {
    it('should return status when not running', () => {
      const status = provider.getStatus()
      
      expect(status.running).toBe(false)
      expect(status.connectedAt).toBeUndefined()
    })

    it('should return status when running', async () => {
      await provider.start('test-token')
      const status = provider.getStatus()
      
      expect(status.running).toBe(true)
      expect(status.connectedAt).toBeDefined()
      expect(status.metadata?.botUsername).toBe('test_bot')
    })
  })

  describe('onMessage', () => {
    it('should register message handler', () => {
      const handler = vi.fn()
      provider.onMessage(handler)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('send', () => {
    it('should throw if bot not running', async () => {
      await expect(provider.send('123', { text: 'hello' }))
        .rejects.toThrow('Telegram bot not running')
    })

    it('should send text message', async () => {
      await provider.start('test-token')
      await provider.send('123', { text: 'Hello world' })
      
      expect(mockBotInstance.api.sendMessage).toHaveBeenCalledWith('123', 'Hello world')
    })

    it('should chunk long messages', async () => {
      await provider.start('test-token')
      const longText = 'a'.repeat(5000)
      await provider.send('123', { text: longText })
      
      expect(mockBotInstance.api.sendMessage).toHaveBeenCalledTimes(2)
    })
  })
})
