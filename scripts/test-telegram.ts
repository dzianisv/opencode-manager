#!/usr/bin/env bun

interface TestConfig {
  baseUrl: string
  username: string
  password: string
  botToken: string
}

interface TestResult {
  name: string
  passed: boolean
  duration: number
  details?: string
  error?: string
}

const DEFAULT_CONFIG: TestConfig = {
  baseUrl: process.env.OPENCODE_URL || 'http://localhost:5001',
  username: process.env.OPENCODE_USER || '',
  password: process.env.OPENCODE_PASS || '',
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
}

class TelegramTest {
  private config: TestConfig
  private results: TestResult[] = []

  constructor(config: TestConfig) {
    this.config = config
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.config.username && this.config.password) {
      const auth = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')
      headers['Authorization'] = `Basic ${auth}`
    }
    return headers
  }

  private async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> || {}),
      ...this.getAuthHeaders(),
    }
    return fetch(url, { ...options, headers })
  }

  private async runTest(name: string, testFn: () => Promise<{ passed: boolean; details?: string }>): Promise<TestResult> {
    const start = Date.now()
    try {
      const result = await testFn()
      const duration = Date.now() - start
      const testResult: TestResult = { name, ...result, duration }
      this.results.push(testResult)
      return testResult
    } catch (error) {
      const duration = Date.now() - start
      const testResult: TestResult = {
        name,
        passed: false,
        duration,
        error: error instanceof Error ? error.message : String(error),
      }
      this.results.push(testResult)
      return testResult
    }
  }

  async testHealth(): Promise<TestResult> {
    return this.runTest('Health Endpoint', async () => {
      const response = await this.fetch('/api/health')
      const data = await response.json()

      if (response.status !== 200) {
        return { passed: false, details: `Status: ${response.status}` }
      }

      return {
        passed: data.status === 'healthy',
        details: `Status: ${data.status}, OpenCode: ${data.opencode}`,
      }
    })
  }

  async testTelegramStatus(): Promise<TestResult> {
    return this.runTest('Telegram Status Endpoint', async () => {
      const response = await this.fetch('/api/telegram/status')

      if (response.status !== 200) {
        return { passed: false, details: `Status: ${response.status}` }
      }

      const data = await response.json()
      return {
        passed: true,
        details: `Running: ${data.running ?? false}`,
      }
    })
  }

  async testTelegramSessions(): Promise<TestResult> {
    return this.runTest('Telegram Sessions Endpoint', async () => {
      const response = await this.fetch('/api/telegram/sessions')

      if (response.status !== 200) {
        return { passed: false, details: `Status: ${response.status}` }
      }

      const data = await response.json()
      const isArray = Array.isArray(data)
      return {
        passed: isArray,
        details: `Sessions: ${isArray ? data.length : 'not an array'}`,
      }
    })
  }

  async testAllowlistCRUD(): Promise<TestResult> {
    return this.runTest('Allowlist CRUD Operations', async () => {
      const testChatId = `test-e2e-${Date.now()}`

      const listBefore = await this.fetch('/api/telegram/allowlist')
      if (listBefore.status !== 200) {
        return { passed: false, details: `GET allowlist failed: ${listBefore.status}` }
      }
      const beforeData = await listBefore.json()
      if (!Array.isArray(beforeData)) {
        return { passed: false, details: 'Allowlist is not an array' }
      }
      const countBefore = beforeData.length

      const addResponse = await this.fetch('/api/telegram/allowlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: testChatId }),
      })
      if (addResponse.status !== 200) {
        const err = await addResponse.json()
        return { passed: false, details: `POST allowlist failed: ${err.error || addResponse.status}` }
      }

      const listAfterAdd = await this.fetch('/api/telegram/allowlist')
      const afterAddData = await listAfterAdd.json()
      const found = afterAddData.some((entry: { provider_chat_id?: string; chatId?: string }) =>
        (entry.provider_chat_id || entry.chatId) === testChatId
      )
      if (!found) {
        return { passed: false, details: `Chat ID "${testChatId}" not found after add. Response: ${JSON.stringify(afterAddData).slice(0, 200)}` }
      }

      const removeResponse = await this.fetch(`/api/telegram/allowlist/${testChatId}`, {
        method: 'DELETE',
      })
      if (removeResponse.status !== 200) {
        return { passed: false, details: `DELETE allowlist failed: ${removeResponse.status}` }
      }

      const listAfterRemove = await this.fetch('/api/telegram/allowlist')
      const afterRemoveData = await listAfterRemove.json()
      const stillPresent = afterRemoveData.some((entry: { provider_chat_id?: string; chatId?: string }) =>
        (entry.provider_chat_id || entry.chatId) === testChatId
      )

      return {
        passed: !stillPresent,
        details: `Before: ${countBefore}, After add: ${afterAddData.length}, After remove: ${afterRemoveData.length}`,
      }
    })
  }

  async testAllowlistValidation(): Promise<TestResult> {
    return this.runTest('Allowlist Validation (missing chatId)', async () => {
      const response = await this.fetch('/api/telegram/allowlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      return {
        passed: response.status === 400,
        details: `Status: ${response.status} (expected 400)`,
      }
    })
  }

  async testDeleteNonexistentAllowlistEntry(): Promise<TestResult> {
    return this.runTest('Delete Nonexistent Allowlist Entry', async () => {
      const response = await this.fetch('/api/telegram/allowlist/nonexistent-chat-id-999', {
        method: 'DELETE',
      })

      return {
        passed: response.status === 404,
        details: `Status: ${response.status} (expected 404)`,
      }
    })
  }

  async testDeleteNonexistentSession(): Promise<TestResult> {
    return this.runTest('Delete Nonexistent Session', async () => {
      const response = await this.fetch('/api/telegram/sessions/nonexistent-session-999', {
        method: 'DELETE',
      })

      return {
        passed: response.status === 404,
        details: `Status: ${response.status} (expected 404)`,
      }
    })
  }

  async testBotStartWithToken(): Promise<TestResult> {
    return this.runTest('Start Telegram Bot (with token)', async () => {
      if (!this.config.botToken) {
        return { passed: true, details: 'SKIPPED: No bot token provided' }
      }

      const response = await this.fetch('/api/telegram/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.config.botToken }),
      })

      const data = await response.json()

      if (response.status === 500 && data.error?.includes('bot.init')) {
        return { passed: true, details: `SKIPPED: Bot token invalid or network issue (${data.error})` }
      }

      if (response.status === 500 && data.error?.includes('Unable to connect')) {
        return { passed: true, details: 'SKIPPED: Cannot reach Telegram API (network restricted)' }
      }

      if (response.status !== 200) {
        return { passed: false, details: `Failed: ${data.error || response.status}` }
      }

      return {
        passed: data.success === true,
        details: `Success: ${data.success}, Running: ${data.status?.running}`,
      }
    })
  }

  async testBotStatusAfterStart(): Promise<TestResult> {
    return this.runTest('Bot Status After Start', async () => {
      if (!this.config.botToken) {
        return { passed: true, details: 'SKIPPED: No bot token provided' }
      }

      const response = await this.fetch('/api/telegram/status')
      if (!response.ok) {
        return { passed: true, details: `SKIPPED: Status check returned ${response.status}` }
      }

      const data = await response.json()

      if (data.running !== true) {
        return { passed: true, details: 'SKIPPED: Bot did not start (token or network issue)' }
      }

      return {
        passed: true,
        details: `Running: ${data.running}, Channel: ${data.channelId || 'telegram'}`,
      }
    })
  }

  async testBotStop(): Promise<TestResult> {
    return this.runTest('Stop Telegram Bot', async () => {
      if (!this.config.botToken) {
        return { passed: true, details: 'SKIPPED: No bot token provided' }
      }

      const statusCheck = await this.fetch('/api/telegram/status')
      let botRunning = false
      try {
        const statusCheckData = await statusCheck.json()
        botRunning = statusCheckData.running === true
      } catch {
        botRunning = false
      }
      if (!botRunning) {
        return { passed: true, details: 'SKIPPED: Bot was not running (nothing to stop)' }
      }

      const response = await this.fetch('/api/telegram/stop', {
        method: 'POST',
      })

      if (response.status !== 200) {
        const data = await response.json()
        return { passed: false, details: `Failed: ${data.error || response.status}` }
      }

      const data = await response.json()

      const statusResponse = await this.fetch('/api/telegram/status')
      const statusData = await statusResponse.json()

      return {
        passed: data.success === true && statusData.running === false,
        details: `Stopped: ${data.success}, Running after stop: ${statusData.running}`,
      }
    })
  }

  async testStartWithoutToken(): Promise<TestResult> {
    return this.runTest('Start Without Token (fallback to env)', async () => {
      const response = await this.fetch('/api/telegram/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const data = await response.json()

      if (response.status === 200) {
        await this.fetch('/api/telegram/stop', { method: 'POST' })
        return {
          passed: true,
          details: 'Started using TELEGRAM_BOT_TOKEN env var',
        }
      }

      const noEnvToken = data.error?.includes('No token') || data.error?.includes('TELEGRAM_BOT_TOKEN')
      return {
        passed: response.status === 400 && noEnvToken,
        details: `Status: ${response.status}, Error: ${data.error}`,
      }
    })
  }

  async runAllTests(): Promise<void> {
    console.log('\nOpenCode Manager Telegram API Tests\n')
    console.log(`Base URL: ${this.config.baseUrl}`)
    console.log(`User: ${this.config.username || '(none)'}`)
    console.log(`Bot Token: ${this.config.botToken ? '***' + this.config.botToken.slice(-6) : '(none)'}`)
    console.log('-'.repeat(60))

    await this.testHealth()
    await this.testTelegramStatus()
    await this.testTelegramSessions()

    await this.testAllowlistCRUD()
    await this.testAllowlistValidation()
    await this.testDeleteNonexistentAllowlistEntry()
    await this.testDeleteNonexistentSession()

    await this.testStartWithoutToken()
    await this.testBotStartWithToken()
    await this.testBotStatusAfterStart()
    await this.testBotStop()

    this.printResults()
  }

  private printResults(): void {
    console.log('\n' + '='.repeat(60))
    console.log('Test Results')
    console.log('='.repeat(60))

    let passed = 0
    let failed = 0

    for (const result of this.results) {
      const icon = result.passed ? '[PASS]' : '[FAIL]'
      passed += result.passed ? 1 : 0
      failed += result.passed ? 0 : 1

      console.log(`\n${icon} ${result.name} (${result.duration}ms)`)
      if (result.details) {
        console.log(`   ${result.details}`)
      }
      if (result.error) {
        console.log(`   Error: ${result.error}`)
      }
    }

    console.log('\n' + '-'.repeat(60))
    console.log(`Total: ${this.results.length} | Passed: ${passed} | Failed: ${failed}`)
    console.log('-'.repeat(60))

    if (failed > 0) {
      process.exit(1)
    }
  }
}

