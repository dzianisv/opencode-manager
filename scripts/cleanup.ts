#!/usr/bin/env bun
import { execSync } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const PORTS = {
  backend: [5001, 5002, 5003],
  frontend: [5173, 5174, 5175, 5176],
  opencode: [5551],
  whisper: [5552],
  chatterbox: [5553],
  coqui: [5554],
}

const ALL_PORTS = Object.values(PORTS).flat()

const TUNNEL_STATE_DIR = join(homedir(), '.local', 'run', 'opencode-manager')
const TUNNEL_STATE_FILE = join(TUNNEL_STATE_DIR, 'tunnel.json')
const TUNNEL_PID_FILE = join(TUNNEL_STATE_DIR, 'tunnel.pid')

interface ProcessInfo {
  pid: number
  port: number
  command: string
  service: string
}

interface TunnelState {
  pid: number
  url: string
  urlWithAuth: string | null
  port: number
  startedAt: number
}

function readTunnelState(): TunnelState | null {
  try {
    if (!existsSync(TUNNEL_STATE_FILE)) return null
    return JSON.parse(readFileSync(TUNNEL_STATE_FILE, 'utf8')) as TunnelState
  } catch {
    return null
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

function findOrphanedCloudflared(): ProcessInfo[] {
  const orphaned: ProcessInfo[] = []
  
  try {
    const output = execSync('pgrep -f "cloudflared tunnel"', { encoding: 'utf8' }).trim()
    if (!output) return orphaned
    
    const pids = output.split('\n').filter(Boolean).map(p => parseInt(p)).filter(p => !isNaN(p))
    const tunnelState = readTunnelState()
    const managedPid = tunnelState?.pid
    
    for (const pid of pids) {
      if (pid === managedPid && isProcessRunning(pid)) continue
      
      try {
        const cmd = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim()
        orphaned.push({ pid, port: 0, command: cmd, service: 'cloudflared' })
      } catch {}
    }
  } catch {}
  
  return orphaned
}

function cleanupStaleTunnelState(): void {
  const state = readTunnelState()
  if (!state) return
  
  if (!isProcessRunning(state.pid)) {
    console.log(`  Clearing stale tunnel state (PID ${state.pid} no longer running)`)
    try {
      if (existsSync(TUNNEL_STATE_FILE)) unlinkSync(TUNNEL_STATE_FILE)
      if (existsSync(TUNNEL_PID_FILE)) unlinkSync(TUNNEL_PID_FILE)
    } catch {}
  }
}

function findProcessesOnPorts(): ProcessInfo[] {
  const processes: ProcessInfo[] = []

  for (const port of ALL_PORTS) {
    try {
      const output = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim()
      if (!output) continue

      const pids = output.split('\n').filter(Boolean).map(p => parseInt(p))
      
      for (const pid of pids) {
        try {
          const cmdOutput = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim()
          const service = getServiceName(port)
          processes.push({ pid, port, command: cmdOutput, service })
        } catch {}
      }
    } catch {}
  }

  return processes
}

function getServiceName(port: number): string {
  for (const [service, ports] of Object.entries(PORTS)) {
    if (ports.includes(port)) return service
  }
  return 'unknown'
}

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
}

function printHelp() {
  console.log(`
opencode-manager cleanup

Kills orphaned processes on ports used by opencode-manager.
Also detects orphaned cloudflared tunnel processes not tracked by tunnel.json.

Usage: bun scripts/cleanup.ts [options]

Options:
  --dry-run, -n   Show what would be killed without actually killing
  --all, -a       Kill all processes on managed ports (and orphaned cloudflared)
  --port, -p      Kill processes on specific port(s), comma-separated
  --help, -h      Show this help message

Managed ports:
  Backend:     ${PORTS.backend.join(', ')}
  Frontend:    ${PORTS.frontend.join(', ')}
  OpenCode:    ${PORTS.opencode.join(', ')}
  Whisper:     ${PORTS.whisper.join(', ')}
  Chatterbox:  ${PORTS.chatterbox.join(', ')}
  Coqui:       ${PORTS.coqui.join(', ')}

Examples:
  bun scripts/cleanup.ts              # Interactive cleanup
  bun scripts/cleanup.ts --dry-run    # Show processes without killing
  bun scripts/cleanup.ts --all        # Kill all managed processes
  bun scripts/cleanup.ts -p 5552,5553 # Kill specific ports
`)
}

function parseArgs() {
  const args = process.argv.slice(2)
  return {
    dryRun: args.includes('--dry-run') || args.includes('-n'),
    all: args.includes('--all') || args.includes('-a'),
    help: args.includes('--help') || args.includes('-h'),
    ports: (() => {
      const idx = args.findIndex(a => a === '--port' || a === '-p')
      if (idx === -1 || !args[idx + 1]) return null
      return args[idx + 1].split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p))
    })(),
  }
}

async function main() {
  const args = parseArgs()

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  console.log('\n🧹 OpenCode Manager Cleanup\n')

  cleanupStaleTunnelState()

  const processes = findProcessesOnPorts()
  const orphanedCloudflared = findOrphanedCloudflared()
  const allProcesses = [...processes, ...orphanedCloudflared]

  if (allProcesses.length === 0) {
    console.log('✓ No processes found on managed ports. All clean!\n')
    process.exit(0)
  }

  const filtered = args.ports 
    ? allProcesses.filter(p => args.ports!.includes(p.port))
    : allProcesses

  if (filtered.length === 0) {
    console.log('✓ No processes found on specified ports.\n')
    process.exit(0)
  }

  console.log('Found processes:\n')
  for (const proc of filtered) {
    const portInfo = proc.port > 0 ? `Port ${proc.port} - ` : ''
    console.log(`  [${proc.service}] ${portInfo}PID ${proc.pid} (${proc.command})`)
  }
  console.log('')

  if (args.dryRun) {
    console.log('Dry run - no processes killed.\n')
    process.exit(0)
  }

  if (!args.all && !args.ports) {
    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    
    const answer = await new Promise<string>(resolve => {
      rl.question('Kill these processes? [y/N]: ', resolve)
    })
    rl.close()

    if (answer.toLowerCase() !== 'y') {
      console.log('\nAborted.\n')
      process.exit(0)
    }
  }

  console.log('\nKilling processes...\n')

  let killed = 0
  let failed = 0

  for (const proc of filtered) {
    const success = killProcess(proc.pid)
    if (success) {
      console.log(`  ✓ Killed PID ${proc.pid} (${proc.service}${proc.port > 0 ? ` on port ${proc.port}` : ''})`)
      killed++
    } else {
      console.log(`  ✗ Failed to kill PID ${proc.pid}`)
      failed++
    }
  }

  console.log(`\n${killed} killed, ${failed} failed.\n`)
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
