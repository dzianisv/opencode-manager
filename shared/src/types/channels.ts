import { z } from 'zod'

export const ChannelIdSchema = z.enum(['telegram', 'whatsapp', 'slack', 'discord', 'signal', 'webchat'])
export type ChannelId = z.infer<typeof ChannelIdSchema>

export const ChatTypeSchema = z.enum(['direct', 'group', 'channel', 'thread'])
export type ChatType = z.infer<typeof ChatTypeSchema>

export const ChannelCapabilitiesSchema = z.object({
  chatTypes: z.array(ChatTypeSchema),
  media: z.boolean(),
  voice: z.boolean(),
  reactions: z.boolean(),
  threads: z.boolean(),
  maxMessageLength: z.number().optional(),
})
export type ChannelCapabilities = z.infer<typeof ChannelCapabilitiesSchema>

export const ChannelStatusSchema = z.object({
  running: z.boolean(),
  error: z.string().optional(),
  connectedAt: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>

export const InboundMessageTypeSchema = z.enum(['text', 'voice', 'image', 'file', 'location'])
export type InboundMessageType = z.infer<typeof InboundMessageTypeSchema>

const BufferType = typeof Buffer !== 'undefined' ? z.instanceof(Buffer) : z.any()

export const InboundMessageSchema = z.object({
  id: z.string(),
  channelId: ChannelIdSchema,
  chatId: z.string(),
  senderId: z.string().optional(),
  senderName: z.string().optional(),
  type: InboundMessageTypeSchema,
  text: z.string().optional(),
  mediaUrl: z.string().optional(),
  mediaBuffer: BufferType.optional(),
  mimeType: z.string().optional(),
  replyToId: z.string().optional(),
  timestamp: z.number(),
  raw: z.unknown().optional(),
})
export type InboundMessage = z.infer<typeof InboundMessageSchema>

export const OutboundMessageSchema = z.object({
  text: z.string().optional(),
  mediaUrl: z.string().optional(),
  mediaBuffer: BufferType.optional(),
  mimeType: z.string().optional(),
  replyToId: z.string().optional(),
})
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>

export type MessageHandler = (message: InboundMessage) => Promise<void>

export interface Channel {
  readonly id: ChannelId
  readonly name: string
  readonly capabilities: ChannelCapabilities

  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): ChannelStatus
  send(chatId: string, message: OutboundMessage): Promise<void>
  onMessage(handler: MessageHandler): void
}

export const PairingRequestSchema = z.object({
  id: z.number(),
  channelId: ChannelIdSchema,
  chatId: z.string(),
  senderName: z.string().optional(),
  code: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
})
export type PairingRequest = z.infer<typeof PairingRequestSchema>

export const ChannelAllowlistEntrySchema = z.object({
  id: z.number(),
  channelId: ChannelIdSchema,
  chatId: z.string(),
  senderName: z.string().optional(),
  addedAt: z.number(),
  addedVia: z.enum(['pairing', 'manual', 'env']).optional(),
})
export type ChannelAllowlistEntry = z.infer<typeof ChannelAllowlistEntrySchema>

export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_CODE_TTL_MS = 60 * 60 * 1000
export const MAX_PENDING_PAIRING_REQUESTS = 3

export function generatePairingCode(): string {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[Math.floor(Math.random() * PAIRING_CODE_ALPHABET.length)]
  }
  return code
}
