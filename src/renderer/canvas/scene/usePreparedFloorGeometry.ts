import { useEffect, useRef, useState } from 'react'
import type { DbSystem, DbFile, DbInfraNode, DbDependency, FloorLayout } from '../../../shared/types'
import { numericGeometryInput, type FloorGeometryInput, type GeneratedPlacement, type PreparedFloorGeometry } from './sceneGeometry'
import type { SceneController } from './sceneController'
import { traceSync } from '../perfTrace'
import { sameGeometryInput } from './sceneInputs'

export interface FloorModel {
  systems: DbSystem[]; files: DbFile[]; infraNodes: DbInfraNode[]
  dependencies: DbDependency[]; layouts: FloorLayout[]; scope: string
}
export function usePreparedFloorGeometry(controller: SceneController, channel: string, input: FloorModel | null, placements: Map<string, GeneratedPlacement>, retry: number) {
  const [state, setState] = useState<{ input: FloorModel; geometry: PreparedFloorGeometry } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cached = useRef<{ controller: SceneController; scope: string; input: FloorGeometryInput; promise: Promise<PreparedFloorGeometry> }>()
  useEffect(() => () => {
    // The cached promise belongs to this mounted controller/channel lifecycle.
    // StrictMode replays effects with refs intact: reusing the cancelled job
    // on its second setup would leave preparation pending forever.
    cached.current = undefined
    controller.cancel(channel)
  }, [controller, channel])
  useEffect(() => controller.subscribe(() => {}, () => {
    if (input) setError('Canvas preparation stopped. Retry to restart it.')
  }), [controller, input])
  useEffect(() => {
    if (!input) { cached.current = undefined; controller.cancel(channel); setError(null); return }
    let current = true
    setError(null)
    const numeric = traceSync('scene.numeric-input', () => numericGeometryInput(input.systems, input.files, input.infraNodes, input.dependencies, input.layouts, placements), input.systems.length + input.files.length + input.infraNodes.length)
    let entry = cached.current
    if (!entry || entry.controller !== controller || entry.scope !== input.scope || !sameGeometryInput(entry.input, numeric)) {
      entry = { controller, scope: input.scope, input: numeric, promise: controller.prepare(channel, numeric) }
      cached.current = entry
    }
    const accepted = entry
    void entry.promise.then(geometry => {
      if (!current) return
      // Remember guesses only from an accepted model; stale jobs never write.
      placements.clear()
      for (const [id, value] of geometry.generatedPlacements) placements.set(id, value)
      accepted.input.placements = new Map(placements)
      setState({ input, geometry })
    }).catch(error => {
      if (current && error.name !== 'AbortError') setError(error.message)
    })
    return () => { current = false }
  }, [controller, channel, input, placements, retry])
  const coherent = state?.input.scope === input?.scope ? state : null
  return { value: coherent, current: coherent?.input === input, pending: Boolean(input && coherent?.input !== input && !error), error }
}
