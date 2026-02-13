import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import * as childProcess from 'child_process'
import * as fs from 'fs'

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

function createMockProcess() {
  const proc = new EventEmitter() as any
  proc.pid = 12345
  proc.killed = false
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      proc.killed = true
      setTimeout(() => proc.emit('exit', 0, signal), 10)
    }
  })
  return proc
}

function createSuccessFetchMock(tunnelUrl?: string) {
  return vi.fn().mockImplementation((url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (urlStr.includes('/metrics')) {
      return Promise.reject(new Error('no metrics server'))
    }
    if (tunnelUrl && urlStr.startsWith(tunnelUrl)) {
      return Promise.resolve({ ok: true, status: 200 })
    }
    return Promise.resolve({ ok: true, status: 200 })
  })
}

describe('TunnelService', () => {
  let TunnelService: typeof import('../../src/services/tunnel-service').TunnelService
  let service: InstanceType<typeof TunnelService>
  let spawnSpy: ReturnType<typeof vi.spyOn>
  let execSyncSpy: ReturnType<typeof vi.spyOn>
  let existsSyncSpy: ReturnType<typeof vi.spyOn>
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalFetch = global.fetch

    spawnSpy = vi.spyOn(childProcess, 'spawn').mockReturnValue(createMockProcess() as any)
    execSyncSpy = vi.spyOn(childProcess, 'execSync').mockImplementation(() => { throw new Error('no pgrep') })
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0 } as any)

    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any)
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'readFileSync').mockReturnValue('')
    vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 0 } as any)
    vi.spyOn(fs, 'createWriteStream').mockReturnValue({
      write: vi.fn(),
      end: vi.fn(),
    } as any)
    vi.spyOn(fs, 'renameSync').mockReturnValue(undefined)

    const mod = await import('../../src/services/tunnel-service')
    TunnelService = mod.TunnelService
    service = new TunnelService()
  })

  afterEach(async () => {
    try { await service.stop() } catch {}
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  async function startTunnel(port?: number, url = 'https://test.trycloudflare.com'): Promise<ReturnType<typeof createMockProcess>> {
    const mockProc = createMockProcess()
    spawnSpy.mockReturnValue(mockProc as any)
    global.fetch = createSuccessFetchMock(url)

    const startPromise = service.start(port)
    await new Promise(r => setTimeout(r, 50))
    mockProc.stderr.emit('data', Buffer.from(
      `INF Registered tunnel connection connIndex=0 url=${url}`
    ))
    await startPromise
    return mockProc
  }

  describe('initial state', () => {
    it('should not be running initially', () => {
      expect(service.isRunning()).toBe(false)
    })

    it('should return null URL initially', () => {
      expect(service.getUrl()).toBeNull()
    })

    it('should return null URL with auth initially', () => {
      expect(service.getUrlWithAuth()).toBeNull()
    })

    it('should return proper initial status', () => {
      const status = service.getStatus()
      expect(status.running).toBe(false)
      expect(status.url).toBeNull()
      expect(status.urlWithAuth).toBeNull()
      expect(status.pid).toBeNull()
      expect(status.haConnections).toBe(0)
      expect(status.startedAt).toBeNull()
      expect(status.watchdog.enabled).toBe(false)
      expect(status.watchdog.consecutiveFailures).toBe(0)
      expect(status.watchdog.restartsInWindow).toBe(0)
      expect(status.watchdog.halted).toBe(false)
      expect(status.error).toBeNull()
    })
  })

  describe('start()', () => {
    it('should spawn cloudflared with correct arguments', async () => {
      await startTunnel(5001, 'https://test-tunnel-abc.trycloudflare.com')

      expect(spawnSpy).toHaveBeenCalledWith(
        'cloudflared',
        ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://localhost:5001'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
    })

    it('should capture tunnel URL from stderr output', async () => {
      await startTunnel(5001, 'https://my-test-tunnel.trycloudflare.com')

      expect(service.getUrl()).toBe('https://my-test-tunnel.trycloudflare.com')
      expect(service.isRunning()).toBe(true)
    })

    it('should write tunnel state files after start', async () => {
      await startTunnel(5001, 'https://abc.trycloudflare.com')

      expect(writeFileSyncSpy).toHaveBeenCalled()
      const writeCalls = writeFileSyncSpy.mock.calls
      const tunnelStateWrite = writeCalls.find((c: any[]) => String(c[0]).includes('tunnel.json'))
      expect(tunnelStateWrite).toBeDefined()
      const state = JSON.parse(tunnelStateWrite![1] as string)
      expect(state.pid).toBe(12345)
      expect(state.url).toBe('https://abc.trycloudflare.com')
      expect(state.managedBy).toBe('backend')
    })

    it('should not start again if already running', async () => {
      await startTunnel(5001)

      spawnSpy.mockClear()
      await service.start()

      expect(spawnSpy).not.toHaveBeenCalled()
    })
  })

  describe('stop()', () => {
    it('should kill process and clear state', async () => {
      const mockProc = await startTunnel()

      expect(service.isRunning()).toBe(true)

      await service.stop()

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')
      expect(service.isRunning()).toBe(false)
      expect(service.getUrl()).toBeNull()
    })

    it('should be safe to call stop when not running', async () => {
      await expect(service.stop()).resolves.toBeUndefined()
    })
  })

  describe('getStatus()', () => {
    it('should reflect running state after start', async () => {
      await startTunnel(5001, 'https://status-test.trycloudflare.com')

      const status = service.getStatus()
      expect(status.running).toBe(true)
      expect(status.url).toBe('https://status-test.trycloudflare.com')
      expect(status.pid).toBe(12345)
      expect(status.startedAt).toBeGreaterThan(0)
      expect(status.watchdog.enabled).toBe(true)
      expect(status.error).toBeNull()
    })

    it('should reflect stopped state after stop', async () => {
      await startTunnel()

      await service.stop()

      const status = service.getStatus()
      expect(status.running).toBe(false)
      expect(status.url).toBeNull()
      expect(status.pid).toBeNull()
      expect(status.startedAt).toBeNull()
      expect(status.watchdog.enabled).toBe(false)
    })
  })

  describe('getDetailedStatus()', () => {
    it('should attempt to find metrics port', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('no metrics'))

      const status = await service.getDetailedStatus()
      expect(status.metricsPort).toBeNull()
      expect(status.running).toBe(false)
    })

    it('should parse HA connections from metrics', async () => {
      const tunnelUrl = 'https://metrics-test.trycloudflare.com'
      const mockProc = createMockProcess()
      spawnSpy.mockReturnValue(mockProc as any)

      global.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        if (urlStr.includes('/metrics')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(
              '# HELP cloudflared_tunnel_ha_connections\n' +
              'cloudflared_tunnel_ha_connections 4\n'
            ),
          })
        }
        if (urlStr.startsWith(tunnelUrl)) {
          return Promise.resolve({ ok: true, status: 200 })
        }
        return Promise.resolve({ ok: true, status: 200 })
      })

      const startPromise = service.start()
      await new Promise(r => setTimeout(r, 50))
      mockProc.stderr.emit('data', Buffer.from(
        `INF Registered tunnel connection connIndex=0 url=${tunnelUrl}`
      ))
      await startPromise

      const status = await service.getDetailedStatus()
      expect(status.haConnections).toBe(4)
    })
  })

  describe('state file management', () => {
    it('should update endpoints.json on start', async () => {
      await startTunnel(5001, 'https://endpoints-test.trycloudflare.com')

      const writeCalls = writeFileSyncSpy.mock.calls
      const endpointsWrite = writeCalls.find((c: any[]) => String(c[0]).includes('endpoints.json'))
      expect(endpointsWrite).toBeDefined()
      const endpoints = JSON.parse(endpointsWrite![1] as string)
      expect(endpoints.endpoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'local', url: 'http://localhost:5001' }),
          expect.objectContaining({ type: 'tunnel', url: 'https://endpoints-test.trycloudflare.com' }),
        ])
      )
    })

    it('should write PID file on start', async () => {
      await startTunnel(5001, 'https://pid-test.trycloudflare.com')

      const writeCalls = writeFileSyncSpy.mock.calls
      const pidWrite = writeCalls.find((c: any[]) => String(c[0]).includes('tunnel.pid'))
      expect(pidWrite).toBeDefined()
      expect(pidWrite![1]).toBe('12345')
    })
  })

  describe('process error handling', () => {
    it('should handle process exit during operation', async () => {
      const mockProc = await startTunnel(5001, 'https://exit-test.trycloudflare.com')

      expect(service.isRunning()).toBe(true)

      mockProc.killed = true
      mockProc.emit('exit', 1, null)

      await new Promise(r => setTimeout(r, 50))
      expect(service.isRunning()).toBe(false)
    })
  })
})
