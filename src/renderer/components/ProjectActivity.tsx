import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { archdApi } from '../archdEndpoint'
import { emitCommand, useCommandHandlers } from '../app/commands'
import { useGraphStore } from '../store/graphStore'
import { raiseFailure, resolveInterruption, useInterruptionStore } from '../store/interruptionStore'

/** Routine updates stay quiet. Only a long read or lost live updates needs space. */
export function ProjectActivity({ workspaceId }: { workspaceId: string }) {
  const { reading, progress, connection } = useGraphStore(useShallow(state => ({
    reading: state.isIndexing,
    progress: state.indexingProgress,
    connection: state.connectionStatus,
  })))
  const serviceIssue = useInterruptionStore(state => state.items.some(item => item.id === 'archd-status' || item.id === 'archd-failed'))
  const [showReading, setShowReading] = useState(false)
  const stopping = useRef(false)
  const readingStartedAt = useRef(Date.now())
  const stop = async () => {
    if (!reading || stopping.current) return
    stopping.current = true
    try {
      const response = await fetch(`${archdApi()}/api/workspace-index-cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }),
      })
      if (!response.ok) throw new Error(`Request failed (${response.status}).`)
      resolveInterruption('map-reading-stop')
    } catch {
      if (useGraphStore.getState().currentProject?.id === workspaceId) {
        raiseFailure('map-reading-stop', 'Could not stop reading the project', 'Try again, or check Project Settings for folders to leave out.', [
          { label: 'Try again', run: stop },
          { label: 'Project Settings', run: () => emitCommand('project.settings') },
        ])
      }
    } finally { stopping.current = false }
  }
  useCommandHandlers({ 'project.stopIndexing': () => { void stop() } })

  useEffect(() => {
    if (!reading) { setShowReading(false); resolveInterruption('map-reading-stop'); return }
    readingStartedAt.current = Date.now()
    const timer = setTimeout(() => setShowReading(true), 1500)
    return () => clearTimeout(timer)
  }, [reading])

  useEffect(() => {
    if (!reading || !showReading) { resolveInterruption('map-reading'); return }
    useInterruptionStore.getState().raise({
      id: 'map-reading', kind: 'progress', title: 'Updating your map…', body: 'Reading project files.',
      createdAt: readingStartedAt.current, dismissible: false,
      progress: progress && progress.total > 0 ? { value: Math.max(0, Math.min(progress.indexed, progress.total)), max: progress.total } : undefined,
      actions: [{ label: 'Stop', run: stop }],
    })
  }, [reading, showReading, progress, workspaceId])

  useEffect(() => {
    if (connection === 'connected' || serviceIssue) { resolveInterruption('map-connection'); return }
    const timer = setTimeout(() => {
      // Startup can finish while a delayed warning is queued. Recheck the
      // authoritative state before surfacing a problem that already resolved.
      const current = useGraphStore.getState()
      if (current.currentProject?.id !== workspaceId || current.connectionStatus === 'connected') return
      if (useInterruptionStore.getState().items.some(item => item.id === 'archd-status' || item.id === 'archd-failed')) return
      raiseFailure('map-connection', 'Your map isn’t updating', 'Reconnecting automatically. Your last map is still visible.', [
        { label: 'Try again', run: () => { void window.ambio?.restartArchd() } },
        { label: 'Diagnostics', run: () => emitCommand('help.copyDiagnostics') },
      ])
    }, 3000)
    return () => clearTimeout(timer)
  }, [connection, serviceIssue, workspaceId])

  useEffect(() => () => {
    resolveInterruption('map-reading')
    resolveInterruption('map-connection')
    resolveInterruption('map-reading-stop')
  }, [])
  return null
}
