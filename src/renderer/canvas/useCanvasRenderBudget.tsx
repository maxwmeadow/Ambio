import { perfTrace, traceSync } from './perfTrace'
import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStoreApi, type Edge, type Node } from '@xyflow/react'
import { unstable_batchedUpdates } from 'react-dom'
import { createRenderBudgetStore } from './renderBudgetStore'
import { buildRelationshipIndex, type RelationshipRecord, buildSceneIndex, cameraRect, contains, initialRootVisible, queryScene, sceneRecords, type CameraQuery, type SceneRecord, type ViewRect } from './renderBudgetGeometry'
import { getPerfMetrics } from './perfMetrics'
import type { SceneController } from './scene/sceneController'
import { canonicalScene, preparedCanonicalScene, materializedIds, registerCanvasScene, releaseCanvasScene, type CanonicalScene } from './scene/canonicalScene'

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

export function useCanvasRenderBudget(nodes: Node[], enabled: boolean, edges: Edge[], transitioning = false, pinned: ReadonlySet<string>, sceneWorker: SceneController, decorate: (node: Node) => Node) {
  const previousRelationships = useRef<RelationshipRecord[]>([])
  const relationships = useMemo(() => {
    const next = edges.filter(edge => !edge.hidden && edge.style?.opacity !== 0)
      .map(({ id, source, target }) => ({ id, source, target }))
    const previous = previousRelationships.current
    if (previous.length === next.length && next.every((edge, i) => edge.id === previous[i].id && edge.source === previous[i].source && edge.target === previous[i].target)) return previous
    previousRelationships.current = next
    return next
  }, [edges])
  const edgeById = useMemo(() => new Map(edges.map(edge => [edge.id, edge])), [edges])
  const edgeOrder = useMemo(() => new Map(edges.map((edge, i) => [edge.id, i])), [edges])
  const [visibleEdges, setVisibleEdges] = useState<Set<string>>(new Set())
  const selectedEdges = useMemo(() => edges.filter(edge => edge.selected).map(edge => edge.id), [edges])
  const previousEdges = useRef<Edge[]>([])
  const projectedEdges = useMemo(() => {
    if (!enabled) return edges
    const ids = new Set(visibleEdges)
    for (const id of selectedEdges) ids.add(id)
    if (transitioning) for (const edge of previousEdges.current) ids.add(edge.id)
    const result = [...ids].map(id => edgeById.get(id)).filter((edge): edge is Edge => Boolean(edge))
      .sort((a, b) => edgeOrder.get(a.id)! - edgeOrder.get(b.id)!)
    previousEdges.current = result
    return result
  }, [edges, selectedEdges, edgeById, edgeOrder, enabled, visibleEdges, transitioning])
  const edgeEndpoints = useMemo(() => new Set(projectedEdges.flatMap(edge => [edge.source, edge.target])), [projectedEdges])
  const flow = useStoreApi()
  const [budget] = useState(createRenderBudgetStore)
  budget.configure(enabled)
  const [visible, setVisible] = useState<Set<string> | null>(null)
  const controller = useRef<{ update: (records: SceneRecord[], edges: RelationshipRecord[]) => void } | null>(null)
  const spatialRevision = useRef(0)
  const previousRecords = useRef<SceneRecord[]>([])
  const prepared = preparedCanonicalScene(nodes)
  const records = useMemo(() => traceSync('scene.records', () => {
    const next = prepared?.records ?? sceneRecords(nodes, previousRecords.current)
    previousRecords.current = next
    return next
  }, nodes.length), [nodes])
  const previousScene = useRef<CanonicalScene>()
  const scene = useMemo(() => prepared ?? canonicalScene(nodes, records, previousScene.current), [nodes, records])
  previousScene.current = scene
  useLayoutEffect(() => {
    registerCanvasScene(flow, scene)
    return () => releaseCanvasScene(flow, scene)
  }, [flow, scene])
  const priority = useMemo(() => {
    const ids = new Set<string>()
    for (const node of nodes) if (node.selected || node.dragging || node.data.fx || node.data.relationshipFocus ||
      (node.data.agentPresence as unknown[] | undefined)?.length || node.data.isDropTarget) ids.add(node.id)
    return ids
  }, [nodes])
  const latestRecords = useRef(records); latestRecords.current = records
  const latestRelationships = useRef(relationships); latestRelationships.current = relationships
  const metrics = getPerfMetrics()
  const projectionCache = useRef(new Map<string, { source: Node; hidden: boolean; node: Node; decorate: (node: Node) => Node }>())
  const previousProjection = useRef<Node[]>([])

  useLayoutEffect(() => {
    if (!enabled) { setVisible(null); return }
    let disposed = false, scene = 0, request = 0, accepted = 0
    let queryFrame = 0, mountFrame = 0, settleTimer = 0, retainTimer = 0
    let bounds: ViewRect | null = null, indexedZoom = 0, lastMove = 0, flightUntil = 0
    let source: SceneRecord[] = [], sourceEdges: RelationshipRecord[] = [], localEdges: ReturnType<typeof buildRelationshipIndex> | undefined, local: ReturnType<typeof buildSceneIndex> | undefined
    let currentIds = new Set<string>()
    let worker = false, workerFailed = false
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
    const receive = (message: { scene: number; request: number; bounds: ViewRect; zoom: number; edgeIds: string[]; visible: Array<{ id: string; tier: 0 | 1 | 2 }> }) => {
      if (disposed || message.scene !== scene || message.request < accepted) return
      // During a fast flight, an older buffer may no longer cover the camera.
      if (!contains(message.bounds, cameraRect(camera()))) { schedule(true); return }
      accepted = message.request; bounds = message.bounds; indexedZoom = message.zoom
      setVisibleEdges(previous => previous.size === message.edgeIds.length && message.edgeIds.every(id => previous.has(id)) ? previous : new Set(message.edgeIds))
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
        sceneWorker.post({ op: 'query', scene, request: currentRequest, camera: q, trace: perfTrace.enabled() })
      }
      else {
        if (source.length > 2000 || sourceEdges.length > 2000) { sceneWorker.notifyUnavailable(); return }
        local ??= buildSceneIndex(source)
        localEdges ??= buildRelationshipIndex(local, sourceEdges)
        receive({ scene, request: currentRequest, ...queryScene(local, q), edgeIds: queryScene(localEdges, q).visible.map(row => row.id) })
      }
    }
    function schedule(force = false) {
      const q = camera()
      if (!force && bounds && contains(bounds, cameraRect(q, 100)) && Math.abs(Math.log(q.zoom / indexedZoom)) < .12) return
      if (!queryFrame) queryFrame = requestAnimationFrame(query)
    }
    const update = (next: SceneRecord[], edges: RelationshipRecord[]) => {
      if (source === next && sourceEdges === edges) return
      const changed = source !== next
      source = next; sourceEdges = edges; scene = ++spatialRevision.current; bounds = null; localEdges = undefined
      if (changed) {
        local = undefined
        currentIds = new Set(next.filter(record => !record.hidden).map(record => record.id))
      }
      if (worker) traceSync('worker.scene-post', () => sceneWorker.post({ op: 'scene', scene,
        ...(changed ? { records: source } : {}), relationships: edges, trace: perfTrace.enabled() }), source.length)
      schedule(true)
    }
    const stopWorkerSubscription = sceneWorker.subscribe(data => {
      metrics.workerQueries++
      const sent = sentQueries.get(data.request)
      if (sent !== undefined) { perfTrace.record('worker.round-trip', performance.now() - sent); sentQueries.delete(data.request) }
      if (data.timing?.indexMs !== undefined) perfTrace.record('worker.index', data.timing.indexMs, source.length)
      if (data.timing?.queryMs !== undefined) perfTrace.record('worker.query', data.timing.queryMs)
      receive(data)
    }, () => {
      if (workerFailed) return
      workerFailed = true; worker = false; metrics.workerFallbacks++
      if (source.length <= 2000 && sourceEdges.length <= 2000) schedule(true)
    })
    worker = sceneWorker.available()
    if (!worker) metrics.workerFallbacks++
    controller.current = { update }
    update(latestRecords.current, latestRelationships.current)
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
      disposed = true; controller.current = null; stopWorkerSubscription(); unsubscribe()
      element?.removeEventListener('ambio:camera-prewarm', prewarm)
      element?.removeEventListener('wheel', interrupt)
      element?.removeEventListener('pointerdown', interrupt)
      cancelAnimationFrame(queryFrame); cancelAnimationFrame(mountFrame)
      clearTimeout(settleTimer); clearTimeout(retainTimer)
      budget.clear()
    }
  }, [enabled, flow, budget, metrics, sceneWorker])
  useLayoutEffect(() => { controller.current?.update(latestRecords.current, latestRelationships.current) }, [records, relationships])

  const projected = useMemo(() => traceSync('scene.visibility-project', () => {
    if (!enabled) {
      projectionCache.current.clear()
      const result = nodes.map(decorate)
      previousProjection.current = result
      return result
    }
    const previous = projectionCache.current
    const state = flow.getState()
    const initialCamera: CameraQuery = { x: state.transform[0], y: state.transform[1], zoom: state.transform[2], width: state.width, height: state.height, moving: true }
    const bootstrap = visible ?? records.filter(record => initialRootVisible(record, initialCamera)).map(record => record.id)
    const ids = materializedIds(scene, bootstrap, [...priority, ...pinned, ...edgeEndpoints],
      transitioning ? previousProjection.current.map(node => node.id) : [])
    const wanted = new Set(ids)
    const result = ids.map(id => {
      const source = scene.byId.get(id)!
      const old = previous.get(id)
      if (old?.source === source && old.decorate === decorate) return old.node
      const node = decorate(source)
      const rect = scene.rects.get(id)!
      const projectedNode = { ...node,
        measured: { width: rect.width, height: rect.height, ...node.measured } }
      previous.set(id, { source, hidden: Boolean(node.hidden), node: projectedNode, decorate })
      return projectedNode
    })
    for (const id of previous.keys()) if (!wanted.has(id)) previous.delete(id)
    const prior = previousProjection.current
    if (prior.length === result.length && result.every((node, index) => node === prior[index])) return prior
    previousProjection.current = result
    return result
  }, nodes.length), [nodes, records, scene, enabled, visible, priority, pinned, edgeEndpoints, transitioning, flow, decorate])
  return { nodes: projected, edges: projectedEdges, budget }
}
