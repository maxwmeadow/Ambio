import { useLayoutEffect, useRef } from 'react'

/** A focused inline field normally saves on blur. Browser removal does not
 * dispatch blur, so finish that same edit before viewport/semantic culling
 * detaches its DOM. Layout cleanup runs while the input is still connected. */
export function useCommitOnUnmount(commit: () => void) {
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef(commit)
  latest.current = commit
  useLayoutEffect(() => () => {
    // React suppresses synthetic blur during deletion. Call the same commit
    // directly, using the latest draft rather than the mount-time closure.
    if (input.current === document.activeElement) latest.current()
  }, [])
  return input
}
