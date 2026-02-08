#!/usr/bin/env bun
import { spawn, execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import os from 'os'

const TUNNEL_STATE_DIR = path.join(os.homedir(), '.local', 'run', 'opencode-manager')
const TUNNEL_STATE_FILE = path.join(TUNNEL_STATE_DIR, 'tunnel.json')
const TUNNEL_PID_FILE = path.join(TUNNEL_STATE_DIR, 'tunnel.pid')
const ENDPOINTS_FILE = path.join(TUNNEL_STATE_DIR, 'endpoints.json')

interface TunnelState {
  pid: number
  url: string
  urlWithAuth: string | null
  port: number
  startedAt: number
}

interface EndpointsFile {
  endpoints: Array<{
    type: 'local' | 'tunnel'
    url: string
    timestamp: string
  }>
}

interface AuthConfig {
  username: string
  password: string
}

const AUTH_FILE = path.join(TUNNEL_STATE_DIR, 'auth.json')

function readAuthConfig(): AuthConfig | null {
  try {
    if (!existsSync(AUTH_FILE)) return null
    const data = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
    if (data.username && data.password) {
      return data as AuthConfig
    }
    return null
  } catch {
    return null
  }
}

function buildUrlWithAuth(baseUrl: string, auth: AuthConfig | null): string | null {
  if (!auth) return null
  try {
    const url = new URL(baseUrl)
    url.username = auth.username
    url.password = auth.password
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function parseArgs(): { action: 'start' | 'stop' | 'status' | 'url' | 'health'; port: number } {
  const args = process.argv.slice(2)
  const action = (args[0] || 'status') as 'start' | 'stop' | 'status' | 'url' | 'health'
  const portArg = args.find((_, i, arr) => arr[i - 1] === '--port' || arr[i - 1] === '-p')
  const port = parseInt(portArg || '5001')
  return { action, port }
}

function ensureStateDir(): void {
  if (!existsSync(TUNNEL_STATE_DIR)) {
    mkdirSync(TUNNEL_STATE_DIR, { recursive: true })
  }
}

function readTunnelState(): TunnelState | null {
  try {
    if (!existsSync(TUNNEL_STATE_FILE)) return null
    const data = JSON.parse(readFileSync(TUNNEL_STATE_FILE, 'utf8'))
    return data as TunnelState
  } catch {
    return null
  }
}

function writeTunnelState(state: TunnelState): void {
  ensureStateDir()
  writeFileSync(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2))
  writeFileSync(TUNNEL_PID_FILE, state.pid.toString())
}

function clearTunnelState(): void {
  try {
    if (existsSync(TUNNEL_STATE_FILE)) {
      const fs = require('fs')
      fs.unlinkSync(TUNNEL_STATE_FILE)
    }
    if (existsSync(TUNNEL_PID_FILE)) {
      const fs = require('fs')
      fs.unlinkSync(TUNNEL_PID_FILE)
    }
  } catch {}
}

function updateEndpointsFile(tunnelUrl: string | null, port: number): void {
  ensureStateDir()
  const timestamp = new Date().toISOString()
  const endpoints: EndpointsFile = {
    endpoints: [
      {
        type: 'local',
        url: `http://localhost:${port}`,
        timestamp,
      },
    ],
  }
  if (tunnelUrl) {
    endpoints.endpoints.push({
      type: 'tunnel',
      url: tunnelUrl,
      timestamp,
    })
  }
  writeFileSync(ENDPOINTS_FILE, JSON.stringify(endpoints, null, 2))
}

async function checkTunnelHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return response.status !== 502 && response.status !== 503 && response.status !== 504
  } catch (err: unknown) {
    const error = err as Error
    if (error.cause && typeof error.cause === 'object' && 'code' in error.cause) {
      const cause = error.cause as { code: string }
      if (cause.code === 'ENOTFOUND') {
        return false
      }
    }
    return false
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function findExistingTunnel(verifyHealth: boolean = false): Promise<TunnelState | null> {
  const state = readTunnelState()
  if (!state) return null
  
  if (!isProcessRunning(state.pid)) {
    clearTunnelState()
    return null
  }

  if (verifyHealth) {
    const isHealthy = await checkTunnelHealth(state.url)
    if (!isHealthy) {
      console.log(`Tunnel URL ${state.url} is not reachable`)
      return null
    }
  }
  
  return state
}

async function startTunnel(port: number): Promise<TunnelState | null> {
  const existing = await findExistingTunnel(true)
  if (existing) {
    if (existing.port === port) {
      console.log(`Tunnel already running on port ${port}`)
      console.log(`URL: ${existing.url}`)
      console.log(`PID: ${existing.pid}`)
      return existing
    } else {
      console.log(`Stopping existing tunnel on port ${existing.port}...`)
      stopTunnel()
    }
  } else {
    const staleState = readTunnelState()
    if (staleState && isProcessRunning(staleState.pid)) {
      console.log(`Killing stale tunnel process (PID ${staleState.pid}) with unreachable URL...`)
      try {
        process.kill(staleState.pid, 'SIGTERM')
      } catch {}
      clearTunnelState()
    }
  }

  console.log(`Starting Cloudflare tunnel for port ${port}...`)
  
  const tunnelProcess = spawn('cloudflared', [
    'tunnel', 
    '--no-autoupdate', 
    '--protocol', 'http2', 
    '--url', `http://localhost:${port}`
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  tunnelProcess.unref()

  let tunnelUrl: string | null = null

  const urlPromise = new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 30000)

    const handleOutput = (data: Buffer) => {
      const output = data.toString()
      const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (urlMatch && !tunnelUrl) {
        tunnelUrl = urlMatch[0]
        clearTimeout(timeout)
        resolve(tunnelUrl)
      }
    }

    tunnelProcess.stdout?.on('data', handleOutput)
    tunnelProcess.stderr?.on('data', handleOutput)
  })

  tunnelProcess.on('error', (err) => {
    console.error('Failed to start cloudflared:', err.message)
    console.log('Install cloudflared: brew install cloudflared')
  })

  const url = await urlPromise

  if (!url) {
    console.error('Failed to get tunnel URL within timeout')
    try {
      tunnelProcess.kill('SIGTERM')
    } catch {}
    return null
  }

  const auth = readAuthConfig()
  const urlWithAuth = buildUrlWithAuth(url, auth)

  const state: TunnelState = {
    pid: tunnelProcess.pid!,
    url,
    urlWithAuth,
    port,
    startedAt: Date.now(),
  }

  writeTunnelState(state)
  updateEndpointsFile(urlWithAuth || url, port)

  console.log(`\nTunnel started successfully!`)
  console.log(`URL: ${url}`)
  if (urlWithAuth) {
    console.log(`URL (with auth): ${urlWithAuth}`)
  }
  console.log(`PID: ${state.pid}`)
  console.log(`\nThe tunnel will persist until stopped with: bun scripts/tunnel.ts stop`)

  return state
}

function stopTunnel(): boolean {
  const state = readTunnelState()
  
  if (!state) {
    console.log('No tunnel is running')
    return false
  }

  if (!isProcessRunning(state.pid)) {
    console.log('Tunnel process is not running (stale state)')
    clearTunnelState()
    return false
  }

  try {
    process.kill(state.pid, 'SIGTERM')
    console.log(`Stopped tunnel (PID ${state.pid})`)
    clearTunnelState()
    return true
  } catch (err) {
    console.error('Failed to stop tunnel:', err)
    return false
  }
}

async function showStatus(): Promise<void> {
  const state = await findExistingTunnel(true)
  
  if (!state) {
    const staleState = readTunnelState()
    if (staleState && isProcessRunning(staleState.pid)) {
      console.log('Tunnel Status: UNHEALTHY (process running but URL unreachable)')
      console.log(`URL: ${staleState.url}`)
      console.log(`PID: ${staleState.pid}`)
      console.log('\nRun "bun scripts/tunnel.ts start" to restart the tunnel')
    } else {
      console.log('No tunnel is running')
    }
    return
  }

  const uptime = Math.floor((Date.now() - state.startedAt) / 1000)
  const hours = Math.floor(uptime / 3600)
  const minutes = Math.floor((uptime % 3600) / 60)
  const seconds = uptime % 60

  console.log('Tunnel Status: RUNNING')
  console.log(`URL: ${state.url}`)
  if (state.urlWithAuth) {
    console.log(`URL (with auth): ${state.urlWithAuth}`)
  }
  console.log(`Port: ${state.port}`)
  console.log(`PID: ${state.pid}`)
  console.log(`Uptime: ${hours}h ${minutes}m ${seconds}s`)
}

async function showUrl(): Promise<void> {
  const state = await findExistingTunnel()
  
  if (!state) {
    process.exit(1)
  }

  console.log(state.url)
}

async function checkHealth(): Promise<void> {
  const state = readTunnelState()
  
  if (!state) {
    console.log('No tunnel state found')
    process.exit(1)
  }

  if (!isProcessRunning(state.pid)) {
    console.log('Tunnel process is not running')
    process.exit(1)
  }

  console.log(`Checking tunnel health: ${state.url}`)
  const isHealthy = await checkTunnelHealth(state.url)
  
  if (isHealthy) {
    console.log('Tunnel is healthy')
    process.exit(0)
  } else {
    console.log('Tunnel URL is unreachable')
    process.exit(1)
  }
}

async function main() {
  const { action, port } = parseArgs()

  switch (action) {
    case 'start':
      await startTunnel(port)
      break
    case 'stop':
      stopTunnel()
      break
    case 'status':
      await showStatus()
      break
    case 'url':
      await showUrl()
      break
    case 'health':
      await checkHealth()
      break
    default:
      console.log('Usage: bun scripts/tunnel.ts [start|stop|status|url|health] [--port PORT]')
      console.log('')
      console.log('Commands:')
      console.log('  start   Start a persistent Cloudflare tunnel')
      console.log('  stop    Stop the running tunnel')
      console.log('  status  Show tunnel status (with health check)')
      console.log('  url     Print just the tunnel URL (for scripts)')
      console.log('  health  Check if tunnel URL is reachable')
      console.log('')
      console.log('Options:')
      console.log('  --port, -p  Local port to tunnel (default: 5001)')
  }
}

main().catch(console.error)
