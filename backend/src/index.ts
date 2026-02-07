import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { basicAuth } from 'hono/basic-auth'
import { serveStatic } from '@hono/node-server/serve-static'
import os from 'os'
import path from 'path'
import { initializeDatabase } from './db/schema'
import { createRepoRoutes } from './routes/repos'
import { createIPCServer, type IPCServer } from './ipc/ipcServer'
import { GitAuthService } from './services/git-auth'
import { createSettingsRoutes } from './routes/settings'
import { createHealthRoutes } from './routes/health'
import { createTTSRoutes, cleanupExpiredCache } from './routes/tts'
import { createSTTRoutes } from './routes/stt'
import { createFileRoutes } from './routes/files'
import { createProvidersRoutes } from './routes/providers'
import { createOAuthRoutes } from './routes/oauth'
import { createTitleRoutes } from './routes/title'
import { createSSERoutes } from './routes/sse'
import { createNotificationRoutes } from './routes/notifications'
import { createAuthRoutes, createAuthInfoRoutes, syncAdminFromEnv } from './routes/auth'
import { createAuth } from './auth'
import { createAuthMiddleware } from './auth/middleware'
import { sseAggregator } from './services/sse-aggregator'
import { ensureDirectoryExists, writeFileContent, fileExists, readFileContent } from './services/file-operations'
import { SettingsService } from './services/settings'
import { opencodeServerManager } from './services/opencode-single-server'
import { cleanupOrphanedDirectories, cleanupStaleRepoEntries, registerExternalDirectory, syncProjectsFromOpenCode } from './services/repo'
import { proxyRequest } from './services/proxy'
import { NotificationService } from './services/notification'
import { whisperServerManager } from './services/whisper'
import { chatterboxServerManager } from './services/chatterbox'
import { coquiServerManager } from './services/coqui'
import { logger } from './utils/logger'
import { 
  getWorkspacePath, 
  getReposPath, 
  getConfigPath,
  getOpenCodeConfigFilePath,
  getAgentsMdPath,
  getDatabasePath,
  ENV
} from '@opencode-manager/shared/config/env'
import { OpenCodeConfigSchema } from '@opencode-manager/shared/schemas'
import stripJsonComments from 'strip-json-comments'

const { PORT, HOST } = ENV.SERVER
const DB_PATH = getDatabasePath()

const app = new Hono()

