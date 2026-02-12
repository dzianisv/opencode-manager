#!/usr/bin/env bun

import puppeteer, { Browser, Page } from 'puppeteer'
import {
  createTestOutputDir,
  takeScreenshot,
  log,
  success,
  fail,
  info,
  createScreencast,
  AutoScreenshotter,
} from './lib/browser-test-utils'

interface TestConfig {
  baseUrl: string
  username: string
  password: string
  headless: boolean
  timeout: number
  outputDir: string
  screenshotsDir: string
}

interface TestResult {
  name: string
  passed: boolean
  duration: number
  details?: string
  error?: string
}

const testDirs = createTestOutputDir('SettingsE2E')

const DEFAULT_CONFIG: TestConfig = {
  baseUrl: process.env.OPENCODE_URL || 'http://localhost:5001',
  username: process.env.OPENCODE_USER || '',
  password: process.env.OPENCODE_PASS || '',
  headless: process.env.CI === 'true',
  timeout: 60000,
  outputDir: testDirs.outputDir,
  screenshotsDir: testDirs.screenshotsDir,
}

class SettingsTest {
  private config: TestConfig
  private results: TestResult[] = []
  private browser: Browser | null = null
  private page: Page | null = null
  private consoleErrors: string[] = []
  private autoScreenshotter: AutoScreenshotter | null = null

  constructor(config: TestConfig) {
    this.config = config
  }

  private async runTest(name: string, testFn: () => Promise<{ passed: boolean; details?: string }>): Promise<TestResult> {
    const start = Date.now()
    try {
      const result = await testFn()
      const duration = Date.now() - start
      const testResult: TestResult = { name, ...result, duration }
      this.results.push(testResult)
      if (result.passed) {
        success(`${name} (${duration}ms)`)
      } else {
        fail(`${name} (${duration}ms) - ${result.details || 'No details'}`)
      }
      return testResult
    } catch (error) {
      const duration = Date.now() - start
      const errorMessage = error instanceof Error ? error.message : String(error)
      const testResult: TestResult = {
        name,
        passed: false,
        duration,
        error: errorMessage
      }
      this.results.push(testResult)
      fail(`${name} (${duration}ms) - ${errorMessage}`)
      return testResult
    }
  }

  private async setupBrowser(): Promise<void> {
    info('Launching browser...')
    
    this.browser = await puppeteer.launch({
      headless: this.config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ]
    })

