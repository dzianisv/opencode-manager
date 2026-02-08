import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export function hasFfmpeg(): boolean {
  try {
    const result = spawnSync('which', ['ffmpeg'], { stdio: 'pipe' })
    return result.status === 0
  } catch {
    return false
  }
}

interface Screenshot {
  path: string
  name: string
  timestamp: number
}

interface VideoRecorderOptions {
  width?: number
  height?: number
  fps?: number
  secondsPerFrame?: number
  maxScreenshots?: number
  outputName?: string
  finalFrameSeconds?: number
  deduplicate?: boolean
  similarityThreshold?: number
}

interface CreateVideoResult {
  success: boolean
  videoPath?: string
  error?: string
  size?: number
  sizeMB?: number
  duration?: number
  frameCount?: number
  screenshotCount?: number
}

export class VideoRecorder {
  private testDir: string
  private screenshotsDir: string
  private framesDir: string
  private options: {
    width: number
    height: number
    fps: number
    maxScreenshots: number
    outputName: string
    finalFrameSeconds: number
    deduplicate: boolean
    similarityThreshold: number
  }
  private screenshots: Screenshot[] = []
  private frameCount = 0

  constructor(testDir: string, options: VideoRecorderOptions = {}) {
    this.testDir = testDir
    this.screenshotsDir = join(testDir, 'screenshots')
    this.framesDir = join(testDir, 'gif-frames')

    let fps = options.fps || 1
    if (options.secondsPerFrame) {
      fps = 1 / options.secondsPerFrame
    }

    this.options = {
      width: options.width || 1200,
      height: options.height || 800,
      fps,
      maxScreenshots: options.maxScreenshots || 50,
      outputName: options.outputName || 'screencast.gif',
      finalFrameSeconds: options.finalFrameSeconds ?? 3,
      deduplicate: options.deduplicate !== false,
      similarityThreshold: options.similarityThreshold || 0.95
    }
  }

  addScreenshot(screenshotPath: string, name: string, metadata: { timestamp?: number } = {}): void {
    this.screenshots.push({
      path: screenshotPath,
      name,
      timestamp: metadata.timestamp || Date.now()
    })
  }

  private getFileHash(filePath: string): string {
    const content = readFileSync(filePath)
    return createHash('md5').update(content).digest('hex')
  }

