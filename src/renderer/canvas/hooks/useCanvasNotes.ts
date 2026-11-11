import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Node } from '@xyflow/react'
import { useSheetStore, type SheetAnnotation } from '../../store/sheetStore'
import { useGraphStore } from '../../store/graphStore'
import { raiseFailure } from '../../store/interruptionStore'
import { createNoteAutosave, type NoteAutosave } from '../noteAutosave'
import type { NoteNodeData } from '../nodes/NoteNode'

type Draft = { note: SheetAnnotation; body: string; revision: number }

const noteGeometrySignature = (notes: SheetAnnotation[]) => notes
  .map(note => [note.id, note.positionX, note.positionY, note.width, note.height].join(':')).join('|')
const noteGeometry = (notes: SheetAnnotation[]) => notes.map(note => ({
  id: `note:${note.id}`, systemId: null, positionX: note.positionX ?? 40, positionY: note.positionY ?? 40,
  width: note.width, height: note.height,
}))

/** Note text sessions decorate native canonical nodes; spatial behavior stays in the shared canvas. */
export function useCanvasNotes(workspaceId: string, sheetId: string | null, visibleSheetIds: string[], enabled: boolean, readOnly: boolean) {
  const loadedWorkspace = useSheetStore(state => state.workspaceId)
  const floorNotes = useSheetStore(state => state.floorNotes)
  const layers = useSheetStore(state => state.layersById)
  const deleted = useSheetStore(state => state.deletedNoteIds)
  const selected = useSheetStore(state => state.selectedCanvasIds)
  const [retained, setRetained] = useState<Record<string, SheetAnnotation>>({})
  const drafts = useRef(new Map<string, Draft>())
  const editors = useRef(new Map<string, NoteAutosave>())
  const editorWorkspace = useRef(workspaceId)
  const scopeKey = visibleSheetIds.join('|')
  const hasSurfaceNotes = enabled && loadedWorkspace === workspaceId
  const floorAnnotations = useMemo(() => hasSurfaceNotes ? floorNotes.filter(note => note.kind === 'note') : [], [hasSurfaceNotes, floorNotes])
  const sheetAnnotations = useMemo(() => hasSurfaceNotes ? visibleSheetIds.flatMap(id => layers[id]?.annotations ?? [])
    .filter(note => note.kind === 'note') : [], [hasSurfaceNotes, layers, scopeKey])
  const annotations = sheetId === null ? floorAnnotations : sheetAnnotations
  useEffect(() => {
    if (editorWorkspace.current === workspaceId) return
    for (const editor of editors.current.values()) editor.end()
    editors.current.clear(); editorWorkspace.current = workspaceId
    setRetained({}); drafts.current.clear()
  }, [workspaceId])
  useEffect(() => {
    if (!enabled || !workspaceId || loadedWorkspace !== workspaceId) return
    void Promise.all([null, ...visibleSheetIds].map(surface => useSheetStore.getState().loadSurfaceNotes(workspaceId, surface))).catch(reason => {
      raiseFailure('canvas-notes-load', 'Could not load notes', reason instanceof Error ? reason.message : String(reason))
    })
  }, [workspaceId, enabled, loadedWorkspace, scopeKey])

  const create = useCallback(async (point: { x: number; y: number }) => {
    const note = await useSheetStore.getState().createFloatingNote(workspaceId, sheetId, 'New note', point.x, point.y)
    if (useSheetStore.getState().workspaceId === workspaceId) useGraphStore.getState().setSelectedNode(`note:${note.id}`)
    return note
  }, [workspaceId, sheetId])

  const nodes = useMemo<Node<NoteNodeData>[]>(() => {
    if (!enabled || loadedWorkspace !== workspaceId) return []
    const onSurface = (note: SheetAnnotation) => sheetId === null ? note.sheetId === null
      : note.sheetId !== null && visibleSheetIds.includes(note.sheetId)
    const byId = new Map(annotations.map(note => [note.id, note]))
    for (const note of Object.values(retained)) {
      if (!byId.has(note.id) && onSurface(note)) byId.set(note.id, note)
    }
    return [...byId.values()].map((note, index) => {
      const editable = !readOnly && note.sheetId === sheetId
      const draft = drafts.current.get(note.id)
      const nodeId = `note:${note.id}`
      const isDeleted = !!deleted[note.id] || !annotations.some(current => current.id === note.id)
      const callbacks = {
        save: async (body: string, revision: number) => isDeleted
          ? useSheetStore.getState().createFloatingNote(workspaceId, note.sheetId, body, note.positionX ?? 40, note.positionY ?? 40)
          : useSheetStore.getState().saveAnnotation(workspaceId, note.id, revision, { body }),
        remove: (revision: number) => useSheetStore.getState().deleteAnnotation(workspaceId, note.id, revision),
        draft: (next: { body: string; revision: number } | null) => {
          if (useSheetStore.getState().workspaceId !== workspaceId) return
          if (next) {
            const first = !drafts.current.has(note.id)
            drafts.current.set(note.id, { note, ...next })
            if (first) setRetained(previous => ({ ...previous, [note.id]: note }))
          } else if (drafts.current.delete(note.id)) {
            setRetained(previous => { const next = { ...previous }; delete next[note.id]; return next })
          }
        },
      }
      let editor = editors.current.get(note.id)
      if (!editor) { editor = createNoteAutosave(note, callbacks, draft); editors.current.set(note.id, editor) }
      else editor.configure(callbacks)
      return {
        id: nodeId, type: 'note', position: { x: note.positionX ?? 40 + index * 24, y: note.positionY ?? 40 + index * 24 },
        width: note.width ?? 260, height: note.height ?? 180,
        selected: selected.includes(nodeId), draggable: editable && !isDeleted, selectable: true, deletable: false, zIndex: 15,
        data: {
          note, editable, deleted: isDeleted, geometrySaving: false,
          editor,
          onDelete: async () => { await editor!.remove() },
        },
      }
    })
  }, [enabled, loadedWorkspace, annotations, retained, readOnly, sheetId, scopeKey, selected, deleted, workspaceId])
  const floorSignature = noteGeometrySignature(floorAnnotations)
  const sheetSignature = noteGeometrySignature(sheetAnnotations)
  const floorGeometryNotes = useMemo(() => noteGeometry(floorAnnotations), [floorSignature])
  const sheetGeometryNotes = useMemo(() => noteGeometry(sheetAnnotations), [sheetSignature])
  return { nodes, create, sheetGeometryNotes, floorGeometryNotes }
}
