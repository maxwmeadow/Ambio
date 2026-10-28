import { sceneChunks, appendSceneChunk, type SceneChunk } from './scene/sceneTransfer'
import { buildRelationshipIndex, buildSceneIndex, queryScene, type SceneRecord, type CameraQuery, type SceneIndex, type RelationshipRecord } from './renderBudgetGeometry'
import { prepareFloorGeometrySteps, type FloorGeometryInput } from './scene/sceneGeometry'
type SceneMessage = { op: 'scene'; scene: number; records?: SceneRecord[]; relationships: RelationshipRecord[]; trace?: boolean }
type QueryMessage = { op: 'query'; scene: number; request: number; camera: CameraQuery; trace?: boolean }
type PrepareMessage = { op: 'prepare'; channel: string; token: number; input: FloorGeometryInput; trace?: boolean }
type TransferMessage = { op: 'prepare-start' | 'prepare-chunk' | 'prepare-commit' | 'prepare-result-next'; channel: string; token: number; trace?: boolean; chunk?: SceneChunk }
type SceneTransferMessage = { op: 'scene-start' | 'scene-chunk' | 'scene-commit'; token: number; scene?: number; trace?: boolean; chunk?: SceneChunk }
type CancelMessage = { op: 'cancel-prepare'; channel: string; token: number }
const preparations = new Map<string, number>()
const inputs = new Map<string, PrepareMessage>()
const outputs = new Map<string, { token: number; chunks: Generator<SceneChunk>; computeMs?: number }>()
let stagedScene: { token: number; message: SceneMessage } | undefined
let indexMs: number | undefined
let scene = 0, index: SceneIndex | undefined
let relationships: SceneIndex | undefined
let pendingScene: SceneMessage | undefined, pendingQuery: QueryMessage | undefined, scheduled = false
self.onmessage = (event: MessageEvent<SceneMessage | QueryMessage | PrepareMessage | CancelMessage | TransferMessage | SceneTransferMessage>) => {
  let message = event.data
  if (message.op === 'scene-start') {
    stagedScene = { token: message.token, message: { op: 'scene', scene: message.scene!, records: [], relationships: [], trace: message.trace } }
    self.postMessage({ op: 'scene-input-next', token: message.token }); return
  }
  if (message.op === 'scene-chunk' || message.op === 'scene-commit') {
    if (stagedScene?.token !== message.token) return
    if (message.op === 'scene-chunk') {
      appendSceneChunk(stagedScene.message, message.chunk!)
      self.postMessage({ op: 'scene-input-next', token: message.token }); return
    }
    message = stagedScene.message; stagedScene = undefined
  }
  if (message.op === 'cancel-prepare') {
    if (preparations.get(message.channel) === message.token) {
      preparations.delete(message.channel); inputs.delete(message.channel); outputs.delete(message.channel)
    }
    self.postMessage({ op: 'prepare-cancelled', channel: message.channel, token: message.token })
    return
  }
  if (message.op === 'prepare-start') {
    const { channel, token, trace } = message
    preparations.set(channel, token); outputs.delete(channel)
    inputs.set(channel, { op: 'prepare', channel, token, trace, input: { systems: [], files: [], infraNodes: [], dependencies: [], layouts: [], placements: new Map() } })
    self.postMessage({ op: 'prepare-input-next', channel, token }); return
  }
  if (message.op === 'prepare-chunk' || message.op === 'prepare-commit') {
    const pending = inputs.get(message.channel)
    if (!pending || pending.token !== message.token) return
    if (message.op === 'prepare-chunk') {
      appendSceneChunk(pending.input, message.chunk!)
      self.postMessage({ op: 'prepare-input-next', channel: message.channel, token: message.token }); return
    }
    inputs.delete(message.channel); message = pending
  }
  if (message.op === 'prepare-result-next') {
    const output = outputs.get(message.channel)
    if (!output || output.token !== message.token) return
    const next = output.chunks.next()
    if (next.done) {
      outputs.delete(message.channel); preparations.delete(message.channel)
      self.postMessage({ op: 'prepared', channel: message.channel, token: message.token, computeMs: output.computeMs })
    } else self.postMessage({ op: 'prepared-chunk', channel: message.channel, token: message.token, chunk: next.value })
    return
  }
  if (message.op === 'prepare') {
    preparations.set(message.channel, message.token)
    const { input, channel, token, trace } = message
    const steps = prepareFloorGeometrySteps(input.systems, input.files, input.infraNodes, input.dependencies, input.layouts, input.placements)
    let computeMs = 0
    const tick = () => {
      if (preparations.get(channel) !== token) return
      const deadline = performance.now() + 4
      try {
        do {
          const started = trace ? performance.now() : 0
          const result = steps.next()
          if (trace) computeMs += performance.now() - started
          if (result.done) {
            if (input.files.length + input.systems.length + input.layouts.length > 2000) {
              outputs.set(channel, { token, chunks: sceneChunks(result.value), ...(trace ? { computeMs } : {}) })
              self.postMessage({ op: 'prepared-start', channel, token })
            } else {
              preparations.delete(channel)
              self.postMessage({ op: 'prepared', channel, token, geometry: result.value, ...(trace ? { computeMs } : {}) })
            }
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
  if (message.op === 'scene') { stagedScene = undefined; pendingScene = { ...message, records: message.records ?? pendingScene?.records } }
  else if (message.op === 'query') pendingQuery = message
  if (stagedScene || scheduled) return
  scheduled = true
  // Coalesce queued camera/scene messages before indexing; stale intermediate
  // work must not delay a new navigation destination.
  setTimeout(() => {
    scheduled = false
    if (stagedScene) return
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