    this.page = await this.browser.newPage()
    await this.page.setViewport({ width: 1280, height: 900 })

    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (!text.includes('401') && !text.includes('manifest.json') && !text.includes('DialogTitle')) {
          this.consoleErrors.push(text)
        }
      }
    })

    this.page.on('pageerror', (error) => {
      this.consoleErrors.push(`Page error: ${error.message}`)
    })
  }

  private async navigateToApp(): Promise<boolean> {
    if (!this.page) return false

    let url = this.config.baseUrl
    if (this.config.username && this.config.password) {
      const urlObj = new URL(url)
      urlObj.username = this.config.username
      urlObj.password = this.config.password
      url = urlObj.toString()
    }

    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: this.config.timeout })
    await takeScreenshot(this.page, 'home_page', this.config.screenshotsDir)
    return true
  }

  private async openSettingsDialog(): Promise<boolean> {
    if (!this.page) return false

    await this.page.waitForSelector('button', { timeout: 10000 })
    
    const settingsOpened = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      
      for (const button of buttons) {
        const ariaLabel = button.getAttribute('aria-label')
        const title = button.getAttribute('title')
        if (ariaLabel?.toLowerCase().includes('settings') || title?.toLowerCase().includes('settings')) {
          button.click()
          return true
        }
      }
      
      for (const btn of buttons) {
        const svg = btn.querySelector('svg')
        if (svg && btn.className.includes('ghost')) {
          const html = svg.outerHTML
          if (html.includes('circle') && html.includes('path')) {
            btn.click()
            return true
          }
        }
      }
      
      const headerButtons = Array.from(document.querySelectorAll('header button'))
      for (const btn of headerButtons) {
        if (btn.className.includes('ghost') && btn.querySelector('svg')) {
          (btn as HTMLElement).click()
          return true
        }
      }
      
      if (buttons[5]) {
        (buttons[5] as HTMLElement).click()
        return true
      }
      
      return false
    })

    if (!settingsOpened) {
      throw new Error('Could not find settings button')
    }

    await this.page.waitForSelector('[role="dialog"]', { timeout: 5000 })
    await new Promise(resolve => setTimeout(resolve, 500))
    await takeScreenshot(this.page, 'settings_dialog_opened', this.config.screenshotsDir)
    return true
  }

  private async testSettingsDialogOpens(): Promise<{ passed: boolean; details?: string }> {
    if (!this.page) return { passed: false, details: 'No page available' }

    const dialog = await this.page.$('[role="dialog"]')
    if (!dialog) {
      return { passed: false, details: 'Settings dialog not found' }
    }

    const hasSettingsTitle = await this.page.evaluate(() => {
      const headings = document.querySelectorAll('h2')
      return Array.from(headings).some(h => h.textContent?.includes('Settings') || h.textContent?.includes('General'))
    })

    if (!hasSettingsTitle) {
      return { passed: false, details: 'Settings heading not found' }
    }

    return { passed: true, details: 'Settings dialog opened successfully' }
  }

  private async switchToTab(tabName: string): Promise<void> {
    if (!this.page) return

    await this.page.waitForSelector('[role="dialog"]')

    const dialog = await this.page.$('[role="dialog"]')
    const tabs = dialog ? await dialog.$$('[role="tab"]') : []
    let switched = false

    for (const tab of tabs) {
      const text = await this.page.evaluate(el => el.textContent || '', tab)
      if (text.toLowerCase().includes(tabName.toLowerCase())) {
        await tab.click()
        switched = true
        break
      }
    }

    if (switched) {
      await new Promise(resolve => setTimeout(resolve, 1000))

      await this.waitForActiveTab(tabName, 20000)
      
      const headingsMap: Record<string, string[]> = {
        'Voice': ['Text-to-Speech', 'Speech-to-Text', 'Talk Mode'],
        'General': ['General Preferences', 'Notifications'],
        'Shortcuts': ['Keyboard Shortcuts'],
        'OpenCode': ['OpenCode'],
        'Providers': ['AI Providers', 'Provider'],
        'Tunnel': ['Cloudflare Tunnel', 'Tunnel'],
        'Telegram': ['Telegram'],
      }
      const expectedHeadings = headingsMap[tabName] || []
      
      if (expectedHeadings.length > 0) {
        await this.waitForHeading(expectedHeadings, 20000)
      }
      
      info(`Switched to ${tabName} tab`)
    } else {
      info(`Could not find ${tabName} tab`)
    }
  }

  private async waitForActiveTab(tabName: string, timeoutMs: number): Promise<boolean> {
    if (!this.page) return false

    try {
      await this.page.waitForFunction(
        (name) => {
          const dialog = document.querySelector('[role="dialog"]')
          const tabs = Array.from((dialog || document).querySelectorAll('[role="tab"]'))
          const tab = tabs.find(t => t.textContent?.toLowerCase().includes(name.toLowerCase()))
          if (!tab) return false
          const state = tab.getAttribute('data-state')
          const selected = tab.getAttribute('aria-selected')
          return state === 'active' || selected === 'true'
        },
        { timeout: timeoutMs },
        tabName
      )
      return true
    } catch {
      return false
    }
  }

  private async waitForHeading(headings: string[], timeoutMs: number): Promise<boolean> {
    if (!this.page) return false

    try {
      await this.page.waitForFunction(
        (texts) => {
          const dialog = document.querySelector('[role="dialog"]')
          const activePanel = dialog?.querySelector('[role="tabpanel"][data-state="active"]') || dialog
          const headingNodes = Array.from((activePanel || document).querySelectorAll('h2'))
          const headingText = headingNodes.map(node => node.textContent || '').join('\n')
          const bodyText = activePanel?.textContent || dialog?.textContent || document.body?.textContent || ''
          const normalize = (value: string) => value
            .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '')
          const normalizedHeading = normalize(headingText)
          const normalizedBody = normalize(bodyText)
          return texts.some((text) => {
            const normalizedText = normalize(text)
            return normalizedHeading.includes(normalizedText) || normalizedBody.includes(normalizedText)
          })
        },
        { timeout: timeoutMs },
        headings
      )
      return true
    } catch {
      return false
    }
  }

  private async getDialogHeadingText(): Promise<string> {
    if (!this.page) return ''

    return this.page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return ''
      const activePanel = dialog.querySelector('[role="tabpanel"][data-state="active"]') || dialog
      const headings = Array.from(activePanel.querySelectorAll('h2'))
      return headings.map(h => h.textContent || '').join(' | ')
    })
  }

  private async testGeneralSettingsTab(): Promise<{ passed: boolean; details?: string }> {
    if (!this.page) return { passed: false, details: 'No page available' }

    const generalPreferencesHeading = await this.page.evaluate(() => {
      const headings = document.querySelectorAll('h2')
      return Array.from(headings).some(h => h.textContent?.includes('General Preferences'))
    })

    if (!generalPreferencesHeading) {
      return { passed: false, details: 'General Preferences heading not found' }
    }

    const themeSelector = await this.page.$('button[role="combobox"]')
    if (!themeSelector) {
      return { passed: false, details: 'Theme selector not found' }
    }

    const switches = await this.page.$$('button[role="switch"]')
    if (switches.length < 3) {
      return { passed: false, details: `Expected at least 3 switches, found ${switches.length}` }
    }

    await takeScreenshot(this.page, 'general_settings', this.config.screenshotsDir)
    return { passed: true, details: `Found theme selector and ${switches.length} toggle switches` }
  }

  private async testTTSSettings(): Promise<{ passed: boolean; details?: string }> {
    if (!this.page) return { passed: false, details: 'No page available' }

    const ttsSection = await this.waitForHeading(['Text-to-Speech'], 30000)

    if (!ttsSection) {
      const dialogHeadings = await this.getDialogHeadingText()
      info(`Dialog headings: ${dialogHeadings || 'none'}`)
      return { passed: false, details: 'TTS section heading not found' }
    }

    const enableTTSSwitch = await this.page.evaluate(() => {
      const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
      for (const sw of switches) {
        const labels = sw.closest('.flex, div')?.querySelectorAll('label, .text-base, span')
        const hasEnableLabel = Array.from(labels || []).some(el => el.textContent?.includes('Enable TTS'))
        if (hasEnableLabel) {
          return {
            found: true,
            checked: sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('data-state') === 'checked'
          }
        }
      }
      return { found: false, checked: false }
    })

    if (!enableTTSSwitch.found) {
      return { passed: false, details: 'Enable TTS switch not found' }
    }

    if (!enableTTSSwitch.checked) {
      info('TTS is disabled, enabling it...')
      await this.page.evaluate(() => {
        const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
        for (const sw of switches) {
          const labels = sw.closest('.flex, div')?.querySelectorAll('label, .text-base, span')
          const hasEnableLabel = Array.from(labels || []).some(el => el.textContent?.includes('Enable TTS'))
          if (hasEnableLabel) {
            (sw as HTMLElement).click()
            break
          }
        }
      })
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    const providerButtons = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const providerBtns = buttons.filter(btn => {
        const text = btn.textContent || ''
        return text.includes('Built-in') || 
               text.includes('Coqui') ||
               text.includes('Chatterbox') ||
               text.includes('External')
      })
      return providerBtns.length
    })

    if (providerButtons < 2) {
      return { passed: false, details: `Expected TTS provider buttons, found ${providerButtons}` }
    }

    const testButton = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      return buttons.some(btn => {
        const text = btn.textContent?.trim().toLowerCase() || ''
        return text === 'test' || text.includes('test tts')
      })
    })

    await takeScreenshot(this.page, 'tts_settings', this.config.screenshotsDir)
    return { 
      passed: true, 
      details: `TTS section found with ${providerButtons} providers, test button: ${testButton}` 
    }
  }

  private async testCoquiModelSelector(): Promise<{ passed: boolean; details?: string }> {
    if (!this.page) return { passed: false, details: 'No page available' }

    const coquiStatusUrl = `${this.config.baseUrl}/api/tts/coqui/status`
    try {
      const headers: Record<string, string> = {}
      if (this.config.username && this.config.password) {
        headers['Authorization'] = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`
      }
      const statusResponse = await fetch(coquiStatusUrl, { headers, signal: AbortSignal.timeout(5000) })
      if (statusResponse.ok) {
        const statusData = await statusResponse.json() as { running?: boolean; available?: boolean; error?: string }
        if (statusData.available === false || statusData.error?.includes('not found')) {
          info('Coqui TTS not available on this deployment, skipping')
          return { passed: true, details: 'SKIPPED: Coqui TTS not available on this deployment' }
        }
        if (!statusData.running) {
          info('Coqui server not running, skipping model selector test')
          return { passed: true, details: 'SKIPPED: Coqui server not running' }
        }
      } else {
        info(`Coqui status check returned ${statusResponse.status}, skipping`)
        return { passed: true, details: `SKIPPED: Coqui status endpoint returned ${statusResponse.status}` }
      }
    } catch {
      info('Coqui status check failed (server may not be available), skipping')
      return { passed: true, details: 'SKIPPED: Coqui status endpoint unreachable' }
    }

    const ttsSection = await this.waitForHeading(['Text-to-Speech'], 30000)
    if (!ttsSection) {
      const dialogHeadings = await this.getDialogHeadingText()
      info(`Dialog headings: ${dialogHeadings || 'none'}`)
      return { passed: false, details: 'TTS section heading not found' }
    }

    const buttons = await this.page.$$('button')
    let coquiButton = null as null | import('puppeteer').ElementHandle
    for (const button of buttons) {
      const text = await this.page.evaluate(el => el.textContent || '', button)
      if (text.includes('Coqui')) {
        coquiButton = button
        break
      }
    }

    if (!coquiButton) {
      return { passed: false, details: 'Coqui provider button not found' }
    }

    await coquiButton.click()
    await new Promise(resolve => setTimeout(resolve, 3000))

    const modelInput = await this.page.evaluateHandle(() => {
      const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent?.includes('TTS Model'))
      if (label) {
        const container = label.closest('div')
        const input = container?.querySelector('input')
        if (input) return input
      }
      const inputs = Array.from(document.querySelectorAll('input'))
      return inputs.find(input => {
        const placeholder = input.getAttribute('placeholder') || ''
        return placeholder.toLowerCase().includes('tts model')
      })
    })
    const modelInputElement = modelInput.asElement()
    if (!modelInputElement) {
      return { passed: false, details: 'TTS Model input not found' }
    }

    const modelsCount = await this.page.evaluate(() => {
      const text = document.body.innerText
      const match = text.match(/(\d+) models available/)
      return match ? parseInt(match[1]) : 0
    })

    await modelInputElement.click()
    await this.page.keyboard.down('Meta')
    await this.page.keyboard.press('a')
    await this.page.keyboard.up('Meta')
    await this.page.keyboard.press('Backspace')
    await new Promise(resolve => setTimeout(resolve, 1500))

    const dropdownOptions = await this.page.evaluate(() => {
      const dropdowns = Array.from(document.querySelectorAll('.absolute.z-50'))
      for (const dropdown of dropdowns) {
        const options = dropdown.querySelectorAll('button[data-option]')
        if (options.length > 0) return options.length
      }
      return 0
    })

    await takeScreenshot(this.page, 'coqui_model_selector', this.config.screenshotsDir)

    await this.page.evaluate(() => {
      const label = document.querySelector('label')
      if (label) label.click()
    })
    await new Promise(resolve => setTimeout(resolve, 500))

    await this.page.evaluate(() => {
      const builtinBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.includes('Built-in Browser'))
      if (builtinBtn) (builtinBtn as HTMLElement).click()
    })
    await new Promise(resolve => setTimeout(resolve, 500))

    const passed = modelsCount >= 10 && dropdownOptions > 0
    return { 
      passed, 
      details: passed 
        ? `Coqui model selector working: ${dropdownOptions} options in dropdown, ${modelsCount} models available`
        : `Expected at least 10 models available, found ${modelsCount}. Dropdown options: ${dropdownOptions}` 
    }
  }

  private async testSTTSettings(): Promise<{ passed: boolean; details?: string }> {
    if (!this.page) return { passed: false, details: 'No page available' }

    const sttSection = await this.waitForHeading(['Speech-to-Text'], 30000)

    if (!sttSection) {
      const dialogHeadings = await this.getDialogHeadingText()
      info(`Dialog headings: ${dialogHeadings || 'none'}`)
      return { passed: false, details: 'STT section heading not found' }
    }

    const enableSTTSwitch = await this.page.evaluate(() => {
      const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
      for (const sw of switches) {
        const labels = sw.closest('.flex, div')?.querySelectorAll('label, .text-base, span')
        const hasEnableLabel = Array.from(labels || []).some(el => el.textContent?.includes('Enable STT'))
        if (hasEnableLabel) {
          return {
            found: true,
            checked: sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('data-state') === 'checked'
          }
        }
      }
      return { found: false, checked: false }
    })

    if (!enableSTTSwitch.found) {
      return { passed: false, details: 'Enable STT switch not found' }
    }

    if (!enableSTTSwitch.checked) {
      info('STT is disabled, enabling it...')
      await this.page.evaluate(() => {
        const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
        for (const sw of switches) {
          const labels = sw.closest('.flex, div')?.querySelectorAll('label, .text-base, span')
          const hasEnableLabel = Array.from(labels || []).some(el => el.textContent?.includes('Enable STT'))
          if (hasEnableLabel) {
            (sw as HTMLElement).click()
            break
          }
        }
      })
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    const testButton = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      return buttons.some(btn => {
        const text = btn.textContent?.trim().toLowerCase() || ''
        const parent = btn.closest('div')
        const parentText = parent?.textContent?.toLowerCase() || ''
        return (text === 'test' || text.includes('test')) && parentText.includes('stt')
      })
    })

    await takeScreenshot(this.page, 'stt_settings', this.config.screenshotsDir)
    return { 
      passed: true, 
      details: `STT section found, test button: ${testButton}` 
    }
  }

  private async testNotificationSettings(): Promise<{ passed: boolean; details?: string }> {
    if (!this.page) return { passed: false, details: 'No page available' }

    await this.page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h2')).find(h => h.textContent?.includes('Notifications'))
      if (heading) heading.scrollIntoView({ behavior: 'instant', block: 'center' })
    })
    await new Promise(resolve => setTimeout(resolve, 300))

    const notificationSection = await this.page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h2')).find(h => h.textContent?.includes('Notifications'))
      return !!heading
    })

    if (!notificationSection) {
      return { passed: false, details: 'Notifications section heading not found' }
    }

    const enableNotificationsSwitch = await this.page.evaluate(() => {
      const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
      for (const sw of switches) {
        const labels = sw.closest('.flex, div')?.querySelectorAll('label, .text-base, span')
        const hasEnableLabel = Array.from(labels || []).some(el => 
          el.textContent?.includes('Enable Notifications') || el.textContent?.includes('Enable notifications')
        )
        if (hasEnableLabel) {
          return {
            found: true,
            checked: sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('data-state') === 'checked'
          }
        }
      }
      return { found: false, checked: false }
    })

    if (!enableNotificationsSwitch.found) {
      return { passed: false, details: 'Enable Notifications switch not found' }
    }

    if (!enableNotificationsSwitch.checked) {
      info('Notifications disabled, enabling...')
      await this.page.evaluate(() => {
        const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
        for (const sw of switches) {
          const labels = sw.closest('.flex, div')?.querySelectorAll('label, .text-base, span')
          const hasEnableLabel = Array.from(labels || []).some(el => 
            el.textContent?.includes('Enable Notifications') || el.textContent?.includes('Enable notifications')
          )
          if (hasEnableLabel) {
            (sw as HTMLElement).click()
            break
          }
        }
      })
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    const sessionCompleteSwitch = await this.page.evaluate(() => {
      const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
      return switches.some(sw => {
        const parent = sw.closest('.flex, div')
        return parent?.textContent?.includes('Session Complete') || parent?.textContent?.includes('session complete')
      })
    })

    const permissionRequestsSwitch = await this.page.evaluate(() => {
      const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
      return switches.some(sw => {
        const parent = sw.closest('.flex, div')
        return parent?.textContent?.includes('Permission') || parent?.textContent?.includes('permission')
      })
    })

    await takeScreenshot(this.page, 'notification_settings', this.config.screenshotsDir)
    return { 
      passed: true, 
      details: `Notifications section found, session complete: ${sessionCompleteSwitch}, permission requests: ${permissionRequestsSwitch}` 
    }
  }

  private async testTalkModeSettings(): Promise<{ passed: boolean; details?: string }> {
    if (!this.page) return { passed: false, details: 'No page available' }

    const talkModeSection = await this.waitForHeading(['Talk Mode'], 30000)

    if (!talkModeSection) {
      const dialogHeadings = await this.getDialogHeadingText()
      info(`Dialog headings: ${dialogHeadings || 'none'}`)
      return { passed: false, details: 'Talk Mode section heading not found' }
    }

    const enableTalkModeSwitch = await this.page.evaluate(() => {
      const switches = Array.from(document.querySelectorAll('button[role="switch"]'))
      for (const sw of switches) {
        const labels = sw.closest('.flex, div')?.querySelectorAll('label, .text-base, span')
        const hasEnableLabel = Array.from(labels || []).some(el => 
          el.textContent?.includes('Enable Talk Mode') || el.textContent?.includes('enable talk mode')
        )
        if (hasEnableLabel) {
          return {
            found: true,
            checked: sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('data-state') === 'checked'
          }
        }
      }
      return { found: false, checked: false }
    })

    if (!enableTalkModeSwitch.found) {
      return { passed: false, details: 'Enable Talk Mode switch not found' }
    }

    const sliders = await this.page.evaluate(() => {
      return document.querySelectorAll('[role="slider"]').length
    })

    await takeScreenshot(this.page, 'talkmode_settings', this.config.screenshotsDir)
    return { 
      passed: true, 
      details: `Talk Mode section found, sliders: ${sliders}` 
    }
  }

  private async testNoConsoleErrors(): Promise<{ passed: boolean; details?: string }> {
    const criticalErrors = this.consoleErrors.filter(err => 
      err.includes('useFormField') || 
      err.includes('FormField') ||
      err.includes('FormLabel') ||
      err.includes('Cannot read properties') ||
      err.includes('is not defined') ||
      err.includes('Uncaught')
    )

    if (criticalErrors.length > 0) {
      return { 
        passed: false, 
        details: `Found ${criticalErrors.length} critical console errors: ${criticalErrors.join('; ')}` 
      }
    }

    return { 
      passed: true, 
      details: `No critical console errors (${this.consoleErrors.length} total warnings/errors filtered)` 
    }
  }

  private async testOtherSettingsTabs(): Promise<{ passed: boolean; details?: string }> {
    if (!this.page) return { passed: false, details: 'No page available' }

    const tabs = await this.page.$$('[role="tab"]')
    const tabNames: string[] = []

    for (const tab of tabs) {
      const name = await tab.evaluate(el => el.textContent)
      if (name) tabNames.push(name)
    }

    info(`Found tabs: ${tabNames.join(', ')}`)

    if (tabs.length === 0) {
      return { passed: false, details: 'No tabs found in settings dialog' }
    }

    for (let i = 1; i < tabs.length; i++) {
      await tabs[i].click()
      await new Promise(resolve => setTimeout(resolve, 500))
      
      const tabName = tabNames[i] || `Tab ${i}`
      await takeScreenshot(this.page, `tab_${tabName.toLowerCase().replace(/\s+/g, '_')}`, this.config.screenshotsDir)

      const tabContent = await this.page.$('[role="tabpanel"]')
      if (!tabContent) {
        return { passed: false, details: `Tab "${tabName}" has no content panel` }
      }
    }

    if (tabs[0]) {
      await tabs[0].click()
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    return { passed: true, details: `All ${tabNames.length} tabs render without errors` }
  }

  async runAllTests(): Promise<void> {
    console.log('\n' + '='.repeat(60))
    console.log('OpenCode Manager Settings E2E Tests')
    console.log('='.repeat(60))
    console.log(`Base URL: ${this.config.baseUrl}`)
    console.log(`User: ${this.config.username || '(none)'}`)
    console.log(`Headless: ${this.config.headless}`)
    console.log(`Output: ${this.config.outputDir}`)
    console.log('='.repeat(60) + '\n')

    try {
      await this.setupBrowser()
      await this.navigateToApp()

      this.autoScreenshotter = new AutoScreenshotter({
        browser: this.browser,
        page: this.page,
        screenshotsDir: this.config.screenshotsDir,
        intervalMs: 500
      })
      this.autoScreenshotter.start()

      await this.openSettingsDialog()

      await this.runTest('Settings Dialog Opens', () => this.testSettingsDialogOpens())
      await this.runTest('General Settings Tab', () => this.testGeneralSettingsTab())
      
      // Switch to Voice tab for TTS/STT/Talk Mode tests
      await this.switchToTab('Voice')
      
      await this.runTest('TTS Settings', () => this.testTTSSettings())
      await this.runTest('Coqui Model Selector', () => this.testCoquiModelSelector())
      await this.runTest('STT Settings', () => this.testSTTSettings())
      await this.runTest('Talk Mode Settings', () => this.testTalkModeSettings())
      
      // Switch back to General for Notification Settings
      await this.switchToTab('General')
      
      await this.runTest('Notification Settings', () => this.testNotificationSettings())
      await this.runTest('Other Settings Tabs', () => this.testOtherSettingsTabs())
      await this.runTest('No Critical Console Errors', () => this.testNoConsoleErrors())

    } finally {
      if (this.autoScreenshotter) {
        this.autoScreenshotter.stop()
      }

      await createScreencast(this.config.outputDir, {
        width: 1200,
        height: 800,
        finalFrameSeconds: 2,
      })

      if (this.browser) {
        await this.browser.close()
      }
    }

    this.printResults()
  }

  private printResults(): void {
    console.log('\n' + '='.repeat(60))
    console.log('Test Results')
    console.log('='.repeat(60))

    const passed = this.results.filter(r => r.passed).length
    const failed = this.results.filter(r => !r.passed).length

    for (const result of this.results) {
      const status = result.passed ? 'PASS' : 'FAIL'
      const icon = result.passed ? '' : ''
      console.log(`${icon} [${status}] ${result.name} (${result.duration}ms)`)
      if (result.details) console.log(`         ${result.details}`)
      if (result.error) console.log(`         Error: ${result.error}`)
    }

    console.log('\n' + '-'.repeat(60))
    console.log(`Total: ${this.results.length} | Passed: ${passed} | Failed: ${failed}`)
    console.log(`Screenshots: ${this.config.screenshotsDir}`)
    console.log(`Screencast: ${join(this.config.outputDir, 'screencast.gif')}`)
    console.log('-'.repeat(60) + '\n')

    if (failed > 0) {
      process.exit(1)
    }
  }
}

function parseArgs(): TestConfig {
  const config = { ...DEFAULT_CONFIG }
  const args = process.argv.slice(2)

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
        config.baseUrl = args[++i]
        break
      case '--user':
        config.username = args[++i]
        break
      case '--pass':
        config.password = args[++i]
        break
      case '--no-headless':
        config.headless = false
        break
      case '--headless':
        config.headless = true
        break
      case '--help':
        console.log(`
Usage: bun run scripts/test-settings.ts [options]

Options:
  --url <url>       Base URL (default: http://localhost:5001)
  --user <user>     Basic auth username
  --pass <pass>     Basic auth password
  --no-headless     Run with visible browser
  --headless        Run in headless mode (default in CI)
  --help            Show this help

Environment variables:
  OPENCODE_URL      Base URL
  OPENCODE_USER     Basic auth username
  OPENCODE_PASS     Basic auth password
  CI                Set to 'true' for headless mode
`)
        process.exit(0)
    }
  }

  return config
}

async function main() {
  const config = parseArgs()
  const test = new SettingsTest(config)
  await test.runAllTests()
}

main().catch((error) => {
  console.error('Test failed with error:', error)
  process.exit(1)
})
