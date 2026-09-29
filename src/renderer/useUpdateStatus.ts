import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../electron/preload'

/** The app's update state, current on mount and live afterwards. */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    if (!window.axiom?.onUpdateStatus) return
    let active = true
    void window.axiom.getUpdateStatus().then(current => { if (active) setStatus(current) })
    const unsubscribe = window.axiom.onUpdateStatus(setStatus)
    return () => { active = false; unsubscribe() }
  }, [])
  return status
}
