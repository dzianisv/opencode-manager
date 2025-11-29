import { useState, useRef, useCallback, useEffect } from 'react'
import { useSettings } from './useSettings'
import { API_BASE_URL } from '@/config'

const TTS_CACHE_NAME = 'tts-audio-cache'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

function generateCacheKey(text: string, voice: string, model: string, speed: number): string {
  const data = `${text}|${voice}|${model}|${speed}`
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

function isCacheApiAvailable(): boolean {
  return typeof caches !== 'undefined'
}

async function getCachedAudio(cacheKey: string): Promise<Blob | null> {
  if (!isCacheApiAvailable()) return null
  
  try {
    const cache = await caches.open(TTS_CACHE_NAME)
    const response = await cache.match(cacheKey)
    
    if (!response) return null
    
    const cachedAt = response.headers.get('x-cached-at')
    if (cachedAt && Date.now() - parseInt(cachedAt) > CACHE_TTL_MS) {
      await cache.delete(cacheKey)
      return null
    }
    
    return await response.blob()
  } catch {
    return null
  }
}

async function cacheAudio(cacheKey: string, blob: Blob): Promise<void> {
  if (!isCacheApiAvailable()) return
  
  try {
    const cache = await caches.open(TTS_CACHE_NAME)
    const headers = new Headers({
      'Content-Type': 'audio/mpeg',
      'x-cached-at': Date.now().toString(),
    })
    const response = new Response(blob, { headers })
    await cache.put(cacheKey, response)
  } catch {
    // Cache API not available or storage full, continue without caching
  }
}

export type TTSState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export function useTTS() {
  const { preferences } = useSettings()
  const [state, setState] = useState<TTSState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [currentText, setCurrentText] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const ttsConfig = preferences?.tts
  const isEnabled = ttsConfig?.enabled && ttsConfig?.apiKey

  const cleanup = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => cleanup()
  }, [cleanup])

  const speak = useCallback(async (text: string) => {
    if (!ttsConfig?.enabled) {
      setError('TTS is not enabled in settings')
      setState('error')
      return
    }

    if (!ttsConfig?.apiKey) {
      setError('TTS API key is not configured')
      setState('error')
      return
    }

    if (!text?.trim()) {
      setError('No text provided for speech')
      setState('error')
      return
    }

    cleanup()
    setError(null)
    setCurrentText(text)
    setState('loading')

    try {
      const { voice, model, speed } = ttsConfig
      
      if (!voice || !model) {
        throw new Error('TTS voice or model not configured')
      }
      
      const cacheKey = generateCacheKey(text, voice, model, speed ?? 1)
      
      let audioBlob = await getCachedAudio(cacheKey)
      
      if (!audioBlob) {
        abortControllerRef.current = new AbortController()
        
        let response: Response
        try {
          response = await fetch(`${API_BASE_URL}/api/tts/synthesize`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text }),
            signal: abortControllerRef.current.signal,
          })
        } catch (fetchError) {
          if (fetchError instanceof Error && fetchError.name === 'AbortError') {
            throw fetchError
          }
          throw new Error('Failed to connect to TTS service')
        }

        if (!response.ok) {
          let errorMessage = 'TTS request failed'
          try {
            const errorData = await response.json()
            errorMessage = errorData.error || errorData.details || errorMessage
          } catch {
            if (response.status === 401) {
              errorMessage = 'Invalid TTS API key'
            } else if (response.status === 429) {
              errorMessage = 'TTS rate limit exceeded'
            } else if (response.status >= 500) {
              errorMessage = 'TTS service unavailable'
            }
          }
          throw new Error(errorMessage)
        }

        const contentType = response.headers.get('content-type')
        if (!contentType?.includes('audio')) {
          throw new Error('Invalid response from TTS service')
        }

        audioBlob = await response.blob()
        
        if (audioBlob.size === 0) {
          throw new Error('Empty audio response from TTS service')
        }
        
        await cacheAudio(cacheKey, audioBlob)
      }

      const audioUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio(audioUrl)
      audioRef.current = audio

      audio.onplay = () => setState('playing')
      audio.onpause = () => {
        if (audio.currentTime < audio.duration) {
          setState('paused')
        }
      }
      audio.onended = () => {
        setState('idle')
        setCurrentText(null)
        URL.revokeObjectURL(audioUrl)
      }
      audio.onerror = () => {
        const mediaError = audio.error
        let errorMessage = 'Audio playback failed'
        if (mediaError) {
          switch (mediaError.code) {
            case MediaError.MEDIA_ERR_ABORTED:
              errorMessage = 'Audio playback was aborted'
              break
            case MediaError.MEDIA_ERR_NETWORK:
              errorMessage = 'Network error during audio playback'
              break
            case MediaError.MEDIA_ERR_DECODE:
              errorMessage = 'Audio decoding failed'
              break
            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
              errorMessage = 'Audio format not supported'
              break
          }
        }
        setError(errorMessage)
        setState('error')
        URL.revokeObjectURL(audioUrl)
      }

      await audio.play()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setState('idle')
        return
      }
      setError(err instanceof Error ? err.message : 'TTS failed')
      setState('error')
    }
  }, [ttsConfig, cleanup])

  const stop = useCallback(() => {
    cleanup()
    setState('idle')
    setCurrentText(null)
    setError(null)
  }, [cleanup])

  const pause = useCallback(() => {
    if (audioRef.current && state === 'playing') {
      audioRef.current.pause()
    }
  }, [state])

  const resume = useCallback(() => {
    if (audioRef.current && state === 'paused') {
      audioRef.current.play()
    }
  }, [state])

  const toggle = useCallback(() => {
    if (state === 'playing') {
      pause()
    } else if (state === 'paused') {
      resume()
    }
  }, [state, pause, resume])

  return {
    speak,
    stop,
    pause,
    resume,
    toggle,
    state,
    error,
    currentText,
    isEnabled,
    isPlaying: state === 'playing',
    isLoading: state === 'loading',
    isPaused: state === 'paused',
    isIdle: state === 'idle',
  }
}