app.use('/*', cors({
  origin: (origin) => {
    const trustedOrigins = ENV.AUTH.TRUSTED_ORIGINS.split(',').map(o => o.trim())
    if (!origin) return trustedOrigins[0]
    if (trustedOrigins.includes(origin)) return origin
    return trustedOrigins[0]
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

function getBasicAuthCredentials(): { username: string; password: string } | null {
  const { AUTH_USERNAME, AUTH_PASSWORD } = ENV.SERVER
  if (AUTH_USERNAME && AUTH_PASSWORD) {
    return { username: AUTH_USERNAME, password: AUTH_PASSWORD }
  }
  
  const authFilePath = path.join(os.homedir(), '.local', 'run', 'opencode-manager', 'auth.json')
  try {
    const fs = require('fs')
    if (fs.existsSync(authFilePath)) {
      const data = JSON.parse(fs.readFileSync(authFilePath, 'utf8'))
      if (data.username && data.password) {
        return { username: data.username, password: data.password }
      }
    }
  } catch {
    // Ignore errors reading auth file
  }
  
  return null
}

const authCredentials = getBasicAuthCredentials()
if (authCredentials) {
  logger.info(`Basic authentication enabled for user: ${authCredentials.username}`)
  app.use('/*', basicAuth({
    username: authCredentials.username,
    password: authCredentials.password,
  }))
}

const db = initializeDatabase(DB_PATH)
const auth = createAuth(db)
const requireAuth = createAuthMiddleware(auth)

import { DEFAULT_AGENTS_MD } from './constants'

let ipcServer: IPCServer | undefined
const gitAuthService = new GitAuthService()

async function ensureDefaultConfigExists(): Promise<void> {
  const settingsService = new SettingsService(db)
  const workspaceConfigPath = getOpenCodeConfigFilePath()
  
  if (await fileExists(workspaceConfigPath)) {
    logger.info(`Found workspace config at ${workspaceConfigPath}, syncing to database...`)
    try {
      const rawContent = await readFileContent(workspaceConfigPath)
      const parsed = JSON.parse(stripJsonComments(rawContent))
      const validation = OpenCodeConfigSchema.safeParse(parsed)
      
      if (!validation.success) {
        logger.warn('Workspace config has invalid structure', validation.error)
      } else {
        const existingDefault = settingsService.getOpenCodeConfigByName('default')
        if (existingDefault) {
          settingsService.updateOpenCodeConfig('default', {
            content: rawContent,
            isDefault: true,
          })
          logger.info('Updated database config from workspace file')
        } else {
          settingsService.createOpenCodeConfig({
            name: 'default',
            content: rawContent,
            isDefault: true,
          })
          logger.info('Created database config from workspace file')
        }
        return
      }
    } catch (error) {
      logger.warn('Failed to read workspace config', error)
    }
  }
  
  const homeConfigPath = path.join(os.homedir(), '.config/opencode/opencode.json')
  if (await fileExists(homeConfigPath)) {
    logger.info(`Found home config at ${homeConfigPath}, importing...`)
    try {
      const rawContent = await readFileContent(homeConfigPath)
      const parsed = JSON.parse(stripJsonComments(rawContent))
      const validation = OpenCodeConfigSchema.safeParse(parsed)
      
      if (validation.success) {
        const existingDefault = settingsService.getOpenCodeConfigByName('default')
        if (existingDefault) {
          settingsService.updateOpenCodeConfig('default', {
            content: rawContent,
            isDefault: true,
          })
        } else {
          settingsService.createOpenCodeConfig({
            name: 'default',
            content: rawContent,
            isDefault: true,
          })
        }
        
        await writeFileContent(workspaceConfigPath, rawContent)
        logger.info('Imported home config to workspace')
        return
      }
    } catch (error) {
      logger.warn('Failed to import home config', error)
    }
  }
  
  const existingDbConfigs = settingsService.getOpenCodeConfigs()
  if (existingDbConfigs.configs.length > 0) {
    const defaultConfig = settingsService.getDefaultOpenCodeConfig()
    if (defaultConfig) {
      await writeFileContent(workspaceConfigPath, defaultConfig.rawContent)
      logger.info('Wrote existing database config to workspace file')
    }
    return
  }
  
  logger.info('No existing config found, creating minimal seed config')
  const seedConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2)
  settingsService.createOpenCodeConfig({
    name: 'default',
    content: seedConfig,
    isDefault: true,
  })
  await writeFileContent(workspaceConfigPath, seedConfig)
  logger.info('Created minimal seed config')
}

async function ensureDefaultAgentsMdExists(): Promise<void> {
  const agentsMdPath = getAgentsMdPath()
  const exists = await fileExists(agentsMdPath)
  
  if (!exists) {
    await writeFileContent(agentsMdPath, DEFAULT_AGENTS_MD)
    logger.info(`Created default AGENTS.md at: ${agentsMdPath}`)
  }
}

export const DEFAULT_AGENTS_MD = `# OpenCode Manager - Global Agent Instructions

## Critical System Constraints

- **DO NOT** use ports 5003 or 5551 - these are reserved for OpenCode Manager
- **DO NOT** kill or stop processes on ports 5003 or 5551
- **DO NOT** modify files in the \`.config/opencode\` directory unless explicitly requested

## Dev Server Ports

When starting dev servers, use the pre-allocated ports 5100-5103:
- Port 5100: Primary dev server (frontend)
- Port 5101: Secondary dev server (API/backend)
- Port 5102: Additional service
- Port 5103: Additional service

Always bind to \`0.0.0.0\` to allow external access from the Docker host.

## Package Management

### Node.js Packages
Prefer **pnpm** or **bun** over npm for installing dependencies to save disk space:
- Use \`pnpm install\` instead of \`npm install\`
- Use \`bun install\` as an alternative
- Both are pre-installed in the container

 ### Python Packages
 Always create a virtual environment in the repository directory before installing packages:

 1. Create virtual environment in repo:
   \`cd \`<repo_path>\`
   \`uv venv .venv\`

 2. Activate the virtual environment:
   \`source .venv/bin/activate\`  # or \`uv pip sync\` for project-based workflows

 3. Install packages into activated environment:
   \`uv pip install \`<package>\`
   \`uv pip install -r requirements.txt\`

 4. Run Python commands:
   \`python script.py\`  # Uses activated .venv

 Alternative: Use \`uv run python script.py\` to skip explicit activation

 **Important:**
 - Always create .venv in the repository directory (not workspace root)
 - Activate the environment before running pip operations
 - uv is pre-installed in the container and provides faster package installation
 - .venv directories created in repos will persist but can be removed safely

## General Guidelines

- This file is merged with any AGENTS.md files in individual repositories
- Repository-specific instructions take precedence for their respective codebases
`

async function ensureDefaultConfigExists(): Promise<void> {
  const settingsService = new SettingsService(db)
  const existingDbConfigs = settingsService.getOpenCodeConfigs()
  
  // Config already exists in database - nothing to do
  if (existingDbConfigs.configs.length > 0) {
    logger.info('OpenCode config already exists in database')
    return
  }
  
  // Try to import from existing OpenCode installation (highest priority)
  const homeConfigPath = path.join(os.homedir(), '.config/opencode/opencode.json')
  if (await fileExists(homeConfigPath)) {
    logger.info(`Found existing OpenCode config at ${homeConfigPath}, importing...`)
    try {
      const content = await readFileContent(homeConfigPath)
      const parsed = JSON.parse(content)
      const validation = OpenCodeConfigSchema.safeParse(parsed)
      
      if (!validation.success) {
        logger.warn('Existing config has invalid structure, will try other sources', validation.error)
      } else {
        settingsService.createOpenCodeConfig({
          name: 'default',
          content: validation.data,
          isDefault: true,
        })
        logger.info('Successfully imported existing OpenCode config')
        return
      }
    } catch (error) {
      logger.warn('Failed to import existing config, will try other sources', error)
    }
  }
  
  // Try to import from workspace config (if user reinstalls and workspace persists)
  const workspaceConfigPath = getOpenCodeConfigFilePath()
  if (await fileExists(workspaceConfigPath)) {
    logger.info(`Found workspace config, importing...`)
    try {
      const content = await readFileContent(workspaceConfigPath)
      const parsed = JSON.parse(content)
      const validation = OpenCodeConfigSchema.safeParse(parsed)
      
      if (!validation.success) {
        logger.warn('Workspace config has invalid structure, will use defaults', validation.error)
      } else {
        settingsService.createOpenCodeConfig({
          name: 'default',
          content: validation.data,
          isDefault: true,
        })
        logger.info('Successfully imported workspace config')
        return
      }
    } catch (error) {
      logger.warn('Failed to import workspace config, will use defaults', error)
    }
  }
  
  // No existing config found - create minimal seed config
  logger.info('No existing OpenCode config found, creating minimal seed config')
  settingsService.createOpenCodeConfig({
    name: 'default',
    content: {
      $schema: 'https://opencode.ai/config.json',
      // Minimal seed - users can configure through Manager UI
    },
    isDefault: true,
  })
  logger.info('Created minimal seed OpenCode config')
}

async function syncDefaultConfigToDisk(): Promise<void> {
  if (process.env.OPENCODE_CLIENT_MODE === 'true') {
    logger.info('Client mode: skipping config sync to preserve existing server config')
    return
  }

  const settingsService = new SettingsService(db)
  const managerConfig = settingsService.getDefaultOpenCodeConfig()
  
  if (!managerConfig) {
    logger.info('No default OpenCode config found in database')
    return
  }

  const homeConfigPath = path.join(os.homedir(), '.config/opencode/opencode.json')
  let userConfig: Record<string, unknown> = {}
  
  if (await fileExists(homeConfigPath)) {
    try {
      const content = await readFileContent(homeConfigPath)
      userConfig = JSON.parse(content)
      logger.info('Found user local OpenCode config, will merge with Manager config')
    } catch (error) {
      logger.warn('Failed to read user config, using Manager config only:', error)
    }
  }

  const mergedConfig = {
    ...managerConfig.content,
    model: userConfig.model || managerConfig.content.model,
    small_model: userConfig.small_model || managerConfig.content.small_model,
    provider: {
      ...(managerConfig.content.provider || {}),
      ...(userConfig.provider as Record<string, unknown> || {}),
    },
  }

  const configPath = getOpenCodeConfigFilePath()
  const configContent = JSON.stringify(mergedConfig, null, 2)
  await writeFileContent(configPath, configContent)
  logger.info(`Synced merged config to: ${configPath} (user model: ${userConfig.model || 'none'}, manager additions applied)`)
}

async function ensureDefaultAgentsMdExists(): Promise<void> {
  const agentsMdPath = getAgentsMdPath()
  const exists = await fileExists(agentsMdPath)
  
  if (!exists) {
    await writeFileContent(agentsMdPath, DEFAULT_AGENTS_MD)
    logger.info(`Created default AGENTS.md at: ${agentsMdPath}`)
  }
}

try {
  if (ENV.SERVER.NODE_ENV === 'production' && !ENV.AUTH.SECRET) {
    logger.error('AUTH_SECRET is required in production mode')
    logger.error('Generate one with: openssl rand -base64 32')
    logger.error('Set it as environment variable: AUTH_SECRET=your-secret')
    process.exit(1)
  }

  await ensureDirectoryExists(getWorkspacePath())
  await ensureDirectoryExists(getReposPath())
  await ensureDirectoryExists(getConfigPath())
  logger.info('Workspace directories initialized')

  await cleanupOrphanedDirectories(db)
  logger.info('Orphaned directory cleanup completed')

  await cleanupExpiredCache()

  await ensureDefaultConfigExists()
  await ensureDefaultAgentsMdExists()

  const settingsService = new SettingsService(db)
  settingsService.initializeLastKnownGoodConfig()

  ipcServer = await createIPCServer(process.env.STORAGE_PATH || undefined)
  gitAuthService.initialize(ipcServer, db)
  logger.info(`Git IPC server running at ${ipcServer.ipcHandlePath}`)

  opencodeServerManager.setDatabase(db)
  await opencodeServerManager.start()
  logger.info(`OpenCode server running on port ${opencodeServerManager.getPort()}`)

  try {
    await whisperServerManager.start()
    logger.info(`Whisper STT server running on port ${whisperServerManager.getPort()}`)
  } catch (error) {
    logger.warn('Whisper server failed to start (STT will be unavailable):', error)
  }

  try {
    const ttsSettings = settingsService.getSettings('default').preferences.tts
    if (ttsSettings?.enabled) {
      if (ttsSettings.provider === 'coqui') {
        logger.info('TTS is enabled with Coqui provider, starting Coqui TTS server...')
        await coquiServerManager.start()
        logger.info(`Coqui TTS server running on port ${coquiServerManager.getPort()}`)
      } else if (ttsSettings.provider === 'chatterbox') {
        logger.info('TTS is enabled with Chatterbox provider, starting Chatterbox server...')
        await chatterboxServerManager.start()
        logger.info(`Chatterbox server running on port ${chatterboxServerManager.getPort()}`)
      }
    }
  } catch (error) {
    logger.warn('TTS server failed to start:', error)
  }

  await syncAdminFromEnv(auth, db)
} catch (error) {
  logger.error('Failed to initialize workspace:', error)
}

const notificationService = new NotificationService(db)

if (ENV.VAPID.PUBLIC_KEY && ENV.VAPID.PRIVATE_KEY) {
  if (!ENV.VAPID.SUBJECT) {
    logger.warn('VAPID_SUBJECT is not set — push notifications require a mailto: subject (e.g. mailto:you@example.com)')
  } else if (!ENV.VAPID.SUBJECT.startsWith('mailto:')) {
    logger.warn(`VAPID_SUBJECT="${ENV.VAPID.SUBJECT}" does not use mailto: format — iOS/Safari push notifications will fail`)
  }

  notificationService.configureVapid({
    publicKey: ENV.VAPID.PUBLIC_KEY,
    privateKey: ENV.VAPID.PRIVATE_KEY,
    subject: ENV.VAPID.SUBJECT || 'mailto:push@localhost',
  })
  sseAggregator.onEvent((directory, event) => {
    notificationService.handleSSEEvent(directory, event).catch((err) => {
      logger.error('Push notification dispatch error:', err)
    })
  })
}

app.route('/api/auth', createAuthRoutes(auth))
app.route('/api/auth-info', createAuthInfoRoutes(auth, db))

app.route('/api/health', createHealthRoutes(db))

const protectedApi = new Hono()
protectedApi.use('/*', requireAuth)

protectedApi.route('/repos', createRepoRoutes(db, gitAuthService))
protectedApi.route('/settings', createSettingsRoutes(db))
protectedApi.route('/files', createFileRoutes())
protectedApi.route('/providers', createProvidersRoutes())
protectedApi.route('/oauth', createOAuthRoutes())
protectedApi.route('/tts', createTTSRoutes(db))
protectedApi.route('/stt', createSTTRoutes(db))
protectedApi.route('/generate-title', createTitleRoutes())
protectedApi.route('/sse', createSSERoutes())
protectedApi.route('/notifications', createNotificationRoutes(notificationService))

app.route('/api', protectedApi)

app.all('/api/opencode/*', requireAuth, async (c) => {
  const request = c.req.raw
  return proxyRequest(request)
})

const isProduction = ENV.SERVER.NODE_ENV === 'production'

if (isProduction) {
  app.use('/*', serveStatic({ root: './frontend/dist' }))
  
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.notFound()
    }
    const fs = await import('fs/promises')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'frontend/dist/index.html')
    const html = await fs.readFile(indexPath, 'utf-8')
    return c.html(html)
  })
} else {
  const VITE_DEV_SERVER = 'http://localhost:5173'

  app.get('/api/network-info', async (c) => {
    const os = await import('os')
    const interfaces = os.networkInterfaces()
    const ips = Object.values(interfaces)
      .flat()
      .filter(info => info && !info.internal && info.family === 'IPv4')
      .map(info => info!.address)
    
    const requestHost = c.req.header('host') || `localhost:${PORT}`
    const protocol = c.req.header('x-forwarded-proto') || 'http'
    
    return c.json({
      host: HOST,
      port: PORT,
      requestHost,
      protocol,
      availableIps: ips,
      apiUrls: [
        `${protocol}://localhost:${PORT}`,
        ...ips.map(ip => `${protocol}://${ip}:${PORT}`)
      ]
    })
  })

  app.get('/api/network-info', async (c) => {
    const os = await import('os')
    const interfaces = os.networkInterfaces()
    const ips = Object.values(interfaces)
      .flat()
      .filter(info => info && !info.internal && info.family === 'IPv4')
      .map(info => info!.address)
    
    const requestHost = c.req.header('host') || `localhost:${PORT}`
    const protocol = c.req.header('x-forwarded-proto') || 'http'
    
    return c.json({
      host: HOST,
      port: PORT,
      requestHost,
      protocol,
      availableIps: ips,
      apiUrls: [
        `${protocol}://localhost:${PORT}`,
        ...ips.map(ip => `${protocol}://${ip}:${PORT}`)
      ]
    })
  })
}

let isShuttingDown = false

const shutdown = async (signal: string) => {
  if (isShuttingDown) return
  isShuttingDown = true

  logger.info(`${signal} received, shutting down gracefully...`)
  try {
    sseAggregator.shutdown()
    logger.info('SSE Aggregator stopped')
    if (ipcServer) {
      ipcServer.dispose()
      logger.info('Git IPC server stopped')
    }
    await whisperServerManager.stop()
    logger.info('Whisper server stopped')
    await chatterboxServerManager.stop()
    logger.info('Chatterbox server stopped')
    await coquiServerManager.stop()
    logger.info('Coqui TTS server stopped')
    await opencodeServerManager.stop()
    logger.info('OpenCode server stopped')
  } catch (error) {
    logger.error('Error during shutdown:', error)
  }
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const server = serve({
  fetch: app.fetch,
  port: PORT,
  hostname: HOST,
})

logger.info(`🚀 OpenCode WebUI API running on http://${HOST}:${PORT}`)
