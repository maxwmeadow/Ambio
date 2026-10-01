import { useGraphStore } from '../store/graphStore'
import { raiseFailure, raiseNotice, resolveInterruption } from '../store/interruptionStore.ts'
import { apiEditArchitecture, apiUndoArchitecture, type MeaningEdit } from './arcdApi.ts'
import { codeFitNoticeBody, openMakeCodeMatch } from './codeFit.ts'
import { forgetUndo, pushUndo, type UndoEntry } from './undoStack.ts'

/**
 * Apply meaning edits made on the canvas: show them at once, record them in
 * archd (attributed to you, undoable from Review Changes), and offer Undo
 * right here. When the code now disagrees with the map, the notice also
 * offers the work order that would make it match. A refused edit is rolled
 * back and explained.
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
      const codeFit = result.codeFit ?? []
      // Edit → Undo walks the same journal: undo reverses the recorded rows,
      // redo applies the edits again and remembers the new rows.
      let recorded = eventIds
      const entry: UndoEntry = {
        label: confirmation,
        undo: async () => {
          await apiUndoArchitecture(workspaceId, recorded)
          resolveInterruption(id) // its Undo button no longer applies
        },
        redo: async () => {
          const again = await apiEditArchitecture(workspaceId, edits)
          recorded = (again.changes ?? []).flatMap(change => change.eventIds ?? [])
        },
      }
      pushUndo(entry)
      const actions = [{
        label: 'Undo',
        run: () => {
          resolveInterruption(id)
          forgetUndo(entry)
          void apiUndoArchitecture(workspaceId, recorded).catch(error => {
            raiseFailure(`${id}-undo`, "Couldn't undo", error instanceof Error ? error.message : String(error))
          })
        },
      }]
      if (codeFit.length > 0) {
        actions.push({
          label: 'Make the Code Match…',
          run: () => {
            resolveInterruption(id)
            openMakeCodeMatch(codeFit)
          },
        })
      }
      raiseNotice(id, confirmation, codeFitNoticeBody(codeFit), actions)
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