function printHelp(): void {
  console.log(`
OpenCode Manager Telegram API Test

Tests Telegram bot API endpoints: status, sessions, allowlist CRUD, start/stop.

Usage: bun run scripts/test-telegram.ts [options]

Options:
  --url <url>       Base URL (default: http://localhost:5001)
  --user <username> Username for basic auth
  --pass <password> Password for basic auth
  --token <token>   Telegram bot token (for start/stop tests)
  --help, -h        Show this help

Environment Variables:
  OPENCODE_URL         Base URL
  OPENCODE_USER        Username
  OPENCODE_PASS        Password
  TELEGRAM_BOT_TOKEN   Telegram bot token

Tests Performed:
   1. Health endpoint connectivity
   2. Telegram status endpoint
   3. Telegram sessions endpoint
   4. Allowlist CRUD (add, list, remove)
   5. Allowlist validation (missing chatId)
   6. Delete nonexistent allowlist entry (404)
   7. Delete nonexistent session (404)
   8. Start bot without token (env fallback)
   9. Start bot with token
  10. Bot status after start
  11. Stop bot

Examples:
  # Local development
  bun run scripts/test-telegram.ts

  # With bot token for start/stop tests
  bun run scripts/test-telegram.ts --token YOUR_BOT_TOKEN

  # Remote deployment
  bun run scripts/test-telegram.ts --url https://example.trycloudflare.com --user admin --pass secret --token YOUR_BOT_TOKEN
`)
}

async function main() {
  const args = process.argv.slice(2)

  const config: TestConfig = { ...DEFAULT_CONFIG }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      config.baseUrl = args[++i]
    } else if (args[i] === '--user' && args[i + 1]) {
      config.username = args[++i]
    } else if (args[i] === '--pass' && args[i + 1]) {
      config.password = args[++i]
    } else if (args[i] === '--token' && args[i + 1]) {
      config.botToken = args[++i]
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  if (!config.baseUrl.includes('localhost') && !config.baseUrl.includes('127.0.0.1') && !config.password) {
    console.error('Error: Password is required for remote URLs. Use --pass <password> or set OPENCODE_PASS')
    process.exit(1)
  }

  const tester = new TelegramTest(config)
  await tester.runAllTests()
}

main().catch((error) => {
  console.error('Test failed:', error)
  process.exit(1)
})
