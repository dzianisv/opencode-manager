import type { Database } from 'bun:sqlite'
import { EventSource } from 'eventsource'
import * as db from '../db/queries'
import { opencodeServerManager } from './opencode-single-server'
import { sendSessionCompleteNotification, sendPermissionRequestNotification } from './push'
import { logger } from '../utils/logger'

// GlobalSSE connects to OpenCode's /event endpoint for push notifications.
// IMPORTANT: Only connects to directories that have active OpenCode sessions.
// This prevents log spam from failed connections to directories OpenCode doesn't serve.

interface SSEEvent {
  type: string
  properties: Record<string, unknown>
}

interface ConnectionState {
  eventSource: EventSource
  retryCount: number
  lastErrorLogTime: number
  consecutiveFailures: number
}

// Retry delays: 10s, 20s, 40s, 80s, 160s, then cap at 5 minutes
const MIN_RETRY_DELAY = 10000
const MAX_RETRY_DELAY = 300000
// Only log errors once every 5 minutes per directory to prevent log spam
const ERROR_LOG_INTERVAL = 300000
const SYNC_INTERVAL = 30000
// Stop retrying after 3 consecutive failures (will retry on next sync cycle)
const MAX_CONSECUTIVE_FAILURES = 3

let globalEventSources: Map<string, ConnectionState> = new Map()
let failedDirectories: Set<string> = new Set()
let database: Database | null = null
let isRunning = false
let syncInterval: NodeJS.Timeout | null = null

// Query OpenCode for directories that have active sessions
// Only these directories can receive SSE events
async function getActiveDirectoriesFromOpenCode(): Promise<Set<string>> {
  const directories = new Set<string>()
  
  try {
    const port = opencodeServerManager.getPort()
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      signal: AbortSignal.timeout(5000)
    })
    
    if (response.ok) {
      const sessions = await response.json() as Array<{ directory?: string }>
      for (const session of sessions) {
        if (session.directory) {
          // Skip temporary directories
          if (session.directory.startsWith('/tmp/') || session.directory.startsWith('/private/tmp/')) {
            continue
          }
          directories.add(session.directory)
        }
      }
    }
  } catch {
    // OpenCode not available - return empty set, will retry on next sync
  }
  
  return directories
}

