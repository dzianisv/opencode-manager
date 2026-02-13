#!/usr/bin/env bun

import { spawn } from 'child_process'

interface LocalConfig {
  backendPort: number
  frontendPort: number
  opencodePort: number
  whisperPort: number
  coquiPort: number
  chatterboxPort: number
  host: string
  username: string
  password: string
  headless: boolean
  skipBrowser: boolean
  skipSettings: boolean
}

const DEFAULTS: LocalConfig = {
  backendPort: 5101,
  frontendPort: 5173,
  opencodePort: 5561,
  whisperPort: 5562,
  coquiPort: 5564,
  chatterboxPort: 5563,
  host: '0.0.0.0',
  username: process.env.OPENCODE_USER || '',
  password: process.env.OPENCODE_PASS || '',
  headless: false,
  skipBrowser: false,
  skipSettings: false,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHealth(url: string, user?: string, pass?: string, timeoutMs = 120000): Promise<boolean> {
  const start = Date.now()
  const headers: Record<string, string> = {}

  if (user && pass) {
    headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  }

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`, { headers })
      const data = await response.json()
      if (data.status === 'healthy') {
        return true
      }
    } catch {
      // Ignore until ready
    }
    await sleep(2000)
  }

  return false
}

function runProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawn(command, args, {
    stdio: 'inherit',
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
  })
}

async function main() {
  const args = process.argv.slice(2)
  const config: LocalConfig = { ...DEFAULTS }

  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1]
    if (args[i] === '--backend-port' && value) config.backendPort = parseInt(value, 10)
    else if (args[i] === '--frontend-port' && value) config.frontendPort = parseInt(value, 10)
    else if (args[i] === '--opencode-port' && value) config.opencodePort = parseInt(value, 10)
    else if (args[i] === '--whisper-port' && value) config.whisperPort = parseInt(value, 10)
    else if (args[i] === '--coqui-port' && value) config.coquiPort = parseInt(value, 10)
    else if (args[i] === '--chatterbox-port' && value) config.chatterboxPort = parseInt(value, 10)
    else if (args[i] === '--host' && value) config.host = value
    else if (args[i] === '--user' && value) config.username = value
    else if (args[i] === '--pass' && value) config.password = value
    else if (args[i] === '--headless') config.headless = true
    else if (args[i] === '--skip-browser') config.skipBrowser = true
    else if (args[i] === '--skip-settings') config.skipSettings = true
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Local UI E2E Runner (no Docker)

Usage: bun run scripts/run-local-ui-e2e.ts [options]

Options:
  --backend-port <port>     Backend port (default: 5101)
  --frontend-port <port>    Frontend port (default: 5173)
  --opencode-port <port>    OpenCode port (default: 5561)
  --whisper-port <port>     Whisper port (default: 5562)
  --coqui-port <port>       Coqui port (default: 5564)
  --chatterbox-port <port>  Chatterbox port (default: 5563)
  --host <host>             Backend host (default: 0.0.0.0)
  --user <username>         Basic auth username
  --pass <password>         Basic auth password
  --headless                Run tests headless
  --skip-browser            Skip browser E2E test
  --skip-settings           Skip settings E2E test
  --help, -h                Show help
`)
      process.exit(0)
    }
  }

  const baseUrl = `http://localhost:${config.backendPort}`
  const backendEnv = {
    ...process.env,
    HOST: config.host,
    PORT: String(config.backendPort),
    OPENCODE_SERVER_PORT: String(config.opencodePort),
    WHISPER_PORT: String(config.whisperPort),
    COQUI_PORT: String(config.coquiPort),
    CHATTERBOX_PORT: String(config.chatterboxPort),
    NODE_ENV: 'development',
  }

  if (config.username && config.password) {
    backendEnv.AUTH_USERNAME = config.username
    backendEnv.AUTH_PASSWORD = config.password
  }

  const frontendEnv = {
    ...process.env,
    VITE_API_URL: baseUrl,
    VITE_SERVER_PORT: String(config.backendPort),
  }

  console.log('\nStarting backend...')
  const backend = runProcess('bun', ['backend/src/index.ts'], { env: backendEnv })
  console.log('Starting frontend...')
  const frontend = runProcess('pnpm', ['dev', '--', '--port', String(config.frontendPort), '--host', config.host], {
    cwd: 'frontend',
    env: frontendEnv,
  })

  const cleanup = () => {
    backend.kill('SIGINT')
    frontend.kill('SIGINT')
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  console.log(`\nWaiting for backend health at ${baseUrl}...`)
  const healthy = await waitForHealth(baseUrl, config.username, config.password)
  if (!healthy) {
    console.error('Backend did not become healthy in time')
    cleanup()
    process.exit(1)
  }

  const testArgs = ['--url', baseUrl]
  if (config.username) testArgs.push('--user', config.username)
  if (config.password) testArgs.push('--pass', config.password)
  if (config.headless) testArgs.push('--headless')

  let failed = false

  if (!config.skipSettings) {
    const settings = runProcess('bun', ['run', 'scripts/test-settings.ts', ...testArgs])
    const code = await new Promise<number>((resolve) => settings.on('close', (c) => resolve(c || 0)))
    if (code !== 0) failed = true
  }

  if (!config.skipBrowser) {
    const browser = runProcess('bun', ['run', 'scripts/test-browser.ts', ...testArgs])
    const code = await new Promise<number>((resolve) => browser.on('close', (c) => resolve(c || 0)))
    if (code !== 0) failed = true
  }

  cleanup()
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
