import { Page } from 'puppeteer'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { VideoRecorder, AutoScreenshotter, type AutoScreenshotOptions } from './video-recorder'

export interface TestOutputDirs {
  outputDir: string
  screenshotsDir: string
}

export function createTestOutputDir(testName: string): TestOutputDirs {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outputDir = join(process.cwd(), '.test', `${testName}-${timestamp}`)
  const screenshotsDir = join(outputDir, 'screenshots')
  mkdirSync(screenshotsDir, { recursive: true })
  return { outputDir, screenshotsDir }
}

let screenshotCounter = 0

export function resetScreenshotCounter(): void {
  screenshotCounter = 0
}

export async function takeScreenshot(page: Page, name: string, screenshotsDir: string): Promise<void> {
  screenshotCounter++
  const filename = `${String(screenshotCounter).padStart(2, '0')}_${name.replace(/\s+/g, '_')}.png`
  const filepath = join(screenshotsDir, filename)
  await page.screenshot({ path: filepath, fullPage: false })
  log(`Screenshot: ${filename}`, 1)
}

export function log(message: string, indent = 0): void {
  const prefix = '  '.repeat(indent)
  const timestamp = new Date().toISOString().slice(11, 19)
  console.log(`[${timestamp}] ${prefix}${message}`)
}

export function success(message: string): void {
  log(`PASS ${message}`)
}

export function fail(message: string): void {
  log(`FAIL ${message}`)
}

export function info(message: string): void {
  log(`INFO ${message}`)
}

export interface ScreencastOptions {
  width?: number
  height?: number
  secondsPerFrame?: number
  finalFrameSeconds?: number
  deduplicate?: boolean
}

export async function createScreencast(outputDir: string, options: ScreencastOptions = {}): Promise<void> {
  info('Creating screencast GIF...')
  const result = await VideoRecorder.fromTestDirectory(outputDir, {
    outputName: 'screencast.gif',
    secondsPerFrame: options.secondsPerFrame ?? 0.5,
    finalFrameSeconds: options.finalFrameSeconds ?? 3,
    deduplicate: options.deduplicate !== false,
    width: options.width ?? 1280,
    height: options.height ?? 800,
  })

  if (result.success) {
    success(`Screencast: ${result.videoPath} (${result.sizeMB} MB, ${result.duration?.toFixed(1)}s)`)
  } else {
    log(`Screencast creation failed: ${result.error}`, 1)
  }
}

export { AutoScreenshotter, VideoRecorder }
export type { AutoScreenshotOptions }
