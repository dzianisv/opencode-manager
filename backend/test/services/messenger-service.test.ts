import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../src/services/opencode-sdk-client', () => ({
  opencodeSdkClient: {
    isConfigured: vi.fn().mockReturnValue(true),
    getBaseUrl: vi.fn().mockReturnValue('http://localhost:5551'),
  },
}))

const registryHandlers: any[] = []
vi.mock('../../src/services/channel-registry', () => ({
  channelRegistry: {
    onMessage: vi.fn((handler: any) => registryHandlers.push(handler)),
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  },
}))

function createMockDb() {
  const sessions = new Map<string, { provider: string; provider_chat_id: string; opencode_session_id: string; created_at: number; updated_at: number }>()
  const allowlist = new Map<string, { provider: string; provider_chat_id: string; added_at: number }>()

  const key = (provider: string, chatId: string) => `${provider}:${chatId}`

  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('SELECT opencode_session_id FROM messenger_sessions')) {
        return {
          get: (_provider: string, _chatId: string) => {
            const entry = sessions.get(key(_provider, _chatId))
            return entry ? { opencode_session_id: entry.opencode_session_id } : undefined
          },
        }
      }
      if (sql.includes('INSERT INTO messenger_sessions')) {
        return {
          run: (provider: string, chatId: string, sessionId: string, createdAt: number, updatedAt: number) => {
            sessions.set(key(provider, chatId), { provider, provider_chat_id: chatId, opencode_session_id: sessionId, created_at: createdAt, updated_at: updatedAt })
          },
        }
      }
      if (sql.includes('UPDATE messenger_sessions SET updated_at')) {
        return {
          run: (updatedAt: number, provider: string, chatId: string) => {
            const entry = sessions.get(key(provider, chatId))
            if (entry) entry.updated_at = updatedAt
          },
        }
      }
      if (sql.includes('SELECT COUNT(*) as count FROM messenger_allowlist')) {
        return {
          get: () => ({ count: allowlist.size }),
        }
      }
      if (sql.includes('SELECT 1 FROM messenger_allowlist')) {
        return {
          get: (provider: string, chatId: string) => {
            return allowlist.has(key(provider, chatId)) ? { '1': 1 } : undefined
          },
        }
      }
      if (sql.includes('INSERT OR IGNORE INTO messenger_allowlist')) {
        return {
          run: (provider: string, chatId: string, addedAt: number) => {
            const k = key(provider, chatId)
            if (!allowlist.has(k)) {
              allowlist.set(k, { provider, provider_chat_id: chatId, added_at: addedAt })
            }
          },
        }
      }
      if (sql.includes('DELETE FROM messenger_allowlist')) {
        return {
          run: (provider: string, chatId: string) => {
            const k = key(provider, chatId)
            const had = allowlist.has(k)
            allowlist.delete(k)
            return { changes: had ? 1 : 0 }
          },
        }
      }
      if (sql.includes('DELETE FROM messenger_sessions')) {
        return {
          run: (provider: string, chatId: string) => {
            const k = key(provider, chatId)
            const had = sessions.has(k)
            sessions.delete(k)
            return { changes: had ? 1 : 0 }
          },
        }
      }
      if (sql.includes('SELECT * FROM messenger_sessions')) {
        return {
          all: (...params: any[]) => {
            const entries = Array.from(sessions.values())
            if (params[0]) {
              return entries.filter(e => e.provider === params[0])
            }
            return entries
          },
        }
      }
      if (sql.includes('SELECT * FROM messenger_allowlist')) {
        return {
          all: (...params: any[]) => {
            const entries = Array.from(allowlist.values())
            if (params[0]) {
              return entries.filter(e => e.provider === params[0])
            }
            return entries
          },
        }
      }
      return { get: vi.fn(), run: vi.fn(), all: vi.fn().mockReturnValue([]) }
    }),
    _sessions: sessions,
    _allowlist: allowlist,
  } as any
}

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

