import * as childProcess from 'child_process'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import path from 'path'
import os from 'os'
import { logger } from '../utils/logger'

const CONFIG_DIR = path.join(os.homedir(), '.local', 'run', 'opencode-manager')
const TUNNEL_STATE_FILE = path.join(CONFIG_DIR, 'tunnel.json')
const TUNNEL_PID_FILE = path.join(CONFIG_DIR, 'tunnel.pid')
const CLOUDFLARED_LOG_FILE = path.join(CONFIG_DIR, 'cloudflared.log')
const ENDPOINTS_FILE = path.join(CONFIG_DIR, 'endpoints.json')
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json')

const METRICS_PORTS = [20241, 20242, 20243, 20244, 20245]
const WATCHDOG_INTERVAL_MS = 30_000
const WATCHDOG_JITTER_MS = 5_000
const WATCHDOG_FAIL_THRESHOLD = 3
const MAX_RESTARTS = 5
const MAX_RESTART_WINDOW_MS = 10 * 60 * 1000
const COOLDOWN_BASE_MS = 5 * 60 * 1000
const COOLDOWN_MAX_MS = 30 * 60 * 1000
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024
const MAX_LOG_BACKUPS = 2
const URL_CAPTURE_TIMEOUT_MS = 30_000
const PROCESS_KILL_TIMEOUT_MS = 5_000

const FATAL_ERROR_PATTERNS = [
  /unauthorized/i,
  /tunnel not found/i,
  /failed to connect to an ideally located cfd server/i,
  /connection refused/i,
  /failed to unmarshal tunnel credentials/i,
  /invalid tunnel credentials/i,
  /err_tunnel_id/i,
]

interface TunnelStatus {
  running: boolean
  url: string | null
  urlWithAuth: string | null
  pid: number | null
  metricsPort: number | null
  haConnections: number
  startedAt: number | null
  watchdog: {
    enabled: boolean
    consecutiveFailures: number
    restartsInWindow: number
    halted: boolean
    cooldownUntil: number | null
    cooldownCount: number
    fatalError: string | null
  }
  error: string | null
}

interface AuthConfig {
  username: string
  password: string
}

class TunnelService {
  private process: ChildProcess | null = null
  private logStream: fs.WriteStream | null = null
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private localPort: number = 5001
  private url: string | null = null
  private urlWithAuth: string | null = null
  private startedAt: number | null = null
  private error: string | null = null
  private startPromise: Promise<void> | null = null

  private watchdogState = {
    consecutiveFailures: 0,
    restarting: false,
    restartTimestamps: [] as number[],
    halted: false,
    cooldownUntil: null as number | null,
    cooldownCount: 0,
    fatalError: null as string | null,
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed
  }

  getUrl(): string | null {
    return this.url
  }

  getUrlWithAuth(): string | null {
    return this.urlWithAuth
  }

  getStatus(): TunnelStatus {
    return {
      running: this.isRunning(),
      url: this.url,
      urlWithAuth: this.urlWithAuth,
      pid: this.process?.pid ?? null,
      metricsPort: null,
      haConnections: 0,
      startedAt: this.startedAt,
      watchdog: {
        enabled: this.watchdogTimer !== null,
        consecutiveFailures: this.watchdogState.consecutiveFailures,
        restartsInWindow: this.watchdogState.restartTimestamps.length,
        halted: this.watchdogState.halted,
        cooldownUntil: this.watchdogState.cooldownUntil,
        cooldownCount: this.watchdogState.cooldownCount,
        fatalError: this.watchdogState.fatalError,
      },
      error: this.error,
    }
  }

  async getDetailedStatus(): Promise<TunnelStatus> {
    const status = this.getStatus()
    const metricsPort = await this.findMetricsPort()
    status.metricsPort = metricsPort

    if (metricsPort) {
      try {
        const response = await fetch(`http://localhost:${metricsPort}/metrics`, {
          signal: AbortSignal.timeout(2000),
        })
        if (response.ok) {
          const text = await response.text()
          for (const line of text.split('\n')) {
            if (line.startsWith('cloudflared_tunnel_ha_connections ')) {
              status.haConnections = parseInt(line.split(' ')[1], 10) || 0
            }
          }
        }
      } catch {}
    }

    return status
  }

