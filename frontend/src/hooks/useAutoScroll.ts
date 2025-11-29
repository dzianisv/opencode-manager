import { useRef, useEffect, useCallback } from 'react'

const SCROLL_THRESHOLD = 100

interface UseAutoScrollOptions {
  containerRef?: React.RefObject<HTMLDivElement | null>
  dependency?: unknown
  onScrollStateChange?: (isScrolledUp: boolean) => void
}

interface UseAutoScrollReturn {
  scrollToBottom: () => void
  setFollowing: (following: boolean) => void
  isFollowing: () => boolean
}

export function useAutoScroll({
  containerRef,
  dependency,
  onScrollStateChange
}: UseAutoScrollOptions): UseAutoScrollReturn {
  const isFollowingRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)

  const scrollToBottom = useCallback(() => {
    if (!containerRef?.current) return
    isProgrammaticScrollRef.current = true
    containerRef.current.scrollTop = containerRef.current.scrollHeight
    isFollowingRef.current = true
    onScrollStateChange?.(false)
  }, [containerRef, onScrollStateChange])

  const setFollowing = useCallback((following: boolean) => {
    isFollowingRef.current = following
  }, [])

  const isFollowing = useCallback(() => {
    return isFollowingRef.current
  }, [])

  useEffect(() => {
    isFollowingRef.current = true
  }, [dependency])

  useEffect(() => {
    if (!containerRef?.current) return
    
    const container = containerRef.current
    
    const handleScroll = () => {
      if (isProgrammaticScrollRef.current) {
        isProgrammaticScrollRef.current = false
        return
      }
      
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      const isScrolledUp = distanceFromBottom > SCROLL_THRESHOLD
      
      if (isScrolledUp) {
        isFollowingRef.current = false
      }
      
      onScrollStateChange?.(isScrolledUp)
    }
    
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [containerRef, onScrollStateChange])

  return { scrollToBottom, setFollowing, isFollowing }
}