async function getSessionTitle(directory: string, sessionId: string): Promise<string | undefined> {
  try {
    const port = opencodeServerManager.getPort()
    const response = await fetch(
      `http://127.0.0.1:${port}/session/${sessionId}?directory=${encodeURIComponent(directory)}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (response.ok) {
      const session = await response.json()
      return session.title
    }
  } catch {
    // Ignore errors for session title fetch - not critical
  }
  return undefined
}

function getRepoIdByDirectory(directory: string): number | undefined {
  if (!database) return undefined
  const repos = db.listRepos(database)
  const repo = repos.find((r) => r.fullPath === directory)
  return repo?.id
}

function handleSSEMessage(directory: string, event: SSEEvent): void {
  if (!database) return

  const { type, properties: props } = event

  if (type === 'session.idle' && 'sessionID' in props) {
    const sessionId = props.sessionID as string
    const repoId = getRepoIdByDirectory(directory)

    logger.info(`[GlobalSSE] Session idle: ${sessionId} in ${directory}`)

    getSessionTitle(directory, sessionId).then((title) => {
      sendSessionCompleteNotification(database!, sessionId, repoId?.toString(), title)
        .catch((err) => logger.warn('[GlobalSSE] Failed to send push notification:', err))
    })
  }

  if (type === 'permission.updated' && 'id' in props && 'sessionID' in props) {
    const sessionId = props.sessionID as string
    const toolName = (props.tool as string) || 'A tool'
    const repoId = getRepoIdByDirectory(directory)

    logger.info(`[GlobalSSE] Permission requested: ${toolName} for session ${sessionId}`)

    sendPermissionRequestNotification(database!, sessionId, toolName, repoId?.toString())
      .catch((err) => logger.warn('[GlobalSSE] Failed to send permission push notification:', err))
  }
}

function connectToDirectory(directory: string, retryCount: number = 0): void {
  if (globalEventSources.has(directory) || failedDirectories.has(directory)) {
    return
  }

  const port = opencodeServerManager.getPort()
  const url = `http://127.0.0.1:${port}/event?directory=${encodeURIComponent(directory)}`

  if (retryCount === 0) {
    logger.info(`[GlobalSSE] Connecting to ${directory}`)
  }

  const es = new EventSource(url)
  const state: ConnectionState = {
    eventSource: es,
    retryCount,
    lastErrorLogTime: 0,
    consecutiveFailures: 0
  }
  globalEventSources.set(directory, state)

  es.onopen = () => {
    logger.info(`[GlobalSSE] Connected to ${directory}`)
    state.retryCount = 0
    state.consecutiveFailures = 0
    failedDirectories.delete(directory)
  }

  es.onerror = () => {
    state.consecutiveFailures++
    
    // Throttle error logging to prevent log spam
    const now = Date.now()
    if (now - state.lastErrorLogTime > ERROR_LOG_INTERVAL) {
      logger.warn(`[GlobalSSE] Connection failed for ${directory} (attempt ${state.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`)
      state.lastErrorLogTime = now
    }
    
    globalEventSources.delete(directory)
    es.close()

    // Give up after too many consecutive failures
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.info(`[GlobalSSE] Giving up on ${directory} after ${MAX_CONSECUTIVE_FAILURES} failures (will retry on next sync)`)
      failedDirectories.add(directory)
      return
    }

    // Exponential backoff retry
    if (isRunning) {
      const delay = Math.min(MIN_RETRY_DELAY * Math.pow(2, state.retryCount), MAX_RETRY_DELAY)
      
      setTimeout(() => {
        if (isRunning && !globalEventSources.has(directory) && !failedDirectories.has(directory)) {
          connectToDirectory(directory, state.retryCount + 1)
        }
      }, delay)
    }
  }

  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as SSEEvent
      handleSSEMessage(directory, event)
    } catch (err) {
      logger.warn('[GlobalSSE] Failed to parse SSE event:', err)
    }
  }
}

function disconnectFromDirectory(directory: string): void {
  const state = globalEventSources.get(directory)
  if (state) {
    state.eventSource.close()
    globalEventSources.delete(directory)
    logger.debug(`[GlobalSSE] Disconnected from ${directory}`)
  }
}

// Sync connections to only directories that OpenCode knows about
async function syncConnections(): Promise<void> {
  if (!database || !isRunning) return

  const activeDirectories = await getActiveDirectoriesFromOpenCode()
  
  // If OpenCode isn't running or has no sessions, don't try to connect
  if (activeDirectories.size === 0) {
    return
  }

  // Reset failed directories on each sync to allow retry
  failedDirectories.clear()

  // Disconnect from directories that are no longer active
  for (const [dir] of globalEventSources) {
    if (!activeDirectories.has(dir)) {
      disconnectFromDirectory(dir)
    }
  }

  // Connect to new active directories
  for (const dir of activeDirectories) {
    if (!globalEventSources.has(dir)) {
      connectToDirectory(dir)
    }
  }
}

export function startGlobalSSEListener(db: Database): void {
  if (isRunning) return

  database = db
  isRunning = true

  logger.info('[GlobalSSE] Starting global SSE listener (connects only to active OpenCode directories)')

  syncConnections()

  syncInterval = setInterval(() => {
    if (isRunning) {
      syncConnections()
    }
  }, SYNC_INTERVAL)
}

export function stopGlobalSSEListener(): void {
  isRunning = false

  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }

  for (const [dir] of globalEventSources) {
    disconnectFromDirectory(dir)
  }

  globalEventSources.clear()
  failedDirectories.clear()

  logger.info('[GlobalSSE] Stopped global SSE listener')
}
