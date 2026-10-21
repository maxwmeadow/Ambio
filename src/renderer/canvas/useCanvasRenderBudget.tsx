import { perfTrace, traceSync } from './perfTrace'
import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStoreApi, type Edge, type Node } from '@xyflow/react'
import { unstable_batchedUpdates } from 'react-dom'
import { createRenderBudgetStore } from './renderBudgetStore'
import { buildSceneIndex, cameraRect, contains, initialRootVisible, queryScene, sceneRecords, type CameraQuery, type SceneRecord, type ViewRect } from './renderBudgetGeometry'
import { getPerfMetrics } from './perfMetrics'

type BudgetStore = ReturnType<typeof createRenderBudgetStore>
export const RenderBudgetContext = createContext<BudgetStore | null>(null)
export function useNodeRenderTier(id: string) {
  const budget = useContext(RenderBudgetContext)
  const tier = useSyncExternalStore(
    listener => budget?.subscribe(id, listener) ?? (() => {}),
    () => budget?.tier(id) ?? 2,
  )
  return { tier, promote: () => budget?.promote(id, false) }
}

export function useCanvasRenderBudget(nodes: Node[], enabled: boolean, edges: readonly Edge[]) {
  // Initialize relationship handles even outside the viewport. Flow retains
  // their measured geometry when its component culler releases those shells.
  const edgeEndpoints = useMemo(() => new Set(edges.filter(edge => !edge.hidden && edge.style?.opacity !== 0)
    .flatMap(edge => [edge.source, edge.target])), [edges])
  const flow = useStoreApi()
  const [budget] = useState(createRenderBudgetStore)
  budget.configure(enabled)
  const [visible, setVisible] = useState<Set<string> | null>(null)
  const controller = useRef<{ update: (records: SceneRecord[]) => void } | null>(null)
  const previousRecords = useRef<SceneRecord[]>([])
  const records = useMemo(() => traceSync('scene.records', () => {
    const next = sceneRecords(nodes, previousRecords.current)
    previousRecords.current = next
    return next
  }, nodes.length), [nodes])
  const latestRecords = useRef(records); latestRecords.current = records
  const metrics = getPerfMetrics()
  const projectionCache = useRef(new Map<string, { source: Node; hidden: boolean; node: Node }>())
  const previousProjection = useRef<Node[]>([])

  useLayoutEffect(() => {
    if (!enabled) { setVisible(null); return }
    let disposed = false, scene = 0, request = 0, accepted = 0
    let queryFrame = 0, mountFrame = 0, settleTimer = 0, retainTimer = 0
    let bounds: ViewRect | null = null, indexedZoom = 0, lastMove = 0, flightUntil = 0
    let source: SceneRecord[] = [], local: ReturnType<typeof buildSceneIndex> | undefined
    let currentIds = new Set<string>()
    let worker: Worker | undefined
    const sentQueries = new Map<number, number>()
    let recent = new Map<string, number>()
    let mountLimit = 4, lastAdmissionAt = 0
    const camera = (): CameraQuery => {
      const state = flow.getState()
      return { x: state.transform[0], y: state.transform[1], zoom: state.transform[2],
        width: state.width, height: state.height, moving: performance.now() - lastMove < 120 || performance.now() < flightUntil }
    }
    const admit = () => {
      mountFrame = 0
      if (disposed) return
      const now = performance.now()
      if (lastAdmissionAt && now - lastAdmissionAt > 25) mountLimit = Math.max(1, Math.floor(mountLimit / 2))
      else mountLimit = Math.min(6, mountLimit + 1)
      let result = { count: 0, pending: 0 }
      unstable_batchedUpdates(() => { result = budget.drain(mountLimit, now + 3, performance.now.bind(performance)) })
      metrics.budgetBatches++; metrics.budgetAdmissions += result.count
      metrics.maxBudgetBatch = Math.max(metrics.maxBudgetBatch, result.count)
      lastAdmissionAt = now
      if (result.pending) mountFrame = requestAnimationFrame(admit)
    }
    const receive = (message: { scene: number; request: number; bounds: ViewRect; zoom: number; visible: Array<{ id: string; tier: 0 | 1 | 2 }> }) => {
      if (disposed || message.scene !== scene || message.request < accepted) return
      // During a fast flight, an older buffer may no longer cover the camera.
      if (!contains(message.bounds, cameraRect(camera()))) { schedule(true); return }
      accepted = message.request; bounds = message.bounds; indexedZoom = message.zoom
      const now = performance.now()
      const next = new Set(message.visible.map(r => r.id))
      for (const id of next) recent.set(id, now)
      // Keep at most one recent screenful, for a short grace period.
      const retained = [...recent].filter(([id, at]) => currentIds.has(id) && now - at < 450)
        .sort((a, b) => b[1] - a[1]).slice(0, Math.max(32, next.size * 2))
      recent = new Map(retained)
      const expiring = retained.some(([id]) => !next.has(id))
      for (const [id] of retained) next.add(id)
      setVisible(previous => previous?.size === next.size && [...next].every(id => previous.has(id)) ? previous : next)
      budget.motion(camera().moving)
      budget.desired(message.visible)
      if (!mountFrame) mountFrame = requestAnimationFrame(admit)
      clearTimeout(retainTimer)
      if (expiring) retainTimer = window.setTimeout(() => schedule(true), 470)
    }
    const query = () => {
      queryFrame = 0
      if (disposed) return
      const q = camera(), currentRequest = ++request
      budget.motion(q.moving)
      if (worker) {
        if (perfTrace.enabled()) {
          sentQueries.set(currentRequest, performance.now())
          if (sentQueries.size > 256) sentQueries.delete(sentQueries.keys().next().value!)
        }
        worker.postMessage({ op: 'query', scene, request: currentRequest, camera: q, trace: perfTrace.enabled() })
      }
      else {
        local ??= buildSceneIndex(source)
        receive({ scene, request: currentRequest, ...queryScene(local, q) })
      }
    }
    function schedule(force = false) {
      const q = camera()
      if (!force && bounds && contains(bounds, cameraRect(q, 100)) && Math.abs(Math.log(q.zoom / indexedZoom)) < .12) return
      if (!queryFrame) queryFrame = requestAnimationFrame(query)
    }
    const update = (next: SceneRecord[]) => {
      if (source === next) return
      source = next; scene++; bounds = null; local = undefined
      currentIds = new Set(next.filter(record => !record.hidden).map(record => record.id))
      if (worker) traceSync('worker.scene-post', () => worker!.postMessage({ op: 'scene', scene, records: source, trace: perfTrace.enabled() }), source.length)
      schedule(true)
    }
    try {
      if (!(globalThis as { __ambioDisableRenderWorker?: boolean }).__ambioDisableRenderWorker) {
        worker = new Worker(new URL('./renderBudget.worker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = event => {
          metrics.workerQueries++
          const sent = sentQueries.get(event.data.request)
          if (sent !== undefined) { perfTrace.record('worker.round-trip', performance.now() - sent); sentQueries.delete(event.data.request) }
          if (event.data.timing?.indexMs !== undefined) perfTrace.record('worker.index', event.data.timing.indexMs, source.length)
          if (event.data.timing?.queryMs !== undefined) perfTrace.record('worker.query', event.data.timing.queryMs)
          receive(event.data)
        }
        worker.onerror = () => { worker?.terminate(); worker = undefined; metrics.workerFallbacks++; schedule(true) }
      }
    } catch { metrics.workerFallbacks++ }
    controller.current = { update }
    update(latestRecords.current)
    const element = flow.getState().domNode
    const prewarm = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string; duration: number }>).detail
      flightUntil = performance.now() + detail.duration
      budget.promote(detail.nodeId)
      // Keep the destination admitted while the camera traverses intermediate
      // nodes. Only that target bypasses the background detail budget.
      setVisible(previous => new Set([...(previous ?? []), detail.nodeId]))
      clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => { flightUntil = 0; schedule(true) }, detail.duration + 140)
    }
    const interrupt = () => { flightUntil = 0 }
    element?.addEventListener('ambio:camera-prewarm', prewarm)
    element?.addEventListener('wheel', interrupt, { passive: true })
    element?.addEventListener('pointerdown', interrupt)
    const unsubscribe = flow.subscribe((state, previous) => {
      if (state.transform === previous.transform && state.width === previous.width && state.height === previous.height) return
      lastMove = performance.now()
      budget.motion(true)
      schedule()
      clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => schedule(true), 130)
    })
    return () => {
      disposed = true; controller.current = null; worker?.terminate(); unsubscribe()
      element?.removeEventListener('ambio:camera-prewarm', prewarm)
      element?.removeEventListener('wheel', interrupt)
      element?.removeEventListener('pointerdown', interrupt)
      cancelAnimationFrame(queryFrame); cancelAnimationFrame(mountFrame)
      clearTimeout(settleTimer); clearTimeout(retainTimer)
      budget.clear()
    }
  }, [enabled, flow, budget, metrics])
  useLayoutEffect(() => { controller.current?.update(latestRecords.current) }, [records])

  const projected = useMemo(() => traceSync('scene.visibility-project', () => {
    if (!enabled) {
      projectionCache.current.clear()
      previousProjection.current = nodes
      return nodes
    }
    const previous = projectionCache.current
    const state = flow.getState()
    const initialCamera: CameraQuery = { x: state.transform[0], y: state.transform[1], zoom: state.transform[2], width: state.width, height: state.height, moving: true }
    const result = nodes.map((node, index) => {
      // Selection, gestures and live signals have priority over the background
      // budget. A hidden semantic descendant stays hidden unless explicitly
      // revealed by the existing navigation/activity projection.
      const important = edgeEndpoints.has(node.id) || node.selected || node.dragging || node.data.fx || (node.data.agentPresence as unknown[] | undefined)?.length || node.data.isDropTarget
      const hidden = Boolean(node.hidden) || !(important || (visible ? visible.has(node.id) : initialRootVisible(records[index], initialCamera)))
      const old = previous.get(node.id)
      if (old?.source === node && old.hidden === hidden) return old.node
      const width = Number(node.style?.width ?? node.initialWidth), height = Number(node.style?.height ?? node.initialHeight)
      const projectedNode = { ...node, hidden,
        data: hidden && !node.hidden ? { ...node.data, renderBudgetHidden: true } : node.data,
        // Authored dimensions are already canonical. Avoid force-mounting
        // off-screen wrappers simply to discover their initial size.
        measured: width > 0 && height > 0 ? { width, height, ...node.measured } : node.measured }
      previous.set(node.id, { source: node, hidden, node: projectedNode })
      return projectedNode
    })
    // Camera replies do not need a fresh full-scene Map. Prune only when IDs
    // actually disappear, and avoid another Flow adoption if nothing changed.
    if (previous.size > nodes.length) {
      const ids = new Set(nodes.map(node => node.id))
      for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id)
    }
    const prior = previousProjection.current
    if (prior.length === result.length && result.every((node, index) => node === prior[index])) return prior
    previousProjection.current = result
    return result
  }, nodes.length), [nodes, records, enabled, visible, edgeEndpoints, flow])
  return { nodes: projected, budget }
}
