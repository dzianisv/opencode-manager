export type AudioRecorderState = 'idle' | 'recording' | 'stopped' | 'error'

export interface AudioRecorderOptions {
  sampleRate?: number
  channelCount?: number
}

const DEFAULT_OPTIONS: AudioRecorderOptions = {
  sampleRate: 16000,
  channelCount: 1,
}

function encodeWAV(audioBuffer: AudioBuffer): Blob {
  const numberOfChannels = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const format = 1
  const bitDepth = 16

  const channelData: Float32Array[] = []

  for (let i = 0; i < numberOfChannels; i++) {
    channelData.push(audioBuffer.getChannelData(i))
  }

  const interleaved = interleave(channelData)
  const dataLength = interleaved.length * (bitDepth / 8)
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, numberOfChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numberOfChannels * (bitDepth / 8), true)
  view.setUint16(32, numberOfChannels * (bitDepth / 8), true)
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataLength, true)

  floatTo16BitPCM(view, 44, interleaved)

  return new Blob([view], { type: 'audio/wav' })
}

function interleave(channelData: Float32Array[]): Float32Array {
  const length = channelData[0].length * channelData.length
  const result = new Float32Array(length)
  let offset = 0

  for (let i = 0; i < channelData[0].length; i++) {
    for (let channel = 0; channel < channelData.length; channel++) {
      result[offset++] = channelData[channel][i]
    }
  }

  return result
}

function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i))
  }
}

function floatTo16BitPCM(view: DataView, offset: number, input: Float32Array): void {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
}

export class AudioRecorder {
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private audioBuffer: Float32Array | null = null
  private recordingLength: number = 0
  private state: AudioRecorderState = 'idle'
  private options: AudioRecorderOptions
  private isAborted: boolean = false

  private onStateChange?: (state: AudioRecorderState) => void
  private onError?: (error: string) => void
  private onDataAvailable?: (blob: Blob) => void

  constructor(options: AudioRecorderOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  static isSupported(): boolean {
    return !!(
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window !== 'undefined' &&
      typeof window.AudioContext !== 'undefined'
    )
  }

  async warmup(): Promise<boolean> {
    if (!AudioRecorder.isSupported()) {
      return false
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      stream.getTracks().forEach(track => track.stop())
      return true
    } catch {
      return false
    }
  }

  getState(): AudioRecorderState {
    return this.state
  }

  setOnStateChange(callback: (state: AudioRecorderState) => void): void {
    this.onStateChange = callback
  }

  setOnError(callback: (error: string) => void): void {
    this.onError = callback
  }

  setOnDataAvailable(callback: (blob: Blob) => void): void {
    this.onDataAvailable = callback
  }

  private setState(newState: AudioRecorderState): void {
    this.state = newState
    this.onStateChange?.(newState)
  }

  async start(): Promise<void> {
    if (!AudioRecorder.isSupported()) {
      this.setState('error')
      this.onError?.('Audio recording is not supported in this browser')
      throw new Error('Audio recording is not supported in this browser')
    }

    try {
      this.isAborted = false
      this.recordingLength = 0

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      this.audioContext = new AudioContext({
        sampleRate: this.options.sampleRate,
      })

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream)

      const bufferSize = 4096
      this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1)

      this.audioBuffer = new Float32Array(0)

      this.processor.onaudioprocess = (e) => {
        if (this.audioBuffer) {
          const inputData = e.inputBuffer.getChannelData(0)
          const newLength = this.recordingLength + inputData.length
          const newBuffer = new Float32Array(newLength)
          newBuffer.set(this.audioBuffer, 0)
          newBuffer.set(inputData, this.recordingLength)
          this.audioBuffer = newBuffer
          this.recordingLength = newLength
        }
      }

      this.source.connect(this.processor)
      this.processor.connect(this.audioContext.destination)

      this.setState('recording')
    } catch (error) {
      this.setState('error')
      this.cleanup()

      if (error instanceof DOMException) {
        if (error.name === 'NotAllowedError') {
          this.onError?.('Microphone permission denied')
        } else if (error.name === 'NotFoundError') {
          this.onError?.('No microphone found')
        } else {
          this.onError?.(`Microphone error: ${error.message}`)
        }
      } else {
        this.onError?.('Failed to start recording')
      }

      throw error
    }
  }

  stop(): void {
    if (this.processor) {
      this.processRecording()
    }
    this.cleanup()
    this.setState('stopped')
  }

  abort(): void {
    this.isAborted = true
    this.audioBuffer = null
    this.recordingLength = 0
    this.cleanup()
    this.setState('idle')
  }

  private processRecording(): void {
    if (this.isAborted || !this.audioBuffer || this.recordingLength === 0) {
      return
    }

    try {
      const audioBuffer = this.audioContext!.createBuffer(
        1,
        this.recordingLength,
        this.audioContext!.sampleRate
      )

      const channelData = new Float32Array(this.recordingLength)
      channelData.set(this.audioBuffer!.subarray(0, this.recordingLength))
      audioBuffer.copyToChannel(channelData, 0)

      const wavBlob = encodeWAV(audioBuffer)
      this.onDataAvailable?.(wavBlob)
    } catch {
      this.onError?.('Failed to process recording')
      this.setState('error')
    }
  }

  private cleanup(): void {
    if (this.processor) {
      this.processor.disconnect()
      this.processor = null
    }

    if (this.source) {
      this.source.disconnect()
      this.source = null
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close()
      this.audioContext = null
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop())
      this.mediaStream = null
    }
  }

  getRecordingBlob(): Blob | null {
    if (!this.audioContext || !this.audioBuffer || this.recordingLength === 0) {
      return null
    }

    try {
      const audioBuffer = this.audioContext.createBuffer(
        1,
        this.recordingLength,
        this.audioContext.sampleRate
      )

      const channelData = new Float32Array(this.recordingLength)
      channelData.set(this.audioBuffer.subarray(0, this.recordingLength))
      audioBuffer.copyToChannel(channelData, 0)
      return encodeWAV(audioBuffer)
    } catch {
      return null
    }
  }
}

let recorderInstance: AudioRecorder | null = null

export function getAudioRecorder(): AudioRecorder {
  if (!recorderInstance) {
    recorderInstance = new AudioRecorder()
  }
  return recorderInstance
}

export function isAudioRecordingSupported(): boolean {
  return AudioRecorder.isSupported()
}

export async function warmupAudioRecorder(): Promise<boolean> {
  const recorder = getAudioRecorder()
  return recorder.warmup()
}
