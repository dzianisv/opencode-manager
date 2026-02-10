import type { Channel, ChannelId, ChannelStatus, MessageHandler, InboundMessage, OutboundMessage } from '@opencode-manager/shared'
import { logger } from '../utils/logger'

class ChannelRegistry {
  private channels: Map<ChannelId, Channel> = new Map()
  private messageHandlers: MessageHandler[] = []

  register(channel: Channel): void {
    if (this.channels.has(channel.id)) {
      logger.warn(`Channel ${channel.id} already registered, replacing`)
    }
    this.channels.set(channel.id, channel)
    
    channel.onMessage(async (message: InboundMessage) => {
      for (const handler of this.messageHandlers) {
        try {
          await handler(message)
        } catch (error) {
          logger.error(`Error in message handler for channel ${channel.id}:`, error)
        }
      }
    })
    
    logger.info(`Registered channel: ${channel.id} (${channel.name})`)
  }

  unregister(channelId: ChannelId): boolean {
    const channel = this.channels.get(channelId)
    if (channel) {
      this.channels.delete(channelId)
      logger.info(`Unregistered channel: ${channelId}`)
      return true
    }
    return false
  }

  get(channelId: ChannelId): Channel | undefined {
    return this.channels.get(channelId)
  }

  getAll(): Channel[] {
    return Array.from(this.channels.values())
  }

  getAllIds(): ChannelId[] {
    return Array.from(this.channels.keys())
  }

  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        try {
          await channel.start()
          logger.info(`Started channel: ${channel.id}`)
        } catch (error) {
          logger.error(`Failed to start channel ${channel.id}:`, error)
          throw error
        }
      })
    )
    
    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length > 0) {
      logger.warn(`${failed.length} channel(s) failed to start`)
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        try {
          await channel.stop()
          logger.info(`Stopped channel: ${channel.id}`)
        } catch (error) {
          logger.error(`Failed to stop channel ${channel.id}:`, error)
        }
      })
    )
  }

  async start(channelId: ChannelId): Promise<void> {
    const channel = this.channels.get(channelId)
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`)
    }
    await channel.start()
  }

  async stop(channelId: ChannelId): Promise<void> {
    const channel = this.channels.get(channelId)
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`)
    }
    await channel.stop()
  }

  getStatus(channelId: ChannelId): ChannelStatus | undefined {
    const channel = this.channels.get(channelId)
    return channel?.getStatus()
  }

  getAllStatuses(): Record<ChannelId, ChannelStatus> {
    const statuses: Record<string, ChannelStatus> = {}
    for (const [id, channel] of this.channels) {
      statuses[id] = channel.getStatus()
    }
    return statuses as Record<ChannelId, ChannelStatus>
  }

  async send(channelId: ChannelId, chatId: string, message: OutboundMessage): Promise<void> {
    const channel = this.channels.get(channelId)
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`)
    }
    await channel.send(chatId, message)
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler)
  }

  removeMessageHandler(handler: MessageHandler): boolean {
    const index = this.messageHandlers.indexOf(handler)
    if (index !== -1) {
      this.messageHandlers.splice(index, 1)
      return true
    }
    return false
  }
}

export const channelRegistry = new ChannelRegistry()
