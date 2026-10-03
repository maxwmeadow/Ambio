import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../electron/preload'

/** The app's update state, current on mount and live afterwards. */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    if (!window.ambio?.onUpdateStatus) return
    let active = true
    void window.ambio.getUpdateStatus().then(current => { if (active) setStatus(current) })
    const unsubscribe = window.ambio.onUpdateStatus(setStatus)
    return () => { active = false; unsubscribe() }
  }, [])
  return status
}
