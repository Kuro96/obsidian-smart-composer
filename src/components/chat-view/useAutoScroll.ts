import { useCallback, useEffect, useRef } from 'react'

const PROGRAMMATIC_SCROLL_DEBOUNCE_MS = 50
const SCROLL_AWAY_FROM_BOTTOM_THRESHOLD = 20

type UseAutoScrollProps = {
  scrollContainerRef: React.RefObject<HTMLElement>
}

export function useAutoScroll({ scrollContainerRef }: UseAutoScrollProps) {
  const preventAutoScrollRef = useRef(false)
  const lastProgrammaticScrollRef = useRef<number>(0)

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    const handleScroll = () => {
      // If the scroll event happened very close to our programmatic scroll, ignore it
      if (
        Date.now() - lastProgrammaticScrollRef.current <
        PROGRAMMATIC_SCROLL_DEBOUNCE_MS
      ) {
        return
      }

      preventAutoScrollRef.current =
        scrollContainer.scrollHeight -
          scrollContainer.scrollTop -
          scrollContainer.clientHeight >
        SCROLL_AWAY_FROM_BOTTOM_THRESHOLD
    }

    scrollContainer.addEventListener('scroll', handleScroll)
    return () => scrollContainer.removeEventListener('scroll', handleScroll)
  }, [scrollContainerRef])

  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      const scrollContainer = scrollContainerRef.current

      lastProgrammaticScrollRef.current = Date.now()
      scrollContainer.scrollTop = scrollContainer.scrollHeight

      // Some content (like approval actions) can update layout in the next frame.
      // Run a second pass to avoid ending up a few pixels above the true bottom.
      requestAnimationFrame(() => {
        if (!scrollContainerRef.current) {
          return
        }
        lastProgrammaticScrollRef.current = Date.now()
        scrollContainerRef.current.scrollTop =
          scrollContainerRef.current.scrollHeight
      })
    }
  }, [scrollContainerRef])

  // Auto-scrolls to bottom only if the scroll position is near the bottom
  const autoScrollToBottom = useCallback(() => {
    if (!preventAutoScrollRef.current) {
      scrollToBottom()
    }
  }, [scrollToBottom])

  // Forces scroll to bottom regardless of current position
  const forceScrollToBottom = useCallback(() => {
    preventAutoScrollRef.current = false
    scrollToBottom()
  }, [scrollToBottom])

  return {
    autoScrollToBottom,
    forceScrollToBottom,
  }
}
