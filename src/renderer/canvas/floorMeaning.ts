import type { FloorLayoutWrite } from './resizePersistence.ts'
import type { MeaningEdit } from './arcdApi.ts'

/**
 * On the Floor, where you put something is what it belongs to
 * (docs/PRODUCT.md §2, DECISIONS 2026-10-01). A drop that lands a file inside
 * another system moves it there; a system dropped inside another nests; either
 * dropped on open canvas leaves every system. Being hosted by infrastructure
 * is a visual relationship and says nothing about ownership.
 *
 * This turns the layout a drop is about to save into the meaning edits it
 * implies, so ownership and placement can never disagree.
 */
export interface FloorOwnership {
  /** fileId -> the system it belongs to, or null when unsorted. */
  fileSystem: ReadonlyMap<string, string | null>
  /** systemId -> its parent system, or null at the top level. */
  systemParent: ReadonlyMap<string, string | null>
}

type DropWrite = Pick<FloorLayoutWrite, 'nodeId' | 'nodeType' | 'parentNodeId' | 'parentNodeType' | 'containmentKind'>

/** The owner a layout row implies, or undefined when it implies none. */
function impliedOwner(write: DropWrite): string | null | undefined {
  if (write.containmentKind === 'hosted_by' || write.parentNodeType === 'infra') return undefined
  if (write.parentNodeType === 'system' && write.parentNodeId) return write.parentNodeId
  if (write.containmentKind === 'root' || !write.parentNodeId) return null
  return undefined
}

export function meaningEditsForDrop(writes: readonly DropWrite[], ownership: FloorOwnership): MeaningEdit[] {
  const assignments = new Map<string | null, string[]>()
  const nests: MeaningEdit[] = []
  for (const write of writes) {
    const owner = impliedOwner(write)
    if (owner === undefined) continue
    if (write.nodeType === 'file') {
      if (!ownership.fileSystem.has(write.nodeId)) continue
      if ((ownership.fileSystem.get(write.nodeId) ?? null) === owner) continue
      const files = assignments.get(owner) ?? []
      files.push(write.nodeId)
      assignments.set(owner, files)
    } else if (write.nodeType === 'system') {
      if (!ownership.systemParent.has(write.nodeId)) continue
      if ((ownership.systemParent.get(write.nodeId) ?? null) === owner) continue
      if (owner === write.nodeId) continue
      nests.push({ op: 'nest', systemId: write.nodeId, parentId: owner })
    }
  }
  const edits: MeaningEdit[] = [...nests]
  for (const [systemId, fileIds] of assignments) edits.push({ op: 'assign', fileIds, systemId })
  return edits
}

/** One line for the notice that confirms a meaning edit made by dragging. */
export function describeDropEdits(
  edits: readonly MeaningEdit[],
  names: { file: (id: string) => string; system: (id: string | null) => string },
): string {
  const parts: string[] = []
  for (const edit of edits) {
    if (edit.op === 'assign') {
      const target = names.system(edit.systemId)
      parts.push(edit.fileIds.length === 1
        ? `${names.file(edit.fileIds[0])} now belongs to ${target}`
        : `${edit.fileIds.length} files now belong to ${target}`)
    } else if (edit.op === 'nest') {
      parts.push(edit.parentId
        ? `${names.system(edit.systemId)} now sits inside ${names.system(edit.parentId)}`
        : `${names.system(edit.systemId)} moved to the top level`)
    }
  }
  return parts.join('; ')
}
