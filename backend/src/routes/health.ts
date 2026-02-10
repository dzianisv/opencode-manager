import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { opencodeServerManager } from '../services/opencode-single-server'
import { channelRegistry } from '../services/channel-registry'
import { messengerService } from '../services/messenger/service'

export function createHealthRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const dbCheck = db.prepare('SELECT 1').get()
      const opencodeHealthy = await opencodeServerManager.checkHealth()
      const startupError = opencodeServerManager.getLastStartupError()
      
      const telegramStatus = channelRegistry.getStatus('telegram') || { running: false }
      const sessions = messengerService.getAllSessions('telegram')
      const allowlist = messengerService.getAllowlist('telegram')

      const status = startupError && !opencodeHealthy
        ? 'unhealthy'
        : (dbCheck && opencodeHealthy ? 'healthy' : 'degraded')

      const response: Record<string, unknown> = {
        status,
        timestamp: new Date().toISOString(),
        database: dbCheck ? 'connected' : 'disconnected',
        opencode: opencodeHealthy ? 'healthy' : 'unhealthy',
        opencodePort: opencodeServerManager.getPort(),
        opencodeVersion: opencodeServerManager.getVersion(),
        opencodeMinVersion: opencodeServerManager.getMinVersion(),
        opencodeVersionSupported: opencodeServerManager.isVersionSupported(),
        telegram: {
          running: telegramStatus.running,
          sessions: sessions.length,
          allowlist: allowlist.length,
        },
      }

      if (startupError && !opencodeHealthy) {
        response.error = startupError
      }

      return c.json(response)
    } catch (error) {
      return c.json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 503)
    }
  })

  app.get('/processes', async (c) => {
    try {
      const opencodeHealthy = await opencodeServerManager.checkHealth()
      
      return c.json({
        opencode: {
          port: opencodeServerManager.getPort(),
          healthy: opencodeHealthy
        },
        timestamp: new Date().toISOString()
      })
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }, 500)
    }
  })

  return app
}
