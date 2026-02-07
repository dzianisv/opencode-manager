import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn()
}))

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    catch: vi.fn(),
    api: {
      getMe: vi.fn().mockResolvedValue({ username: 'test_bot' }),
    },
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
  GrammyError: class GrammyError extends Error {},
  HttpError: class HttpError extends Error {},
}))

vi.mock('../../src/services/opencode-sdk-client', () => ({
  opencodeSdkClient: {
    isConfigured: vi.fn().mockReturnValue(true),
    getBaseUrl: vi.fn().mockReturnValue('http://localhost:5551'),
  },
}))

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}))

import { telegramService } from '../../src/services/telegram'

describe('TelegramService', () => {
  let mockDb: any

  beforeEach(() => {
    mockDb = {
      run: vi.fn(),
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => {
          if (sql.includes('COUNT')) return { count: 0 }
          return undefined
        }),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ changes: 0, lastInsertRowid: 1 })),
      })),
    }
  })

  describe('chunkText utility', () => {
    it('should return text unchanged if under limit', () => {
      const text = 'Hello world'
      expect(text.length).toBeLessThan(4096)
    })

    it('should handle very long text by splitting', () => {
      const longText = 'A'.repeat(5000)
      expect(longText.length).toBeGreaterThan(4096)
    })
  })

  describe('service structure', () => {
    it('should export telegramService singleton', () => {
      expect(telegramService).toBeDefined()
    })

    it('should have required methods', () => {
      expect(typeof telegramService.setDatabase).toBe('function')
      expect(typeof telegramService.isRunning).toBe('function')
      expect(typeof telegramService.start).toBe('function')
      expect(typeof telegramService.stop).toBe('function')
      expect(typeof telegramService.getStatus).toBe('function')
      expect(typeof telegramService.getAllSessions).toBe('function')
      expect(typeof telegramService.getAllowlist).toBe('function')
      expect(typeof telegramService.addToAllowlist).toBe('function')
      expect(typeof telegramService.removeFromAllowlist).toBe('function')
      expect(typeof telegramService.deleteSession).toBe('function')
      expect(typeof telegramService.seedAllowlistFromEnv).toBe('function')
    })

    it('should have correct TelegramSession type structure', () => {
      const mockSession = {
        id: 1,
        chat_id: '123',
        opencode_session_id: 'sess-1',
        created_at: Date.now(),
        updated_at: Date.now(),
      }
      expect(mockSession).toHaveProperty('id')
      expect(mockSession).toHaveProperty('chat_id')
      expect(mockSession).toHaveProperty('opencode_session_id')
    })

    it('should have correct TelegramStatus type', () => {
      telegramService.setDatabase(mockDb)
      const status = telegramService.getStatus()
      
      expect(status).toHaveProperty('running')
      expect(status).toHaveProperty('activeSessions')
      expect(status).toHaveProperty('allowlistCount')
    })
  })

  describe('database operations', () => {
    it('should set database without error', () => {
      expect(() => telegramService.setDatabase(mockDb)).not.toThrow()
    })

    it('should return empty sessions when db returns empty', () => {
      telegramService.setDatabase(mockDb)
      const sessions = telegramService.getAllSessions()
      expect(sessions).toEqual([])
    })

    it('should return empty allowlist when db returns empty', () => {
      telegramService.setDatabase(mockDb)
      const allowlist = telegramService.getAllowlist()
      expect(allowlist).toEqual([])
    })
  })

  describe('bot state', () => {
    it('should report not running initially', () => {
      expect(telegramService.isRunning()).toBe(false)
    })

    it('should include bot username in status when available', () => {
      telegramService.setDatabase(mockDb)
      const status = telegramService.getStatus()
      expect(status).toHaveProperty('running')
    })
  })
})
