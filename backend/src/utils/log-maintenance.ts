import fs from 'fs'
import path from 'path'
import os from 'os'
import { logger } from './logger'

const CONFIG_DIR = path.join(os.homedir(), '.local', 'run', 'opencode-manager')
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024 // 10MB per log file
const MAX_LOG_BACKUPS = 2
const CHECK_INTERVAL_MS = 5 * 60 * 1000 // Check every 5 minutes

const LOG_FILES = ['stdout.log', 'stderr.log', 'cloudflared.log']

let maintenanceInterval: NodeJS.Timeout | null = null

function truncateLogFile(logPath: string): void {
  try {
    if (!fs.existsSync(logPath)) return

    const stats = fs.statSync(logPath)
    if (stats.size < MAX_LOG_SIZE_BYTES) return

    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1)
    logger.info(`Rotating oversized log (${sizeMB}MB): ${path.basename(logPath)}`)

    const oldestBackup = `${logPath}.${MAX_LOG_BACKUPS}`
    if (fs.existsSync(oldestBackup)) {
      fs.unlinkSync(oldestBackup)
    }

    for (let i = MAX_LOG_BACKUPS - 1; i >= 1; i--) {
      const current = `${logPath}.${i}`
      const next = `${logPath}.${i + 1}`
      if (fs.existsSync(current)) {
        fs.renameSync(current, next)
      }
    }

    fs.renameSync(logPath, `${logPath}.1`)
    fs.writeFileSync(logPath, '', { flag: 'w' })

  } catch (err) {
    logger.warn(`Failed to rotate log file ${logPath}:`, err)
  }
}

function runLogMaintenance(): void {
  for (const logFile of LOG_FILES) {
    const logPath = path.join(CONFIG_DIR, logFile)
    truncateLogFile(logPath)
  }
}

export function startLogMaintenance(): void {
  if (maintenanceInterval) return

  runLogMaintenance()

  maintenanceInterval = setInterval(runLogMaintenance, CHECK_INTERVAL_MS)
  logger.info('Log maintenance started (checks every 5 minutes)')
}

export function stopLogMaintenance(): void {
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval)
    maintenanceInterval = null
    logger.info('Log maintenance stopped')
  }
}
