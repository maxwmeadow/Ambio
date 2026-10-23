import { buildRelationshipIndex, buildSceneIndex, queryScene, type SceneRecord, type CameraQuery, type SceneIndex, type RelationshipRecord } from './renderBudgetGeometry'
import { prepareFloorGeometrySteps, type FloorGeometryInput } from './scene/sceneGeometry'
type SceneMessage = { op: 'scene'; scene: number; records?: SceneRecord[]; relationships: RelationshipRecord[]; trace?: boolean }
type QueryMessage = { op: 'query'; scene: number; request: number; camera: CameraQuery; trace?: boolean }
type PrepareMessage = { op: 'prepare'; channel: string; token: number; input: FloorGeometryInput; trace?: boolean }
type CancelMessage = { op: 'cancel-prepare'; channel: string; token: number }
const preparations = new Map<string, number>()
let indexMs: number | undefined
let scene = 0, index: SceneIndex | undefined
let relationships: SceneIndex | undefined
let pendingScene: SceneMessage | undefined, pendingQuery: QueryMessage | undefined, scheduled = false
self.onmessage = (event: MessageEvent<SceneMessage | QueryMessage | PrepareMessage | CancelMessage>) => {
  const message = event.data
  if (message.op === 'cancel-prepare') {
    if (preparations.get(message.channel) === message.token) preparations.delete(message.channel)
    self.postMessage({ op: 'prepare-cancelled', channel: message.channel, token: message.token })
    return
  }
  if (message.op === 'prepare') {
    preparations.set(message.channel, message.token)
    const { input, channel, token } = message
    const steps = prepareFloorGeometrySteps(input.systems, input.files, input.infraNodes, input.dependencies, input.layouts, input.placements)
    let computeMs = 0
    const tick = () => {
      if (preparations.get(channel) !== token) return
      const deadline = performance.now() + 4
      try {
        do {
          const started = message.trace ? performance.now() : 0
          const result = steps.next()
          if (message.trace) computeMs += performance.now() - started
          if (result.done) {
            preparations.delete(channel)
            self.postMessage({ op: 'prepared', channel, token, geometry: result.value, ...(message.trace ? { computeMs } : {}) })
            return
          }
        } while (performance.now() < deadline)
        setTimeout(tick, 0)
      } catch (error) {
        preparations.delete(channel)
        self.postMessage({ op: 'prepare-error', channel, token, message: error instanceof Error ? error.message : String(error) })
      }
    }
    setTimeout(tick, 0)
    return
  }
  if (message.op === 'scene') pendingScene = { ...message, records: message.records ?? pendingScene?.records }
  else pendingQuery = message
  if (scheduled) return
  scheduled = true
  // Coalesce queued camera/scene messages before indexing; stale intermediate
  // work must not delay a new navigation destination.
  setTimeout(() => {
    scheduled = false
    if (pendingScene) {
      const started = pendingScene.trace ? performance.now() : 0
      scene = pendingScene.scene
      if (pendingScene.records) index = buildSceneIndex(pendingScene.records)
      if (index) relationships = buildRelationshipIndex(index, pendingScene.relationships)
      indexMs = pendingScene.trace ? performance.now() - started : undefined
      pendingScene = undefined
    }
    const query = pendingQuery; pendingQuery = undefined
    if (index && query?.scene === scene) {
      const started = query.trace ? performance.now() : 0
      const result = queryScene(index, query.camera)
      self.postMessage({ scene, request: query.request, ...result,
        edgeIds: relationships ? queryScene(relationships, query.camera).visible.map(row => row.id) : [],
        ...(query.trace ? { timing: { indexMs, queryMs: performance.now() - started } } : {}) })
      indexMs = undefined
    }
  }, 0)
}