  async start(port?: number): Promise<void> {
    if (this.startPromise) {
      return this.startPromise
    }

    if (this.isRunning()) {
      logger.info('Tunnel already running')
      return
    }

    if (port) {
      this.localPort = port
    }

    this.startPromise = this.doStart()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async stop(): Promise<void> {
    this.stopWatchdog()

    if (!this.process) {
      this.clearState()
      return
    }

    logger.info('Stopping tunnel...')

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('Tunnel did not exit gracefully, killing...')
        this.process?.kill('SIGKILL')
        setTimeout(() => {
          this.process = null
          this.url = null
          this.urlWithAuth = null
          this.startedAt = null
          this.closeLogStream()
          this.clearState()
          resolve()
        }, 500)
      }, PROCESS_KILL_TIMEOUT_MS)

      this.process!.once('exit', () => {
        clearTimeout(timeout)
        this.process = null
        this.url = null
        this.urlWithAuth = null
        this.startedAt = null
        this.closeLogStream()
        this.clearState()
        logger.info('Tunnel stopped')
        resolve()
      })

      this.process!.kill('SIGTERM')
    })
  }

  async restart(): Promise<void> {
    await this.stop()
    await new Promise(r => setTimeout(r, 1000))
    await this.start()
  }

  private async doStart(): Promise<void> {
    this.ensureConfigDir()
    this.cleanupStaleState()
    this.rotateLogFile()
    this.error = null

    this.logStream = fs.createWriteStream(CLOUDFLARED_LOG_FILE, { flags: 'a' })
    const ts = () => new Date().toISOString()

    this.logStream.write(`\n${'='.repeat(80)}\n`)
    this.logStream.write(`[${ts()}] Cloudflare tunnel starting (backend-managed)...\n`)
    this.logStream.write(`[${ts()}] Target: http://localhost:${this.localPort}\n`)
    this.logStream.write(`${'='.repeat(80)}\n\n`)

    logger.info(`Starting Cloudflare tunnel for port ${this.localPort}`)

    this.process = childProcess.spawn(
      'cloudflared',
      ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${this.localPort}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    let capturedUrl: string | null = null

    const urlPromise = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), URL_CAPTURE_TIMEOUT_MS)

      const handleOutput = (data: Buffer) => {
        const output = data.toString()
        const lines = output.split('\n').filter(line => line.trim())
        for (const line of lines) {
          this.logStream?.write(`[${ts()}] ${line}\n`)
        }

        for (const pattern of FATAL_ERROR_PATTERNS) {
          if (pattern.test(output)) {
            const fatalMsg = `Fatal cloudflared error: ${output.trim().slice(0, 200)}`
            logger.error(fatalMsg)
            this.watchdogState.fatalError = fatalMsg
            this.watchdogState.halted = true
            this.error = fatalMsg
            break
          }
        }

        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (urlMatch && !capturedUrl) {
          capturedUrl = urlMatch[0]
          clearTimeout(timeout)
          resolve(capturedUrl)
        }
      }

      this.process!.stdout?.on('data', handleOutput)
      this.process!.stderr?.on('data', handleOutput)
    })

    this.process.on('error', (err) => {
      this.logStream?.write(`[${ts()}] ERROR: Failed to start cloudflared: ${err.message}\n`)
      logger.error('Failed to start cloudflared:', err.message)
      this.error = err.message
    })

    this.process.on('exit', (code, signal) => {
      this.logStream?.write(`[${ts()}] Process exited with code ${code}, signal ${signal}\n`)
      logger.info(`Cloudflared exited with code ${code}, signal ${signal}`)
      this.closeLogStream()
      this.process = null
      this.clearState()
    })

    this.url = await urlPromise

    if (!this.url) {
      this.error = 'Failed to obtain tunnel URL within timeout'
      logger.error(this.error)
      this.logStream?.write(`[${ts()}] WARNING: ${this.error}\n`)
      return
    }

    const auth = this.getAuth()
    this.urlWithAuth = null
    if (auth?.username && auth?.password) {
      try {
        const parsed = new URL(this.url)
        parsed.username = auth.username
        parsed.password = auth.password
        this.urlWithAuth = parsed.toString().replace(/\/$/, '')
      } catch {}
    }

    this.startedAt = Date.now()
    this.writeTunnelState()

    logger.info(`Tunnel established: ${this.url}`)
    this.logStream?.write(`[${ts()}] Tunnel established: ${this.url}\n`)

    const reachable = await this.verifyReachable()
    if (reachable) {
      this.updateEndpoints()
    } else {
      logger.warn('Tunnel URL obtained but not reachable — skipping endpoints.json update')
      this.logStream?.write(`[${ts()}] WARNING: Tunnel URL not reachable, endpoints.json not updated\n`)
    }

    this.startWatchdog()
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return

    this.watchdogState = {
      consecutiveFailures: 0,
      restarting: false,
      restartTimestamps: [],
      halted: false,
      cooldownUntil: null,
      cooldownCount: 0,
      fatalError: null,
    }

    logger.info('Starting tunnel watchdog')
    this.scheduleWatchdogTick()
  }

  private scheduleWatchdogTick(): void {
    const jitter = Math.floor(Math.random() * WATCHDOG_JITTER_MS)
    this.watchdogTimer = setTimeout(() => this.watchdogTick(), WATCHDOG_INTERVAL_MS + jitter)
  }

  private async watchdogTick(): Promise<void> {
    if (this.watchdogState.restarting) {
      this.scheduleWatchdogTick()
      return
    }

    if (this.watchdogState.fatalError) {
      this.scheduleWatchdogTick()
      return
    }

    if (this.watchdogState.cooldownUntil) {
      const remaining = this.watchdogState.cooldownUntil - Date.now()
      if (remaining > 0) {
        this.scheduleWatchdogTick()
        return
      }
      logger.info('Watchdog cooldown expired, resuming monitoring')
      this.watchdogState.cooldownUntil = null
      this.watchdogState.halted = false
      this.watchdogState.restartTimestamps = []
      this.watchdogState.consecutiveFailures = 0
      this.error = null
    }

    if (!this.process || this.process.killed) {
      logger.warn('Tunnel process is dead, attempting restart')
      this.watchdogState.consecutiveFailures = WATCHDOG_FAIL_THRESHOLD
    } else {
      const connected = await this.checkConnected()
      if (connected) {
        if (this.watchdogState.consecutiveFailures > 0) {
          logger.info(`Tunnel recovered after ${this.watchdogState.consecutiveFailures} failed check(s)`)
        }
        this.watchdogState.consecutiveFailures = 0
        if (this.watchdogState.cooldownCount > 0) {
          this.watchdogState.cooldownCount = 0
        }
        this.scheduleWatchdogTick()
        return
      }
      this.watchdogState.consecutiveFailures++
      logger.warn(`Tunnel disconnected (${this.watchdogState.consecutiveFailures}/${WATCHDOG_FAIL_THRESHOLD})`)
    }

    if (this.watchdogState.consecutiveFailures < WATCHDOG_FAIL_THRESHOLD) {
      this.scheduleWatchdogTick()
      return
    }

    const stillDisconnected = !this.process || this.process.killed || !(await this.checkConnected())
    if (!stillDisconnected) {
      logger.info('Tunnel reconnected before restart — skipping')
      this.watchdogState.consecutiveFailures = 0
      this.scheduleWatchdogTick()
      return
    }

    if (this.isCircuitBroken()) {
      this.watchdogState.cooldownCount++
      const cooldownMs = Math.min(
        COOLDOWN_BASE_MS * Math.pow(2, this.watchdogState.cooldownCount - 1),
        COOLDOWN_MAX_MS
      )
      this.watchdogState.cooldownUntil = Date.now() + cooldownMs
      this.watchdogState.halted = true
      this.error = `Watchdog cooling down: ${MAX_RESTARTS} restarts in ${MAX_RESTART_WINDOW_MS / 60000} min. Resuming in ${Math.round(cooldownMs / 60000)} min`
      logger.warn(this.error)
      this.scheduleWatchdogTick()
      return
    }

    this.watchdogState.restarting = true
    this.watchdogState.consecutiveFailures = 0
    this.watchdogState.restartTimestamps.push(Date.now())
    logger.info('Watchdog restarting tunnel...')

    try {
      await this.doRestart()
      if (this.url) {
        logger.info(`Watchdog restored tunnel: ${this.url}`)
      } else {
        logger.warn('Watchdog restarted tunnel but no URL obtained')
      }
    } catch (err) {
      logger.error('Watchdog failed to restart tunnel:', err instanceof Error ? err.message : err)
      this.error = `Watchdog restart failed: ${err instanceof Error ? err.message : 'unknown'}`
    } finally {
      this.watchdogState.restarting = false
    }

    this.scheduleWatchdogTick()
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
      logger.info('Tunnel watchdog stopped')
    }
  }

  private async doRestart(): Promise<void> {
    if (this.process) {
      try { this.process.kill('SIGTERM') } catch {}
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try { this.process?.kill('SIGKILL') } catch {}
          resolve()
        }, PROCESS_KILL_TIMEOUT_MS)

        if (this.process) {
          this.process.once('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })
      this.process = null
    }

    this.closeLogStream()
    await new Promise(r => setTimeout(r, 1000))
    await this.doStart()
  }

  private isCircuitBroken(): boolean {
    const now = Date.now()
    this.watchdogState.restartTimestamps = this.watchdogState.restartTimestamps.filter(
      t => now - t < MAX_RESTART_WINDOW_MS
    )
    return this.watchdogState.restartTimestamps.length >= MAX_RESTARTS
  }

  private async findMetricsPort(): Promise<number | null> {
    for (const port of METRICS_PORTS) {
      try {
        const response = await fetch(`http://localhost:${port}/metrics`, {
          signal: AbortSignal.timeout(500),
        })
        if (response.ok) return port
      } catch {
        continue
      }
    }
    return null
  }

  private async checkConnected(): Promise<boolean> {
    const port = await this.findMetricsPort()
    if (!port) return false
    try {
      const response = await fetch(`http://localhost:${port}/metrics`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!response.ok) return false
      const text = await response.text()
      for (const line of text.split('\n')) {
        if (line.startsWith('cloudflared_tunnel_ha_connections ')) {
          return parseInt(line.split(' ')[1], 10) > 0
        }
      }
      return false
    } catch {
      return false
    }
  }

  private async verifyReachable(): Promise<boolean> {
    if (!this.url) return false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(this.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        })
        if (response.status !== 502 && response.status !== 503 && response.status !== 504) {
          return true
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000))
    }
    return false
  }

  private getAuth(): AuthConfig | null {
    const username = process.env.AUTH_USERNAME
    const password = process.env.AUTH_PASSWORD
    if (username && password) {
      return { username, password }
    }

    try {
      if (fs.existsSync(AUTH_FILE)) {
        const content = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'))
        if (content.username && content.password) {
          return content as AuthConfig
        }
      }
    } catch {}
    return null
  }

  private ensureConfigDir(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    }
  }

  private writeTunnelState(): void {
    if (!this.process?.pid || !this.url) return
    this.ensureConfigDir()
    const state = {
      pid: this.process.pid,
      url: this.url,
      urlWithAuth: this.urlWithAuth,
      port: this.localPort,
      startedAt: this.startedAt,
      managedBy: 'backend',
    }
    fs.writeFileSync(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2))
    fs.writeFileSync(TUNNEL_PID_FILE, this.process.pid.toString())
  }

  private clearState(): void {
    try {
      if (fs.existsSync(TUNNEL_STATE_FILE)) fs.unlinkSync(TUNNEL_STATE_FILE)
      if (fs.existsSync(TUNNEL_PID_FILE)) fs.unlinkSync(TUNNEL_PID_FILE)
    } catch {}
  }

  private updateEndpoints(): void {
    this.ensureConfigDir()
    const localUrl = `http://localhost:${this.localPort}`

    let config: { endpoints: Array<{ type: string; url: string; timestamp: string }> } = { endpoints: [] }
    try {
      if (fs.existsSync(ENDPOINTS_FILE)) {
        config = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, 'utf-8'))
      }
    } catch {}

    const timestamp = new Date().toISOString()

    config.endpoints = config.endpoints.filter(e => e.url !== localUrl)
    config.endpoints.push({ type: 'local', url: localUrl, timestamp })

    const tunnelEndpointUrl = this.urlWithAuth || this.url
    if (tunnelEndpointUrl) {
      config.endpoints = config.endpoints.filter(e => e.type !== 'tunnel' || e.url === tunnelEndpointUrl)
      config.endpoints.push({ type: 'tunnel', url: tunnelEndpointUrl, timestamp })
    }

    fs.writeFileSync(ENDPOINTS_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
  }

  private cleanupStaleState(): void {
    try {
      if (fs.existsSync(TUNNEL_STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(TUNNEL_STATE_FILE, 'utf-8'))
        if (state.pid) {
          if (this.isProcessRunning(state.pid)) {
            logger.info(`Stopping previous tunnel (PID ${state.pid})...`)
            try { process.kill(state.pid, 'SIGTERM') } catch {}
            if (!this.waitForProcessDeath(state.pid, 3000)) {
              logger.info(`Force killing previous tunnel (PID ${state.pid})...`)
              try { process.kill(state.pid, 'SIGKILL') } catch {}
              this.waitForProcessDeath(state.pid, 1000)
            }
          }
        }
        this.clearState()
      }
    } catch {
      this.clearState()
    }

    this.killAllCloudflared()
  }

  private killAllCloudflared(): void {
    try {
      const output = childProcess.execSync('pgrep -f "cloudflared tunnel"', { encoding: 'utf8' }).trim()
      if (!output) return
      const pids = output.split('\n').filter(Boolean).map(p => parseInt(p)).filter(p => !isNaN(p))
      for (const pid of pids) {
        try {
          logger.info(`Killing orphaned cloudflared (PID ${pid})`)
          process.kill(pid, 'SIGTERM')
        } catch {}
      }
      const deadline = Date.now() + 3000
      for (const pid of pids) {
        const remaining = Math.max(0, deadline - Date.now())
        if (remaining > 0 && !this.waitForProcessDeath(pid, remaining)) {
          try {
            logger.info(`Force killing cloudflared (PID ${pid})`)
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      }
    } catch {}
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private waitForProcessDeath(pid: number, maxMs: number): boolean {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if (!this.isProcessRunning(pid)) return true
      childProcess.spawnSync('sleep', ['0.1'])
    }
    return !this.isProcessRunning(pid)
  }

  private rotateLogFile(): void {
    try {
      if (!fs.existsSync(CLOUDFLARED_LOG_FILE)) return
      const stats = fs.statSync(CLOUDFLARED_LOG_FILE)
      if (stats.size < MAX_LOG_SIZE_BYTES) return

      logger.info(`Rotating cloudflared log (${Math.round(stats.size / 1024)}KB)`)

      const oldest = `${CLOUDFLARED_LOG_FILE}.${MAX_LOG_BACKUPS}`
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest)

      for (let i = MAX_LOG_BACKUPS - 1; i >= 1; i--) {
        const current = `${CLOUDFLARED_LOG_FILE}.${i}`
        const next = `${CLOUDFLARED_LOG_FILE}.${i + 1}`
        if (fs.existsSync(current)) fs.renameSync(current, next)
      }

      fs.renameSync(CLOUDFLARED_LOG_FILE, `${CLOUDFLARED_LOG_FILE}.1`)
    } catch (err) {
      logger.warn('Failed to rotate cloudflared log:', err)
    }
  }

  private closeLogStream(): void {
    if (this.logStream) {
      try { this.logStream.end() } catch {}
      this.logStream = null
    }
  }
}

export { TunnelService }

export const tunnelService = new TunnelService()