  private getPerceptualHash(filePath: string, size = 16): string {
    try {
      const result = spawnSync('ffmpeg', [
        '-i', filePath,
        '-vf', `scale=${size}:${size}:flags=area`,
        '-pix_fmt', 'gray',
        '-f', 'rawvideo',
        '-'
      ], { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: size * size * 4 })

      if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
        return this.getFileHash(filePath)
      }

      return createHash('md5').update(result.stdout).digest('hex')
    } catch {
      return this.getFileHash(filePath)
    }
  }

  private areImagesSimilar(filePath1: string, filePath2: string, threshold = 0.95): boolean {
    const size = 32

    try {
      const getPixels = (filePath: string): Buffer | null => {
        const result = spawnSync('ffmpeg', [
          '-i', filePath,
          '-vf', `scale=${size}:${size}:flags=area`,
          '-pix_fmt', 'gray',
          '-f', 'rawvideo',
          '-'
        ], { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: size * size * 4 })

        return result.status === 0 ? result.stdout : null
      }

      const pixels1 = getPixels(filePath1)
      const pixels2 = getPixels(filePath2)

      if (!pixels1 || !pixels2 || pixels1.length !== pixels2.length) {
        return this.getFileHash(filePath1) === this.getFileHash(filePath2)
      }

      let matchingPixels = 0
      const pixelTolerance = 10

      for (let i = 0; i < pixels1.length; i++) {
        if (Math.abs(pixels1[i] - pixels2[i]) <= pixelTolerance) {
          matchingPixels++
        }
      }

      const similarity = matchingPixels / pixels1.length
      return similarity >= threshold
    } catch {
      return this.getFileHash(filePath1) === this.getFileHash(filePath2)
    }
  }

  private deduplicateScreenshots(screenshots: Screenshot[]): Screenshot[] {
    if (!this.options.deduplicate || screenshots.length === 0) {
      return screenshots
    }

    const deduplicated: Screenshot[] = []
    let lastFilePath: string | null = null

    for (const screenshot of screenshots) {
      if (!screenshot.path || !existsSync(screenshot.path)) {
        deduplicated.push(screenshot)
        lastFilePath = null
        continue
      }

      if (lastFilePath && this.areImagesSimilar(lastFilePath, screenshot.path, this.options.similarityThreshold)) {
        continue
      }

      deduplicated.push(screenshot)
      lastFilePath = screenshot.path
    }

    if (deduplicated.length < screenshots.length) {
      console.log(`Deduplicated: ${screenshots.length} → ${deduplicated.length} screenshots (removed ${screenshots.length - deduplicated.length} similar frames)`)
    }

    return deduplicated
  }

  collectScreenshots(): void {
    if (!existsSync(this.screenshotsDir)) {
      console.warn(`Screenshots directory not found: ${this.screenshotsDir}`)
      return
    }

    const files = readdirSync(this.screenshotsDir)
      .filter(f => f.endsWith('.png'))
      .sort()

    const allScreenshots: Screenshot[] = []
    for (const file of files) {
      const filePath = join(this.screenshotsDir, file)
      const stats = statSync(filePath)
      const name = file.replace(/^\d+_/, '').replace(/\.png$/, '')

      allScreenshots.push({
        path: filePath,
        name,
        timestamp: stats.mtime.getTime()
      })
    }

    const deduplicated = this.deduplicateScreenshots(allScreenshots)

    for (const screenshot of deduplicated) {
      this.addScreenshot(screenshot.path, screenshot.name, {
        timestamp: screenshot.timestamp
      })
    }

    console.log(`Collected ${this.screenshots.length} screenshots`)
  }

  private sampleScreenshots(): Screenshot[] {
    if (this.screenshots.length <= this.options.maxScreenshots) {
      return this.screenshots
    }

    const sampled = [this.screenshots[0]]
    const step = (this.screenshots.length - 1) / (this.options.maxScreenshots - 1)

    for (let i = 1; i < this.options.maxScreenshots - 1; i++) {
      const index = Math.round(i * step)
      sampled.push(this.screenshots[index])
    }

    sampled.push(this.screenshots[this.screenshots.length - 1])

    console.log(`Sampled ${sampled.length} from ${this.screenshots.length} screenshots`)
    return sampled
  }

  async createVideo(): Promise<CreateVideoResult> {
    if (!hasFfmpeg()) {
      return {
        success: false,
        error: 'ffmpeg not found. Install with: brew install ffmpeg'
      }
    }

    if (this.screenshots.length === 0) {
      this.collectScreenshots()
    }

    if (this.screenshots.length === 0) {
      return {
        success: false,
        error: 'No screenshots to create GIF from'
      }
    }

    if (existsSync(this.framesDir)) {
      rmSync(this.framesDir, { recursive: true })
    }
    mkdirSync(this.framesDir, { recursive: true })

    const screenshotsToUse = this.sampleScreenshots()

    for (const screenshot of screenshotsToUse) {
      if (!existsSync(screenshot.path)) {
        console.warn(`Screenshot not found: ${screenshot.path}`)
        continue
      }

      const framePath = join(this.framesDir, `frame_${String(this.frameCount).padStart(5, '0')}.png`)

      const scaleResult = spawnSync('ffmpeg', [
        '-y',
        '-i', screenshot.path,
        '-vf', `scale=${this.options.width}:${this.options.height}:force_original_aspect_ratio=decrease,pad=${this.options.width}:${this.options.height}:(ow-iw)/2:(oh-ih)/2:white`,
        '-frames:v', '1',
        framePath
      ], { stdio: 'pipe' })

      if (scaleResult.status !== 0) {
        copyFileSync(screenshot.path, framePath)
      }

      this.frameCount++
    }

    console.log(`Created ${this.frameCount} frames from ${screenshotsToUse.length} screenshots`)

    if (this.frameCount > 0 && this.options.finalFrameSeconds > 0) {
      const lastFramePath = join(this.framesDir, `frame_${String(this.frameCount - 1).padStart(5, '0')}.png`)
      if (existsSync(lastFramePath)) {
        const extraFrames = Math.ceil(this.options.finalFrameSeconds * this.options.fps) - 1
        for (let i = 0; i < extraFrames; i++) {
          const dupFramePath = join(this.framesDir, `frame_${String(this.frameCount).padStart(5, '0')}.png`)
          copyFileSync(lastFramePath, dupFramePath)
          this.frameCount++
        }
        console.log(`Added ${extraFrames} duplicate frames for ${this.options.finalFrameSeconds}s final hold`)
      }
    }

    const outputPath = join(this.testDir, this.options.outputName)
    const palettePath = join(this.framesDir, 'palette.png')

    const paletteResult = spawnSync('ffmpeg', [
      '-y',
      '-framerate', String(this.options.fps),
      '-i', join(this.framesDir, 'frame_%05d.png'),
      '-vf', 'palettegen=max_colors=256:stats_mode=diff',
      palettePath
    ], { stdio: 'pipe' })

    if (paletteResult.status !== 0) {
      console.log('Palette generation failed, using single-pass')
      const simpleResult = spawnSync('ffmpeg', [
        '-y',
        '-framerate', String(this.options.fps),
        '-i', join(this.framesDir, 'frame_%05d.png'),
        '-vf', `scale=${this.options.width}:-1:flags=lanczos`,
        outputPath
      ], { stdio: 'pipe' })

      if (simpleResult.status !== 0) {
        const stderr = simpleResult.stderr?.toString() || 'Unknown error'
        try { rmSync(this.framesDir, { recursive: true }) } catch {}
        return {
          success: false,
          error: `ffmpeg failed: ${stderr.substring(0, 500)}`
        }
      }
    } else {
      const gifResult = spawnSync('ffmpeg', [
        '-y',
        '-framerate', String(this.options.fps),
        '-i', join(this.framesDir, 'frame_%05d.png'),
        '-i', palettePath,
        '-lavfi', 'paletteuse=dither=sierra2_4a:diff_mode=rectangle:new=1',
        outputPath
      ], { stdio: 'pipe' })

      if (gifResult.status !== 0) {
        const stderr = gifResult.stderr?.toString() || 'Unknown error'
        try { rmSync(this.framesDir, { recursive: true }) } catch {}
        return {
          success: false,
          error: `ffmpeg GIF creation failed: ${stderr.substring(0, 500)}`
        }
      }
    }

    try {
      rmSync(this.framesDir, { recursive: true })
    } catch {}

    const stats = statSync(outputPath)
    const sizeMB = parseFloat((stats.size / 1024 / 1024).toFixed(2))
    const durationSec = this.frameCount / this.options.fps

    console.log(`GIF created: ${outputPath}`)
    console.log(`  Size: ${sizeMB} MB`)
    console.log(`  Duration: ${durationSec.toFixed(1)} seconds`)
    console.log(`  Frames: ${this.frameCount}`)

    return {
      success: true,
      videoPath: outputPath,
      size: stats.size,
      sizeMB,
      duration: durationSec,
      frameCount: this.frameCount,
      screenshotCount: this.screenshots.length
    }
  }

  static async fromTestDirectory(testDir: string, options: VideoRecorderOptions = {}): Promise<CreateVideoResult> {
    const recorder = new VideoRecorder(testDir, options)
    recorder.collectScreenshots()
    return recorder.createVideo()
  }
}

