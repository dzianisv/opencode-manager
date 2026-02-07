import { Hono } from 'hono'
import { z } from 'zod'
import { whisperServerManager } from '../services/whisper'
import { coquiServerManager } from '../services/coqui'
import { chatterboxServerManager } from '../services/chatterbox'
import { opencodeServerManager } from '../services/opencode-single-server'
import { SettingsService } from '../services/settings'
import { logger } from '../utils/logger'
import type { Database } from 'bun:sqlite'

type ServiceName = 'stt' | 'tts' | 'opencode'

const ServiceParamSchema = z.object({
  service: z.enum(['stt', 'tts', 'opencode', 'all'])
})

interface ServiceStatus {
  name: string
  status: 'running' | 'stopped' | 'not_configured' | 'unknown'
  error?: string
  details?: Record<string, unknown>
}

async function getServiceStatus(service: ServiceName, db: Database): Promise<ServiceStatus> {
  switch (service) {
    case 'stt': {
      const status = whisperServerManager.getStatus()
      return {
        name: 'stt',
        status: status.running ? 'running' : 'stopped',
        error: status.error || undefined,
        details: {
          port: status.port,
          model: status.model
        }
      }
    }
    case 'tts': {
      const settingsService = new SettingsService(db)
      const settings = settingsService.getSettings('default')
      const provider = settings.preferences.tts?.provider || 'external'
      
      if (provider === 'coqui') {
        const coquiStatus = coquiServerManager.getStatus()
        return {
          name: 'tts',
          status: coquiStatus.running ? 'running' : 'stopped',
          error: coquiStatus.error || undefined,
          details: {
            provider: 'coqui',
            port: coquiStatus.port,
            model: coquiStatus.model,
            device: coquiStatus.device
          }
        }
      }
      
      if (provider === 'chatterbox') {
        const chatterboxStatus = chatterboxServerManager.getStatus()
        return {
          name: 'tts',
          status: chatterboxStatus.running ? 'running' : 'stopped',
          error: chatterboxStatus.error || undefined,
          details: {
            provider: 'chatterbox',
            port: chatterboxStatus.port,
            device: chatterboxStatus.device
          }
        }
      }
      
      return {
        name: 'tts',
        status: settings.preferences.tts?.enabled ? 'running' : 'not_configured',
        details: { provider }
      }
    }
    case 'opencode': {
      const healthy = await opencodeServerManager.checkHealth()
      return {
        name: 'opencode',
        status: healthy ? 'running' : 'stopped',
        error: opencodeServerManager.getLastStartupError() || undefined,
        details: {
          port: opencodeServerManager.getPort(),
          version: opencodeServerManager.getVersion()
        }
      }
    }
    default:
      return { name: service, status: 'unknown' }
  }
}

