import { useMemo } from 'react'

interface PathDisplayProps {
  path: string
  maxSegments?: number
  className?: string
}

export function PathDisplay({ path, maxSegments = 3, className = '' }: PathDisplayProps) {
  const displayPath = useMemo(() => {
    if (!path || path === '/') return '/'
    
    const normalizedPath = path.startsWith('/') ? path : '/' + path
    const segments = normalizedPath.split('/').filter(Boolean)
    
    if (segments.length <= maxSegments) {
      return '/' + segments.join('/')
    }
    
    const visibleSegments = segments.slice(-maxSegments)
    return '/.../' + visibleSegments.join('/')
  }, [path, maxSegments])

  return (
    <span 
      className={`text-sm text-muted-foreground bg-muted px-2 py-1 rounded font-mono truncate ${className}`}
      title={path}
    >
      {displayPath}
    </span>
  )
}
