import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

vi.mock('../../src/utils/logger', async () => {
  return {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  }
})

vi.mock('../../src/services/settings', () => ({
  SettingsService: vi.fn().mockImplementation(() => ({
    getSettings: vi.fn().mockReturnValue({
      preferences: {
        tts: {
          enabled: true,
          provider: 'coqui',
        }
      }
    })
  }))
}))

vi.mock('../../src/services/whisper', () => ({
  whisperServerManager: {
    getStatus: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
}))

vi.mock('../../src/services/coqui', () => ({
  coquiServerManager: {
    getStatus: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
}))

vi.mock('../../src/services/chatterbox', () => ({
  chatterboxServerManager: {
    getStatus: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
}))

vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: {
    checkHealth: vi.fn(),
    getPort: vi.fn(),
    getVersion: vi.fn(),
    getLastStartupError: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  }
}))

vi.mock('../../src/services/tunnel-service', () => ({
  tunnelService: {
    getStatus: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  }
}))

import { createServicesRoutes } from '../../src/routes/services'
import { whisperServerManager } from '../../src/services/whisper'
import { coquiServerManager } from '../../src/services/coqui'
import { opencodeServerManager } from '../../src/services/opencode-single-server'
import { tunnelService } from '../../src/services/tunnel-service'

describe('Services Routes', () => {
  let mockDb: any
  let servicesApp: ReturnType<typeof createServicesRoutes>

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {} as any;
    
    (whisperServerManager.getStatus as any).mockReturnValue({
      running: true,
      port: 5552,
      model: 'base',
      error: null
    });
    (whisperServerManager.start as any).mockResolvedValue(undefined);
    (whisperServerManager.stop as any).mockResolvedValue(undefined);
    
    (coquiServerManager.getStatus as any).mockReturnValue({
      running: true,
      port: 5553,
      model: 'jenny',
      device: 'cpu',
      error: null
    });
    (coquiServerManager.start as any).mockResolvedValue(undefined);
    (coquiServerManager.stop as any).mockResolvedValue(undefined);
    
    (opencodeServerManager.checkHealth as any).mockResolvedValue(true);
    (opencodeServerManager.getPort as any).mockReturnValue(5551);
    (opencodeServerManager.getVersion as any).mockReturnValue('1.0.0');
    (opencodeServerManager.getLastStartupError as any).mockReturnValue(null);
    (opencodeServerManager.start as any).mockResolvedValue(undefined);
    (opencodeServerManager.stop as any).mockResolvedValue(undefined);
    (opencodeServerManager.restart as any).mockResolvedValue(undefined);

    (tunnelService.getStatus as any).mockReturnValue({
      running: false,
      url: null,
      urlWithAuth: null,
      pid: null,
      haConnections: 0,
      startedAt: null,
      watchdog: { enabled: false, consecutiveFailures: 0, restartsInWindow: 0, halted: false },
      error: null,
    });
    (tunnelService.start as any).mockResolvedValue(undefined);
    (tunnelService.stop as any).mockResolvedValue(undefined);
    (tunnelService.restart as any).mockResolvedValue(undefined);
    
    servicesApp = createServicesRoutes(mockDb);
  })

  describe('GET /', () => {
    it('should return status of all services', async () => {
      const res = await servicesApp.request('/')
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.services).toHaveLength(4)
      expect(data.services.map((s: any) => s.name)).toEqual(['stt', 'tts', 'opencode', 'tunnel'])
    })
  })

  describe('GET /:service', () => {
    it('should return STT service status', async () => {
      const res = await servicesApp.request('/stt')
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.name).toBe('stt')
      expect(data.status).toBe('running')
      expect(data.details.port).toBe(5552)
    })

    it('should return TTS service status', async () => {
      const res = await servicesApp.request('/tts')
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.name).toBe('tts')
      expect(data.status).toBe('running')
      expect(data.details.provider).toBe('coqui')
    })

    it('should return OpenCode service status', async () => {
      const res = await servicesApp.request('/opencode')
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.name).toBe('opencode')
      expect(data.status).toBe('running')
      expect(data.details.port).toBe(5551)
    })

    it('should return tunnel service status', async () => {
      const res = await servicesApp.request('/tunnel')
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.name).toBe('tunnel')
      expect(data.status).toBe('stopped')
    })

    it('should return all services for /all', async () => {
      const res = await servicesApp.request('/all')
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.services).toHaveLength(4)
    })

    it('should return error for invalid service', async () => {
      const res = await servicesApp.request('/invalid')
      const data = await res.json()

      expect(res.status).toBe(400)
      expect(data.error).toBe('Invalid service name')
    })
  })

  describe('POST /:service/stop', () => {
    it('should stop STT service', async () => {
      const res = await servicesApp.request('/stt/stop', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(whisperServerManager.stop).toHaveBeenCalled()
    })

    it('should stop TTS service', async () => {
      const res = await servicesApp.request('/tts/stop', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(coquiServerManager.stop).toHaveBeenCalled()
    })

    it('should stop OpenCode service', async () => {
      const res = await servicesApp.request('/opencode/stop', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(opencodeServerManager.stop).toHaveBeenCalled()
    })

    it('should stop tunnel service', async () => {
      const res = await servicesApp.request('/tunnel/stop', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(tunnelService.stop).toHaveBeenCalled()
    })

    it('should stop all services', async () => {
      const res = await servicesApp.request('/all/stop', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(4)
    })
  })

  describe('POST /:service/start', () => {
    it('should start STT service', async () => {
      const res = await servicesApp.request('/stt/start', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(whisperServerManager.start).toHaveBeenCalled()
    })

    it('should start TTS service', async () => {
      const res = await servicesApp.request('/tts/start', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(coquiServerManager.start).toHaveBeenCalled()
    })

    it('should start OpenCode service', async () => {
      const res = await servicesApp.request('/opencode/start', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(opencodeServerManager.start).toHaveBeenCalled()
    })

    it('should start tunnel service', async () => {
      const res = await servicesApp.request('/tunnel/start', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(tunnelService.start).toHaveBeenCalled()
    })
  })

  describe('POST /:service/restart', () => {
    it('should restart STT service', async () => {
      const res = await servicesApp.request('/stt/restart', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(whisperServerManager.stop).toHaveBeenCalled()
      expect(whisperServerManager.start).toHaveBeenCalled()
    })

    it('should restart OpenCode service', async () => {
      const res = await servicesApp.request('/opencode/restart', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(opencodeServerManager.restart).toHaveBeenCalled()
    })

    it('should restart tunnel service', async () => {
      const res = await servicesApp.request('/tunnel/restart', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(tunnelService.restart).toHaveBeenCalled()
    })

    it('should restart all services', async () => {
      const res = await servicesApp.request('/all/restart', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(4)
    })
  })

  describe('Error handling', () => {
    it('should handle stop errors gracefully', async () => {
      (whisperServerManager.stop as any).mockRejectedValueOnce(new Error('Stop failed'));
      
      const res = await servicesApp.request('/stt/stop', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(500)
      expect(data.success).toBe(false)
      expect(data.error).toBe('Stop failed')
    })

    it('should handle start errors gracefully', async () => {
      (opencodeServerManager.start as any).mockRejectedValueOnce(new Error('Start failed'));
      
      const res = await servicesApp.request('/opencode/start', { method: 'POST' })
      const data = await res.json()

      expect(res.status).toBe(500)
      expect(data.success).toBe(false)
      expect(data.error).toBe('Start failed')
    })
  })
})