async function startService(service: ServiceName, db: Database): Promise<{ success: boolean; error?: string }> {
  try {
    switch (service) {
      case 'stt':
        await whisperServerManager.start()
        return { success: true }
      case 'tts': {
        const settingsService = new SettingsService(db)
        const settings = settingsService.getSettings('default')
        const provider = settings.preferences.tts?.provider || 'external'
        
        if (provider === 'coqui') {
          await coquiServerManager.start()
          return { success: true }
        }
        
        if (provider === 'chatterbox') {
          await chatterboxServerManager.start()
          return { success: true }
        }
        
        return { success: false, error: `TTS provider '${provider}' does not require a local server` }
      }
      case 'opencode':
        await opencodeServerManager.start()
        return { success: true }
      default:
        return { success: false, error: `Unknown service: ${service}` }
    }
  } catch (error) {
    logger.error(`Failed to start service ${service}:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function stopService(service: ServiceName, db: Database): Promise<{ success: boolean; error?: string }> {
  try {
    switch (service) {
      case 'stt':
        await whisperServerManager.stop()
        return { success: true }
      case 'tts': {
        const settingsService = new SettingsService(db)
        const settings = settingsService.getSettings('default')
        const provider = settings.preferences.tts?.provider || 'external'
        
        if (provider === 'coqui') {
          await coquiServerManager.stop()
          return { success: true }
        }
        
        if (provider === 'chatterbox') {
          await chatterboxServerManager.stop()
          return { success: true }
        }
        
        return { success: false, error: `TTS provider '${provider}' does not have a local server to stop` }
      }
      case 'opencode':
        await opencodeServerManager.stop()
        return { success: true }
      default:
        return { success: false, error: `Unknown service: ${service}` }
    }
  } catch (error) {
    logger.error(`Failed to stop service ${service}:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function restartService(service: ServiceName, db: Database): Promise<{ success: boolean; error?: string }> {
  try {
    switch (service) {
      case 'stt':
        await whisperServerManager.stop()
        await new Promise(r => setTimeout(r, 1000))
        await whisperServerManager.start()
        return { success: true }
      case 'tts': {
        const settingsService = new SettingsService(db)
        const settings = settingsService.getSettings('default')
        const provider = settings.preferences.tts?.provider || 'external'
        
        if (provider === 'coqui') {
          await coquiServerManager.stop()
          await new Promise(r => setTimeout(r, 1000))
          await coquiServerManager.start()
          return { success: true }
        }
        
        if (provider === 'chatterbox') {
          await chatterboxServerManager.stop()
          await new Promise(r => setTimeout(r, 1000))
          await chatterboxServerManager.start()
          return { success: true }
        }
        
        return { success: false, error: `TTS provider '${provider}' does not have a local server to restart` }
      }
      case 'opencode':
        await opencodeServerManager.restart()
        return { success: true }
      default:
        return { success: false, error: `Unknown service: ${service}` }
    }
  } catch (error) {
    logger.error(`Failed to restart service ${service}:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function createServicesRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    const services: ServiceName[] = ['stt', 'tts', 'opencode']
    const statuses = await Promise.all(services.map(s => getServiceStatus(s, db)))
    return c.json({ services: statuses })
  })

  app.get('/:service', async (c) => {
    const service = c.req.param('service')
    const validation = ServiceParamSchema.safeParse({ service })
    
    if (!validation.success) {
      return c.json({ error: 'Invalid service name', valid: ['stt', 'tts', 'opencode', 'all'] }, 400)
    }
    
    if (service === 'all') {
      const services: ServiceName[] = ['stt', 'tts', 'opencode']
      const statuses = await Promise.all(services.map(s => getServiceStatus(s, db)))
      return c.json({ services: statuses })
    }
    
    const status = await getServiceStatus(service as ServiceName, db)
    return c.json(status)
  })

  app.post('/:service/start', async (c) => {
    const service = c.req.param('service')
    const validation = ServiceParamSchema.safeParse({ service })
    
    if (!validation.success) {
      return c.json({ error: 'Invalid service name', valid: ['stt', 'tts', 'opencode', 'all'] }, 400)
    }
    
    if (service === 'all') {
      const services: ServiceName[] = ['stt', 'tts', 'opencode']
      const results = await Promise.all(services.map(async s => ({
        service: s,
        ...await startService(s, db)
      })))
      const allSuccess = results.every(r => r.success)
      return c.json({ success: allSuccess, results })
    }
    
    const result = await startService(service as ServiceName, db)
    return c.json(result, result.success ? 200 : 500)
  })

  app.post('/:service/stop', async (c) => {
    const service = c.req.param('service')
    const validation = ServiceParamSchema.safeParse({ service })
    
    if (!validation.success) {
      return c.json({ error: 'Invalid service name', valid: ['stt', 'tts', 'opencode', 'all'] }, 400)
    }
    
    if (service === 'all') {
      const services: ServiceName[] = ['stt', 'tts', 'opencode']
      const results = await Promise.all(services.map(async s => ({
        service: s,
        ...await stopService(s, db)
      })))
      const allSuccess = results.every(r => r.success)
      return c.json({ success: allSuccess, results })
    }
    
    const result = await stopService(service as ServiceName, db)
    return c.json(result, result.success ? 200 : 500)
  })

  app.post('/:service/restart', async (c) => {
    const service = c.req.param('service')
    const validation = ServiceParamSchema.safeParse({ service })
    
    if (!validation.success) {
      return c.json({ error: 'Invalid service name', valid: ['stt', 'tts', 'opencode', 'all'] }, 400)
    }
    
    if (service === 'all') {
      const services: ServiceName[] = ['stt', 'tts', 'opencode']
      const results = await Promise.all(services.map(async s => ({
        service: s,
        ...await restartService(s, db)
      })))
      const allSuccess = results.every(r => r.success)
      return c.json({ success: allSuccess, results })
    }
    
    const result = await restartService(service as ServiceName, db)
    return c.json(result, result.success ? 200 : 500)
  })

  return app
}
