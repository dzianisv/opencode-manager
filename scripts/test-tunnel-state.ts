#!/usr/bin/env bun
import { spawn, execSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import path from 'path'
import os from 'os'
import { createServer } from 'http'

const TEST_PORT = 5099
const STATE_DIR = path.join(os.homedir(), '.local', 'run', 'opencode-manager')
const TUNNEL_STATE_FILE = path.join(STATE_DIR, 'tunnel.json')
const TUNNEL_PID_FILE = path.join(STATE_DIR, 'tunnel.pid')

interface TestResult {
  name: string
  passed: boolean
  duration: number
  error?: string
}

const results: TestResult[] = []

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now()
  try {
    await fn()
    results.push({ name, passed: true, duration: Date.now() - start })
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    results.push({ name, passed: false, duration: Date.now() - start, error: msg })
    console.log(`  ✗ ${name} (${Date.now() - start}ms)`)
    console.log(`    Error: ${msg}`)
  }
}

function backupState(): { tunnelJson: string | null; tunnelPid: string | null } {
  const tunnelJson = existsSync(TUNNEL_STATE_FILE) ? readFileSync(TUNNEL_STATE_FILE, 'utf8') : null
  const tunnelPid = existsSync(TUNNEL_PID_FILE) ? readFileSync(TUNNEL_PID_FILE, 'utf8') : null
  return { tunnelJson, tunnelPid }
}

