import { buildSceneIndex, queryScene, type SceneRecord, type CameraQuery, type SceneIndex } from './renderBudgetGeometry'
type SceneMessage = { op: 'scene'; scene: number; records: SceneRecord[] }
type QueryMessage = { op: 'query'; scene: number; request: number; camera: CameraQuery }
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
    if (pendingScene) { scene = pendingScene.scene; index = buildSceneIndex(pendingScene.records); pendingScene = undefined }
    const query = pendingQuery; pendingQuery = undefined
    if (index && query?.scene === scene) self.postMessage({ scene, request: query.request, ...queryScene(index, query.camera) })
  }, 0)
}
