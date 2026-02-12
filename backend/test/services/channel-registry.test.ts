import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Channel, ChannelCapabilities, ChannelStatus, InboundMessage, OutboundMessage, MessageHandler } from '@opencode-manager/shared'

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

function createMockChannel(id: string, name?: string): Channel {
  const handlers: MessageHandler[] = []
  return {
    id: id as any,
    name: name || `Mock ${id}`,
    capabilities: {
      chatTypes: ['direct'],
      media: false,
      voice: false,
      reactions: false,
      threads: false,
    } as ChannelCapabilities,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ running: false } as ChannelStatus),
    send: vi.fn().mockResolvedValue(undefined),
    onMessage(handler: MessageHandler) {
      handlers.push(handler)
    },
    _handlers: handlers,
  } as Channel & { _handlers: MessageHandler[] }
}

async function emitFromChannel(channel: Channel & { _handlers: MessageHandler[] }, message: InboundMessage) {
  for (const handler of channel._handlers) {
    await handler(message)
  }
}

function makeInboundMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: '1',
    channelId: 'telegram',
    chatId: '123',
    type: 'text',
    text: 'hello',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('ChannelRegistry', () => {
  let ChannelRegistryClass: any
  let registry: any

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../../src/services/channel-registry')
    ChannelRegistryClass = (mod as any).channelRegistry.constructor
    registry = new ChannelRegistryClass()
  })

  describe('register', () => {
    it('should register a channel', () => {
      const channel = createMockChannel('telegram')
      registry.register(channel)
      expect(registry.get('telegram')).toBe(channel)
    })

    it('should replace existing channel with same id', () => {
      const channel1 = createMockChannel('telegram', 'First')
      const channel2 = createMockChannel('telegram', 'Second')
      registry.register(channel1)
      registry.register(channel2)
      expect(registry.get('telegram')).toBe(channel2)
    })

    it('should wire channel onMessage to registry handlers', async () => {
      const channel = createMockChannel('telegram') as Channel & { _handlers: MessageHandler[] }
      const handler = vi.fn()
      registry.onMessage(handler)
      registry.register(channel)

      const msg = makeInboundMessage()
      await emitFromChannel(channel, msg)

      expect(handler).toHaveBeenCalledWith(msg)
    })
  })

  describe('unregister', () => {
    it('should unregister existing channel', () => {
      const channel = createMockChannel('telegram')
      registry.register(channel)
      expect(registry.unregister('telegram')).toBe(true)
      expect(registry.get('telegram')).toBeUndefined()
    })

    it('should return false for non-existent channel', () => {
      expect(registry.unregister('telegram')).toBe(false)
    })
  })

  describe('get / getAll / getAllIds', () => {
    it('should return undefined for non-existent channel', () => {
      expect(registry.get('telegram')).toBeUndefined()
    })

    it('should return all registered channels', () => {
      const ch1 = createMockChannel('telegram')
      const ch2 = createMockChannel('slack')
      registry.register(ch1)
      registry.register(ch2)
      expect(registry.getAll()).toHaveLength(2)
    })

    it('should return all registered ids', () => {
      registry.register(createMockChannel('telegram'))
      registry.register(createMockChannel('slack'))
      expect(registry.getAllIds()).toEqual(expect.arrayContaining(['telegram', 'slack']))
    })
  })

  describe('startAll / stopAll', () => {
    it('should start all channels', async () => {
      const ch1 = createMockChannel('telegram')
      const ch2 = createMockChannel('slack')
      registry.register(ch1)
      registry.register(ch2)
      await registry.startAll()
      expect(ch1.start).toHaveBeenCalled()
      expect(ch2.start).toHaveBeenCalled()
    })

    it('should stop all channels', async () => {
      const ch1 = createMockChannel('telegram')
      const ch2 = createMockChannel('slack')
      registry.register(ch1)
      registry.register(ch2)
      await registry.stopAll()
      expect(ch1.stop).toHaveBeenCalled()
      expect(ch2.stop).toHaveBeenCalled()
    })

    it('should not throw if a channel fails to start', async () => {
      const ch = createMockChannel('telegram')
      ;(ch.start as any).mockRejectedValue(new Error('start failed'))
      registry.register(ch)
      await expect(registry.startAll()).resolves.toBeUndefined()
    })

    it('should not throw if a channel fails to stop', async () => {
      const ch = createMockChannel('telegram')
      ;(ch.stop as any).mockRejectedValue(new Error('stop failed'))
      registry.register(ch)
      await expect(registry.stopAll()).resolves.toBeUndefined()
    })
  })

  describe('start / stop individual', () => {
    it('should start a specific channel', async () => {
      const ch = createMockChannel('telegram')
      registry.register(ch)
      await registry.start('telegram')
      expect(ch.start).toHaveBeenCalled()
    })

    it('should throw for non-existent channel on start', async () => {
      await expect(registry.start('telegram')).rejects.toThrow('Channel telegram not found')
    })

    it('should stop a specific channel', async () => {
      const ch = createMockChannel('telegram')
      registry.register(ch)
      await registry.stop('telegram')
      expect(ch.stop).toHaveBeenCalled()
    })

    it('should throw for non-existent channel on stop', async () => {
      await expect(registry.stop('telegram')).rejects.toThrow('Channel telegram not found')
    })
  })

  describe('getStatus / getAllStatuses', () => {
    it('should return status for channel', () => {
      const ch = createMockChannel('telegram')
      ;(ch.getStatus as any).mockReturnValue({ running: true, connectedAt: 12345 })
      registry.register(ch)
      expect(registry.getStatus('telegram')).toEqual({ running: true, connectedAt: 12345 })
    })

    it('should return undefined for non-existent channel', () => {
      expect(registry.getStatus('telegram')).toBeUndefined()
    })

    it('should return all statuses', () => {
      const ch1 = createMockChannel('telegram')
      const ch2 = createMockChannel('slack')
      ;(ch1.getStatus as any).mockReturnValue({ running: true })
      ;(ch2.getStatus as any).mockReturnValue({ running: false })
      registry.register(ch1)
      registry.register(ch2)
      const statuses = registry.getAllStatuses()
      expect(statuses.telegram).toEqual({ running: true })
      expect(statuses.slack).toEqual({ running: false })
    })
  })

  describe('send', () => {
    it('should route send to correct channel', async () => {
      const ch = createMockChannel('telegram')
      registry.register(ch)
      const msg: OutboundMessage = { text: 'hello' }
      await registry.send('telegram', '123', msg)
      expect(ch.send).toHaveBeenCalledWith('123', msg)
    })

    it('should throw for non-existent channel', async () => {
      await expect(registry.send('telegram', '123', { text: 'hi' }))
        .rejects.toThrow('Channel telegram not found')
    })
  })

  describe('onMessage / removeMessageHandler', () => {
    it('should add and invoke message handlers', async () => {
      const handler = vi.fn()
      registry.onMessage(handler)
      const channel = createMockChannel('telegram') as Channel & { _handlers: MessageHandler[] }
      registry.register(channel)

      const msg = makeInboundMessage()
      await emitFromChannel(channel, msg)
      expect(handler).toHaveBeenCalledWith(msg)
    })

    it('should invoke multiple handlers', async () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      registry.onMessage(handler1)
      registry.onMessage(handler2)
      const channel = createMockChannel('telegram') as Channel & { _handlers: MessageHandler[] }
      registry.register(channel)

      await emitFromChannel(channel, makeInboundMessage())
      expect(handler1).toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
    })

    it('should remove message handler', () => {
      const handler = vi.fn()
      registry.onMessage(handler)
      expect(registry.removeMessageHandler(handler)).toBe(true)
    })

    it('should return false when removing non-existent handler', () => {
      expect(registry.removeMessageHandler(vi.fn())).toBe(false)
    })

    it('should not invoke removed handler', async () => {
      const handler = vi.fn()
      registry.onMessage(handler)
      registry.removeMessageHandler(handler)
      const channel = createMockChannel('telegram') as Channel & { _handlers: MessageHandler[] }
      registry.register(channel)

      await emitFromChannel(channel, makeInboundMessage())
      expect(handler).not.toHaveBeenCalled()
    })

    it('should catch errors in handlers without breaking others', async () => {
      const badHandler = vi.fn().mockRejectedValue(new Error('handler error'))
      const goodHandler = vi.fn()
      registry.onMessage(badHandler)
      registry.onMessage(goodHandler)
      const channel = createMockChannel('telegram') as Channel & { _handlers: MessageHandler[] }
      registry.register(channel)

      await emitFromChannel(channel, makeInboundMessage())
      expect(badHandler).toHaveBeenCalled()
      expect(goodHandler).toHaveBeenCalled()
    })
  })
})
