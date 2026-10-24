import { zoomVisibilitySteps } from '../semanticZoom'
import { useEffect, useRef, useState } from 'react'
import type { DbSystem, DbFile, DbInfraNode, DbDependency, FloorLayout } from '../../../shared/types'
import { numericGeometryInputSteps, type FloorGeometryInput, type GeneratedPlacement, type PreparedFloorGeometry } from './sceneGeometry'
import type { SceneController } from './sceneController'
import { beginPerfStage } from '../perfTrace'
import { runSceneSteps } from './sceneSteps'
import { projectFloorNodeSteps } from '../floorSceneProjection'
import type { Node } from '@xyflow/react'
import { sameGeometryInputSteps } from './sceneInputs'

export interface FloorModel {
  systems: DbSystem[]; files: DbFile[]; infraNodes: DbInfraNode[]
  dependencies: DbDependency[]; layouts: FloorLayout[]; scope: string
}
export function usePreparedFloorGeometry(controller: SceneController, channel: string, input: FloorModel | null, placements: Map<string, GeneratedPlacement>, retry: number, currentZoom: () => number = () => 0.5, visibilityZoom?: () => number) {
  const [state, setState] = useState<{ input: FloorModel; geometry: PreparedFloorGeometry; nodes: Node[] } | null>(null)
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
    if (!input) { cached.current = undefined; controller.cancel(channel); setState(null); setError(null); return }
    setState(previous => previous?.input.scope === input.scope ? previous : null)
    const abort = new AbortController()
    setError(null)
    void (async () => {
      const finishNumeric = beginPerfStage('scene.numeric-input')
      let numeric: FloorGeometryInput
      try { numeric = await runSceneSteps(numericGeometryInputSteps(input.systems, input.files, input.infraNodes, input.dependencies, input.layouts, placements), abort.signal) }
      finally { finishNumeric() }
      if (abort.signal.aborted) return
      let entry = cached.current
      if (!entry || entry.controller !== controller || entry.scope !== input.scope || !await runSceneSteps(sameGeometryInputSteps(entry.input, numeric), abort.signal)) {
        if (abort.signal.aborted) return
        entry = { controller, scope: input.scope, input: numeric, promise: controller.prepare(channel, numeric) }
        cached.current = entry
      }
      const geometry = await entry.promise
      if (abort.signal.aborted) return
      const finishProjection = beginPerfStage('scene.floor-projection', geometry.descriptors.length)
      let nodes: Node[]
      try { nodes = await runSceneSteps(projectFloorNodeSteps({ ...input, ...geometry, currentZoom: currentZoom() }), abort.signal) }
      finally { finishProjection() }
      if (visibilityZoom) nodes = await runSceneSteps(zoomVisibilitySteps(nodes, visibilityZoom()), abort.signal)
      if (abort.signal.aborted) return
      // Only a complete current projection may publish or remember guesses.
      placements.clear()
      for (const [id, value] of geometry.generatedPlacements) placements.set(id, value)
      entry.input.placements = new Map(placements)
      setState({ input, geometry, nodes })
    })().catch(error => {
      if (!abort.signal.aborted && error.name !== 'AbortError') setError(error.message)
    })
    return () => { abort.abort() }
  }, [controller, channel, input, placements, retry])
  const coherent = state?.input.scope === input?.scope ? state : null
  return { value: coherent, current: coherent?.input === input, pending: Boolean(input && coherent?.input !== input && !error), error }
}