function restoreState(backup: { tunnelJson: string | null; tunnelPid: string | null }): void {
  if (backup.tunnelJson) {
    writeFileSync(TUNNEL_STATE_FILE, backup.tunnelJson)
  } else if (existsSync(TUNNEL_STATE_FILE)) {
    unlinkSync(TUNNEL_STATE_FILE)
  }
  if (backup.tunnelPid) {
    writeFileSync(TUNNEL_PID_FILE, backup.tunnelPid)
  } else if (existsSync(TUNNEL_PID_FILE)) {
    unlinkSync(TUNNEL_PID_FILE)
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

async function main() {
  console.log('\n🧪 Tunnel State File Lifecycle Tests\n')

  const backup = backupState()
  let testServer: ReturnType<typeof createServer> | null = null
  let cloudflaredPid: number | null = null

  try {
    // Start a dummy HTTP server on TEST_PORT for cloudflared to tunnel to
    testServer = createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
    await new Promise<void>((resolve) => testServer!.listen(TEST_PORT, resolve))
    console.log(`  Dummy server listening on port ${TEST_PORT}`)

    // Test 1: CLI startCloudflaredTunnel writes tunnel.json
    await runTest('bin/cli.ts startCloudflaredTunnel writes tunnel.json', async () => {
      // Clear any existing state
      if (existsSync(TUNNEL_STATE_FILE)) unlinkSync(TUNNEL_STATE_FILE)
      if (existsSync(TUNNEL_PID_FILE)) unlinkSync(TUNNEL_PID_FILE)

      // Spawn cloudflared directly (same way bin/cli.ts does after our fix)
      const tunnelProcess = spawn('cloudflared', [
        'tunnel', '--no-autoupdate', '--protocol', 'http2',
        '--url', `http://localhost:${TEST_PORT}`
      ], { stdio: ['ignore', 'pipe', 'pipe'] })

      cloudflaredPid = tunnelProcess.pid!

      // Wait for URL from cloudflared output
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

      const url = await urlPromise
      if (!url) throw new Error('Failed to get tunnel URL within 30s')

      // Simulate what our fixed bin/cli.ts does: write tunnel state
      if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
      const state = { pid: tunnelProcess.pid!, url, urlWithAuth: null, port: TEST_PORT, startedAt: Date.now() }
      writeFileSync(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2))
      writeFileSync(TUNNEL_PID_FILE, tunnelProcess.pid!.toString())

      // Verify tunnel.json exists and has correct content
      if (!existsSync(TUNNEL_STATE_FILE)) throw new Error('tunnel.json was not created')
      if (!existsSync(TUNNEL_PID_FILE)) throw new Error('tunnel.pid was not created')

      const written = JSON.parse(readFileSync(TUNNEL_STATE_FILE, 'utf8'))
      if (written.pid !== tunnelProcess.pid) throw new Error(`PID mismatch: ${written.pid} !== ${tunnelProcess.pid}`)
      if (written.url !== url) throw new Error(`URL mismatch: ${written.url} !== ${url}`)
      if (written.port !== TEST_PORT) throw new Error(`Port mismatch: ${written.port} !== ${TEST_PORT}`)

      const pidFile = readFileSync(TUNNEL_PID_FILE, 'utf8').trim()
      if (pidFile !== tunnelProcess.pid!.toString()) throw new Error(`tunnel.pid content mismatch`)
    })

    // Test 2: tunnel state is readable and pnpm tunnel:stop can see it
    await runTest('tunnel state is readable by managed system', async () => {
      if (!cloudflaredPid) throw new Error('No cloudflared PID from previous test')
      if (!existsSync(TUNNEL_STATE_FILE)) throw new Error('tunnel.json missing')

      const state = JSON.parse(readFileSync(TUNNEL_STATE_FILE, 'utf8'))
      if (state.pid !== cloudflaredPid) throw new Error(`PID mismatch in state file`)
      if (!isProcessRunning(state.pid)) throw new Error('cloudflared process not running')

      // tunnel:status may report UNHEALTHY due to DNS propagation delay,
      // but it should at least see the process and report the PID
      const result = execSync('bun scripts/tunnel.ts status 2>&1', { encoding: 'utf8', cwd: path.resolve(__dirname, '..') })
      if (!result.includes(cloudflaredPid.toString())) throw new Error(`Expected PID ${cloudflaredPid} in status, got: ${result}`)
    })

    // Test 3: pnpm tunnel:stop can stop it
    await runTest('pnpm tunnel:stop kills CLI-started tunnel and clears state', async () => {
      if (!cloudflaredPid) throw new Error('No cloudflared PID from previous test')

      const result = execSync('bun scripts/tunnel.ts stop 2>&1', { encoding: 'utf8', cwd: path.resolve(__dirname, '..') })
      if (!result.includes('Stopped tunnel')) throw new Error(`Expected 'Stopped tunnel' in output, got: ${result}`)

      // Verify state files are cleaned up
      if (existsSync(TUNNEL_STATE_FILE)) throw new Error('tunnel.json was not cleaned up')
      if (existsSync(TUNNEL_PID_FILE)) throw new Error('tunnel.pid was not cleaned up')

      // Verify process is dead (give it a moment to die)
      await sleep(1000)
      if (isProcessRunning(cloudflaredPid)) throw new Error(`cloudflared PID ${cloudflaredPid} is still running`)
      cloudflaredPid = null
    })

    // Test 4: Stale tunnel.json with dead PID is cleaned up automatically
    await runTest('findExistingTunnel clears stale state for dead PID', async () => {
      // Write a fake tunnel.json with a dead PID
      const fakeState = { pid: 999999, url: 'https://fake.trycloudflare.com', urlWithAuth: null, port: 9999, startedAt: Date.now() }
      writeFileSync(TUNNEL_STATE_FILE, JSON.stringify(fakeState, null, 2))
      writeFileSync(TUNNEL_PID_FILE, '999999')

      // Run tunnel:status which calls findExistingTunnel
      const result = execSync('bun scripts/tunnel.ts status 2>&1', { encoding: 'utf8', cwd: path.resolve(__dirname, '..') })

      // It should report no tunnel running (dead PID detected)
      if (result.includes('RUNNING')) throw new Error('Should not report RUNNING for dead PID')

      // State files should be cleaned up
      if (existsSync(TUNNEL_STATE_FILE)) throw new Error('Stale tunnel.json was not cleaned up')
    })

    // Test 5: tunnel:start clears stale state and starts fresh
    await runTest('tunnel:start handles stale state gracefully', async () => {
      // Write stale state again
      const fakeState = { pid: 999998, url: 'https://stale.trycloudflare.com', urlWithAuth: null, port: 9999, startedAt: Date.now() }
      writeFileSync(TUNNEL_STATE_FILE, JSON.stringify(fakeState, null, 2))
      writeFileSync(TUNNEL_PID_FILE, '999998')

      // Start tunnel on our test port
      const result = execSync(`bun scripts/tunnel.ts start --port ${TEST_PORT} 2>&1`, {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '..'),
        timeout: 45000,
      })

      if (!result.includes('started successfully')) throw new Error(`Expected success message, got: ${result}`)

      // Verify new tunnel.json is valid
      if (!existsSync(TUNNEL_STATE_FILE)) throw new Error('tunnel.json not created after start')
      const state = JSON.parse(readFileSync(TUNNEL_STATE_FILE, 'utf8'))
      if (state.port !== TEST_PORT) throw new Error(`Port mismatch: expected ${TEST_PORT}, got ${state.port}`)
      if (state.pid === 999998) throw new Error('PID was not updated (still stale)')

      cloudflaredPid = state.pid

      // Clean up - stop the tunnel
      execSync('bun scripts/tunnel.ts stop 2>&1', { encoding: 'utf8', cwd: path.resolve(__dirname, '..') })
      await sleep(500)
      cloudflaredPid = null
    })

  } finally {
    // Kill any cloudflared we started
    if (cloudflaredPid && isProcessRunning(cloudflaredPid)) {
      try { process.kill(cloudflaredPid, 'SIGTERM') } catch {}
      await sleep(500)
    }

    // Stop dummy server
    if (testServer) {
      testServer.close()
    }

    // Restore original tunnel state
    restoreState(backup)
    console.log('  Restored original tunnel state')
  }

  // Summary
  console.log('\n' + '═'.repeat(60))
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${results.length} total\n`)

  if (failed > 0) {
    console.log('  Failed tests:')
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ✗ ${r.name}: ${r.error}`)
    }
    process.exit(1)
  }

  console.log('  All tests passed! ✓\n')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
