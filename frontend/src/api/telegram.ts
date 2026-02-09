import axios from 'axios'
import { API_BASE_URL } from '@/config'

export interface TelegramStatus {
  running: boolean
  botInfo?: {
    id: number
    first_name: string
    username: string
    can_join_groups: boolean
    can_read_all_group_messages: boolean
    supports_inline_queries: boolean
  }
}

export interface TelegramSession {
  chatId: string
  messages: number
  lastActivity: number
}

export const telegramApi = {
  getStatus: async (): Promise<TelegramStatus> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/telegram/status`)
    return data
  },

  startBot: async (token: string): Promise<{ success: boolean; status: TelegramStatus }> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/telegram/start`, { token })
    return data
  },

  stopBot: async (): Promise<{ success: boolean }> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/telegram/stop`)
    return data
  },

  getSessions: async (): Promise<TelegramSession[]> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/telegram/sessions`)
    return data
  },

  deleteSession: async (chatId: string): Promise<{ success: boolean }> => {
    const { data } = await axios.delete(`${API_BASE_URL}/api/telegram/sessions/${chatId}`)
    return data
  },

  getAllowlist: async (): Promise<string[]> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/telegram/allowlist`)
    return data
  },

  addToAllowlist: async (chatId: string): Promise<{ success: boolean }> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/telegram/allowlist`, { chatId })
    return data
  },

  removeFromAllowlist: async (chatId: string): Promise<{ success: boolean }> => {
    const { data } = await axios.delete(`${API_BASE_URL}/api/telegram/allowlist/${chatId}`)
    return data
  }
}