export interface AutoScreenshotOptions {
  browser: any
  page: any
  screenshotsDir: string
  intervalMs?: number
  onScreenshot?: (path: string, count: number) => void
}

export class AutoScreenshotter {
  private browser: any
  private page: any
  private screenshotsDir: string
  private intervalMs: number
  private onScreenshot?: (path: string, count: number) => void
  private running = false
  private timer: NodeJS.Timeout | null = null
  private count = 0

  constructor(options: AutoScreenshotOptions) {
    this.browser = options.browser
    this.page = options.page
    this.screenshotsDir = options.screenshotsDir
    this.intervalMs = options.intervalMs || 1000
    this.onScreenshot = options.onScreenshot
  }

  start(): void {
    if (this.running) return
    this.running = true
    console.log(`Starting auto-screenshot every ${this.intervalMs}ms`)
    this.capture()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    console.log(`Stopped auto-screenshot (captured ${this.count} screenshots)`)
  }

  private async capture(): Promise<void> {
    if (!this.running || !this.page) return

    try {
      const filename = `${String(this.count).padStart(3, '0')}_auto.png`
      const filepath = join(this.screenshotsDir, filename)
      await this.page.screenshot({ path: filepath, fullPage: false })
      this.count++
      
      if (this.onScreenshot) {
        this.onScreenshot(filepath, this.count)
      }
    } catch (e) {
      if ((e as Error).message?.includes('Target closed') || (e as Error).message?.includes('Session closed')) {
        this.stop()
        return
      }
    }

    if (this.running) {
      this.timer = setTimeout(() => this.capture(), this.intervalMs)
    }
  }

  getCount(): number {
    return this.count
  }
}

export default VideoRecorder