describe('MessengerService', () => {
  let MessengerServiceClass: any
  let service: any
  let mockDb: any
  let channelRegistry: any

  beforeEach(async () => {
    vi.clearAllMocks()
    registryHandlers.length = 0

    mockDb = createMockDb()

    const serviceModule = await import('../../src/services/messenger/service')
    MessengerServiceClass = serviceModule.MessengerService
    service = new MessengerServiceClass()
    service.setDatabase(mockDb)

    const registryModule = await import('../../src/services/channel-registry')
    channelRegistry = registryModule.channelRegistry
  })

  describe('isAllowed', () => {
    it('should allow all when allowlist is empty', () => {
      expect(service.isAllowed('telegram', '123')).toBe(true)
    })

    it('should allow listed chat', () => {
      service.addToAllowlist('telegram', '123')
      expect(service.isAllowed('telegram', '123')).toBe(true)
    })

    it('should deny unlisted chat when allowlist has entries', () => {
      service.addToAllowlist('telegram', '456')
      expect(service.isAllowed('telegram', '123')).toBe(false)
    })

    it('should handle different providers independently', () => {
      service.addToAllowlist('telegram', '123')
      expect(service.isAllowed('slack', '123')).toBe(false)
    })

    it('should return false if database not set', () => {
      const s = new MessengerServiceClass()
      expect(s.isAllowed('telegram', '123')).toBe(false)
    })
  })

  describe('addToAllowlist / removeFromAllowlist', () => {
    it('should add to allowlist', () => {
      service.addToAllowlist('telegram', '123')
      const list = service.getAllowlist()
      expect(list).toHaveLength(1)
      expect(list[0].provider).toBe('telegram')
      expect(list[0].provider_chat_id).toBe('123')
    })

    it('should not duplicate entries', () => {
      service.addToAllowlist('telegram', '123')
      service.addToAllowlist('telegram', '123')
      expect(service.getAllowlist()).toHaveLength(1)
    })

    it('should remove from allowlist', () => {
      service.addToAllowlist('telegram', '123')
      expect(service.removeFromAllowlist('telegram', '123')).toBe(true)
      expect(service.getAllowlist()).toHaveLength(0)
    })

    it('should return false when removing non-existent entry', () => {
      expect(service.removeFromAllowlist('telegram', '999')).toBe(false)
    })

    it('should throw if database not set', () => {
      const s = new MessengerServiceClass()
      expect(() => s.addToAllowlist('telegram', '123')).toThrow('Database not set')
    })
  })

  describe('getAllowlist', () => {
    it('should return empty array when no entries', () => {
      expect(service.getAllowlist()).toEqual([])
    })

    it('should filter by provider', () => {
      service.addToAllowlist('telegram', '123')
      service.addToAllowlist('slack', '456')
      expect(service.getAllowlist('telegram')).toHaveLength(1)
      expect(service.getAllowlist('slack')).toHaveLength(1)
    })

    it('should return all providers when no filter', () => {
      service.addToAllowlist('telegram', '123')
      service.addToAllowlist('slack', '456')
      expect(service.getAllowlist()).toHaveLength(2)
    })

    it('should return empty array if database not set', () => {
      const s = new MessengerServiceClass()
      expect(s.getAllowlist()).toEqual([])
    })
  })

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', () => {
      expect(service.getAllSessions()).toEqual([])
    })

    it('should return sessions filtered by provider', () => {
      const now = Date.now()
      mockDb._sessions.set('telegram:123', { provider: 'telegram', provider_chat_id: '123', opencode_session_id: 'sess-1', created_at: now, updated_at: now })
      mockDb._sessions.set('slack:456', { provider: 'slack', provider_chat_id: '456', opencode_session_id: 'sess-2', created_at: now, updated_at: now })

      expect(service.getAllSessions('telegram')).toHaveLength(1)
      expect(service.getAllSessions('slack')).toHaveLength(1)
      expect(service.getAllSessions()).toHaveLength(2)
    })

    it('should return empty array if database not set', () => {
      const s = new MessengerServiceClass()
      expect(s.getAllSessions()).toEqual([])
    })
  })

  describe('deleteSession', () => {
    it('should delete existing session', () => {
      const now = Date.now()
      mockDb._sessions.set('telegram:123', { provider: 'telegram', provider_chat_id: '123', opencode_session_id: 'sess-1', created_at: now, updated_at: now })

      expect(service.deleteSession('telegram', '123')).toBe(true)
      expect(service.getAllSessions()).toHaveLength(0)
    })

    it('should return false for non-existent session', () => {
      expect(service.deleteSession('telegram', '999')).toBe(false)
    })

    it('should throw if database not set', () => {
      const s = new MessengerServiceClass()
      expect(() => s.deleteSession('telegram', '123')).toThrow('Database not set')
    })
  })

  describe('seedAllowlistFromEnv', () => {
    it('should seed from TELEGRAM_ALLOWLIST env var', () => {
      const original = process.env.TELEGRAM_ALLOWLIST
      process.env.TELEGRAM_ALLOWLIST = '111,222,333'

      const s = new MessengerServiceClass()
      s.setDatabase(mockDb)
      ;(s as any).seedAllowlistFromEnv()

      const list = s.getAllowlist('telegram')
      expect(list).toHaveLength(3)
      expect(list.map((e: any) => e.provider_chat_id).sort()).toEqual(['111', '222', '333'])

      if (original !== undefined) {
        process.env.TELEGRAM_ALLOWLIST = original
      } else {
        delete process.env.TELEGRAM_ALLOWLIST
      }
    })

    it('should handle missing TELEGRAM_ALLOWLIST', () => {
      const original = process.env.TELEGRAM_ALLOWLIST
      delete process.env.TELEGRAM_ALLOWLIST

      const s = new MessengerServiceClass()
      s.setDatabase(mockDb)
      ;(s as any).seedAllowlistFromEnv()

      expect(s.getAllowlist()).toHaveLength(0)

      if (original !== undefined) {
        process.env.TELEGRAM_ALLOWLIST = original
      }
    })

    it('should trim whitespace from chat ids', () => {
      const original = process.env.TELEGRAM_ALLOWLIST
      process.env.TELEGRAM_ALLOWLIST = ' 111 , 222 , '

      const s = new MessengerServiceClass()
      s.setDatabase(mockDb)
      ;(s as any).seedAllowlistFromEnv()

      const list = s.getAllowlist('telegram')
      expect(list).toHaveLength(2)
      expect(list.map((e: any) => e.provider_chat_id).sort()).toEqual(['111', '222'])

      if (original !== undefined) {
        process.env.TELEGRAM_ALLOWLIST = original
      } else {
        delete process.env.TELEGRAM_ALLOWLIST
      }
    })
  })

  describe('start', () => {
    it('should throw if database not set', async () => {
      const s = new MessengerServiceClass()
      await expect(s.start()).rejects.toThrow('Database not set')
    })

    it('should register message handler and start channels', async () => {
      const original = process.env.TELEGRAM_ALLOWLIST
      delete process.env.TELEGRAM_ALLOWLIST

      await service.start()

      expect(channelRegistry.onMessage).toHaveBeenCalledWith(expect.any(Function))
      expect(channelRegistry.startAll).toHaveBeenCalled()

      if (original !== undefined) {
        process.env.TELEGRAM_ALLOWLIST = original
      }
    })
  })

  describe('stop', () => {
    it('should stop all channels', async () => {
      await service.stop()
      expect(channelRegistry.stopAll).toHaveBeenCalled()
    })
  })

  describe('handleMessage (via registry handler)', () => {
    let handleMessage: (msg: any) => Promise<void>

    beforeEach(async () => {
      const original = process.env.TELEGRAM_ALLOWLIST
      delete process.env.TELEGRAM_ALLOWLIST
      await service.start()
      if (original !== undefined) {
        process.env.TELEGRAM_ALLOWLIST = original
      }

      handleMessage = registryHandlers[registryHandlers.length - 1]
    })

    it('should deny unauthorized access', async () => {
      service.addToAllowlist('telegram', '999')

      await handleMessage({
        id: '1',
        channelId: 'telegram',
        chatId: '123',
        type: 'text',
        text: 'hello',
        timestamp: Date.now(),
      })

      expect(channelRegistry.send).toHaveBeenCalledWith(
        'telegram',
        '123',
        expect.objectContaining({ text: expect.stringContaining('Access denied') })
      )
    })

    it('should handle voice message without text', async () => {
      await handleMessage({
        id: '1',
        channelId: 'telegram',
        chatId: '123',
        type: 'voice',
        timestamp: Date.now(),
      })

      expect(channelRegistry.send).toHaveBeenCalledWith(
        'telegram',
        '123',
        expect.objectContaining({ text: expect.stringContaining('no text transcription') })
      )
    })

    it('should silently ignore text message with no text content', async () => {
      await handleMessage({
        id: '1',
        channelId: 'telegram',
        chatId: '123',
        type: 'text',
        timestamp: Date.now(),
      })

      expect(channelRegistry.send).not.toHaveBeenCalled()
    })

    it('should send error when OpenCode not configured', async () => {
      const { opencodeSdkClient } = await import('../../src/services/opencode-sdk-client')
      ;(opencodeSdkClient.isConfigured as any).mockReturnValueOnce(false)

      await handleMessage({
        id: '1',
        channelId: 'telegram',
        chatId: '123',
        type: 'text',
        text: 'hello',
        timestamp: Date.now(),
      })

      expect(channelRegistry.send).toHaveBeenCalledWith(
        'telegram',
        '123',
        expect.objectContaining({ text: expect.stringContaining('not available') })
      )
    })

    it('should create session and relay message to OpenCode', async () => {
      const sseBody = 'data: {"type":"part","part":{"type":"text","text":"Hello back!"}}\n\n'
      const encoder = new TextEncoder()

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any) => {
        if (String(url).includes('/session') && !String(url).includes('/message')) {
          return new Response(JSON.stringify({ id: 'oc-session-1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sseBody))
              controller.close()
            },
          }),
          { status: 200 }
        )
      }) as any

      try {
        await handleMessage({
          id: '1',
          channelId: 'telegram',
          chatId: '123',
          type: 'text',
          text: 'hello',
          timestamp: Date.now(),
        })

        expect(channelRegistry.send).toHaveBeenCalledWith(
          'telegram',
          '123',
          expect.objectContaining({ text: 'Hello back!' })
        )

        const sessions = service.getAllSessions('telegram')
        expect(sessions).toHaveLength(1)
        expect(sessions[0].opencode_session_id).toBe('oc-session-1')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should reuse existing session', async () => {
      const now = Date.now()
      mockDb._sessions.set('telegram:123', { provider: 'telegram', provider_chat_id: '123', opencode_session_id: 'existing-session', created_at: now, updated_at: now })

      const sseBody = 'data: {"type":"part","part":{"type":"text","text":"response"}}\n\n'
      const encoder = new TextEncoder()

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any) => {
        if (String(url).includes('/session/existing-session/message')) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(sseBody))
                controller.close()
              },
            }),
            { status: 200 }
          )
        }
        throw new Error(`Unexpected fetch to ${url}`)
      }) as any

      try {
        await handleMessage({
          id: '1',
          channelId: 'telegram',
          chatId: '123',
          type: 'text',
          text: 'hello',
          timestamp: Date.now(),
        })

        expect(channelRegistry.send).toHaveBeenCalledWith(
          'telegram',
          '123',
          expect.objectContaining({ text: 'response' })
        )
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should send error message on OpenCode API failure', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any) => {
        if (String(url).includes('/session') && !String(url).includes('/message')) {
          return new Response(JSON.stringify({ id: 'sess-1' }), { status: 200 })
        }
        return new Response('Internal Error', { status: 500 })
      }) as any

      try {
        await handleMessage({
          id: '1',
          channelId: 'telegram',
          chatId: '123',
          type: 'text',
          text: 'hello',
          timestamp: Date.now(),
        })

        expect(channelRegistry.send).toHaveBeenCalledWith(
          'telegram',
          '123',
          expect.objectContaining({ text: expect.stringContaining('error occurred') })
        )
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should handle empty response from OpenCode', async () => {
      const encoder = new TextEncoder()

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any) => {
        if (String(url).includes('/session') && !String(url).includes('/message')) {
          return new Response(JSON.stringify({ id: 'sess-1' }), { status: 200 })
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'))
              controller.close()
            },
          }),
          { status: 200 }
        )
      }) as any

      try {
        await handleMessage({
          id: '1',
          channelId: 'telegram',
          chatId: '123',
          type: 'text',
          text: 'hello',
          timestamp: Date.now(),
        })

        expect(channelRegistry.send).toHaveBeenCalledWith(
          'telegram',
          '123',
          expect.objectContaining({ text: expect.stringContaining('No response') })
        )
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
