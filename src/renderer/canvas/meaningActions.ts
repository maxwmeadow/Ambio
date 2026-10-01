import { useGraphStore } from '../store/graphStore'
import { raiseFailure, raiseNotice, resolveInterruption } from '../store/interruptionStore.ts'
import { apiEditArchitecture, apiUndoArchitecture, type MeaningEdit } from './arcdApi.ts'

/**
 * Apply meaning edits made on the canvas: show them at once, record them in
 * archd (attributed to you, undoable from Review Changes), and offer Undo
 * right here. A refused edit is rolled back and explained.
 *
 * Resolves true when the edits were recorded.
 */
export async function commitMeaningEdits(
  workspaceId: string,
  edits: MeaningEdit[],
  confirmation: string,
): Promise<boolean> {
  if (edits.length === 0) return true
  const before = useGraphStore.getState()
  const rollback = { files: before.files, systems: before.systems }
  useGraphStore.setState(state => applyOptimistically(state, edits))
  try {
    const result = await apiEditArchitecture(workspaceId, edits)
    const eventIds = (result.changes ?? []).flatMap(change => change.eventIds ?? [])
    if (eventIds.length > 0) {
      const id = `meaning-edit-${eventIds[0]}`
      raiseNotice(id, confirmation, undefined, [{
        label: 'Undo',
        run: () => {
          resolveInterruption(id)
          void apiUndoArchitecture(workspaceId, eventIds).catch(error => {
            raiseFailure(`${id}-undo`, "Couldn't undo", error instanceof Error ? error.message : String(error))
          })
        },
      }])
    }
    return true
  } catch (error) {
    useGraphStore.setState(rollback)
    raiseFailure('meaning-edit', "Couldn't change the map", error instanceof Error ? error.message : String(error))
    return false
  }
}

function applyOptimistically(
  state: ReturnType<typeof useGraphStore.getState>,
  edits: MeaningEdit[],
): Partial<ReturnType<typeof useGraphStore.getState>> {
  let files = state.files
  let systems = state.systems
  for (const edit of edits) {
    if (edit.op === 'assign') {
      const moving = new Set(edit.fileIds)
      files = files.map(file => moving.has(file.id) ? { ...file, systemId: edit.systemId } : file)
    } else if (edit.op === 'nest') {
      systems = systems.map(system => system.id === edit.systemId ? { ...system, parentId: edit.parentId } : system)
    } else if (edit.op === 'rename') {
      systems = systems.map(system => system.id === edit.systemId ? { ...system, name: edit.name } : system)
    }
  }
  return { files, systems }
}
