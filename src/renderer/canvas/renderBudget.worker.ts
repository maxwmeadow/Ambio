import { buildSceneIndex, queryScene, type SceneRecord, type CameraQuery, type SceneIndex } from './renderBudgetGeometry'
type SceneMessage = { op: 'scene'; scene: number; records: SceneRecord[]; trace?: boolean }
type QueryMessage = { op: 'query'; scene: number; request: number; camera: CameraQuery; trace?: boolean }
let indexMs: number | undefined
let scene = 0, index: SceneIndex | undefined
let pendingScene: SceneMessage | undefined, pendingQuery: QueryMessage | undefined, scheduled = false
self.onmessage = (event: MessageEvent<SceneMessage | QueryMessage>) => {
  const message = event.data
  if (message.op === 'scene') pendingScene = message
  else pendingQuery = message
  if (scheduled) return
  scheduled = true
  // Coalesce queued camera/scene messages before indexing; stale intermediate
  // work must not delay a new navigation destination.
  setTimeout(() => {
    scheduled = false
    if (pendingScene) {
      const started = pendingScene.trace ? performance.now() : 0
      scene = pendingScene.scene; index = buildSceneIndex(pendingScene.records)
      indexMs = pendingScene.trace ? performance.now() - started : undefined
      pendingScene = undefined
    }
    const query = pendingQuery; pendingQuery = undefined
    if (index && query?.scene === scene) {
      const started = query.trace ? performance.now() : 0
      const result = queryScene(index, query.camera)
      self.postMessage({ scene, request: query.request, ...result,
        ...(query.trace ? { timing: { indexMs, queryMs: performance.now() - started } } : {}) })
      indexMs = undefined
    }
  }, 0)
}
