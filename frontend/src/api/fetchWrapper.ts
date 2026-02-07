export class FetchError extends Error {
  statusCode?: number
  code?: string

  constructor(message: string, statusCode?: number, code?: string) {
    super(message)
    this.name = 'FetchError'
    this.statusCode = statusCode
    this.code = code
  }
}

interface ApiError {
  error?: string
  code?: string
  message?: string
}

interface FetchWrapperOptions extends RequestInit {
  timeout?: number
  params?: Record<string, string | number | boolean | undefined | unknown>
}

async function handleResponse(response: Response): Promise<never> {
  const data: ApiError = await response.json().catch(() => ({ error: 'An error occurred' }))
  throw new FetchError(data.error || data.message || 'Request failed', response.status, data.code)
}

async function fetchWrapper<T = unknown>(
  url: string,
  options: FetchWrapperOptions = {}
): Promise<T> {
  const { timeout = 30000, params, ...fetchOptions } = options

  const urlObj = new URL(url, window.location.origin)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        urlObj.searchParams.append(key, String(value))
      }
    })
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(urlObj.toString(), {
      ...fetchOptions,
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      await handleResponse(response)
    }

    return response.json()
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FetchError('Request timeout', 408, 'TIMEOUT')
    }
    throw error
  }
}

async function fetchWrapperBlob(
  url: string,
  options: FetchWrapperOptions = {}
): Promise<Blob> {
  const { timeout = 30000, params, ...fetchOptions } = options

  const urlObj = new URL(url, window.location.origin)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        urlObj.searchParams.append(key, String(value))
      }
    })
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(urlObj.toString(), {
      ...fetchOptions,
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      await handleResponse(response)
    }

    return response.blob()
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FetchError('Request timeout', 408, 'TIMEOUT')
    }
    throw error
  }
}

export { fetchWrapper, fetchWrapperBlob }
