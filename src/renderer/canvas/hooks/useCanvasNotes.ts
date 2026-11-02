import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Node, NodeChange } from '@xyflow/react'
import { useSheetStore, type SheetAnnotation } from '../../store/sheetStore'
import { useGraphStore } from '../../store/graphStore'
import { raiseFailure } from '../../store/interruptionStore'
import type { NoteNodeData } from '../nodes/NoteNode'

type Geometry = Partial<Pick<SheetAnnotation, 'positionX' | 'positionY' | 'width' | 'height'>>
type Draft = { note: SheetAnnotation; body: string; revision: number }

/** Notes live beside the structural scene; they never participate in code packing or approvals. */
export function useCanvasNotes(workspaceId: string, sheetId: string | null, visibleSheetIds: string[], enabled: boolean, readOnly: boolean) {
  const loadedWorkspace = useSheetStore(state => state.workspaceId)
  const floorNotes = useSheetStore(state => state.floorNotes)
  const layers = useSheetStore(state => state.layersById)
  const deleted = useSheetStore(state => state.deletedNoteIds)
  const selected = useSheetStore(state => state.selectedCanvasIds)
  const [geometry, setGeometry] = useState<Record<string, Geometry>>({})
  const geometryRef = useRef<Record<string, Geometry>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [retained, setRetained] = useState<Record<string, SheetAnnotation>>({})
  const drafts = useRef(new Map<string, Draft>())
  const revisions = useRef(new Map<string, number>())
  const scopeKey = visibleSheetIds.join('|')
  const annotations = useMemo(() => [
    ...floorNotes,
    ...visibleSheetIds.flatMap(id => layers[id]?.annotations ?? []),
  ].filter(note => note.kind === 'note'), [floorNotes, layers, scopeKey])
  const models = useRef(annotations)
  models.current = annotations
  useEffect(() => {
    geometryRef.current = {}
    setGeometry({}); setSaving({}); setErrors({}); setRetained({}); drafts.current.clear(); revisions.current.clear()
  }, [workspaceId])
  useEffect(() => {
    if (!enabled || !workspaceId || loadedWorkspace !== workspaceId) return
    void Promise.all([null, ...visibleSheetIds].map(surface => useSheetStore.getState().loadSurfaceNotes(workspaceId, surface))).catch(reason => {
      raiseFailure('canvas-notes-load', 'Could not load notes', reason instanceof Error ? reason.message : String(reason))
    })
  }, [workspaceId, enabled, loadedWorkspace, scopeKey])

  const beginGeometry = useCallback((id: string) => {
    const selected = useSheetStore.getState().selectedCanvasIds
    const ids = selected.includes(`note:${id}`) ? new Set(selected) : new Set([`note:${id}`])
    revisions.current.clear()
    for (const note of models.current) {
      if (note.sheetId === sheetId && ids.has(`note:${note.id}`)) revisions.current.set(note.id, note.revision)
    }
  }, [sheetId])
  const finishGeometry = useCallback(async (id: string, patch: Geometry) => {
    const note = models.current.find(note => note.id === id)
    if (!note) return
    if (!revisions.current.has(id)) revisions.current.set(id, note.revision)
    const members = [...revisions.current]
    revisions.current.clear()
    await Promise.all(members.map(async ([memberId, revision]) => {
      const changes = { ...geometryRef.current[memberId], ...(memberId === id ? patch : {}) }
      if (!Object.keys(changes).length) return
      setSaving(previous => ({ ...previous, [memberId]: true }))
      try {
        await useSheetStore.getState().saveAnnotation(workspaceId, memberId, revision, changes)
        setErrors(previous => ({ ...previous, [memberId]: '' }))
      } catch (reason) {
        setErrors(previous => ({ ...previous, [memberId]: reason instanceof Error ? reason.message : 'Could not move this note.' }))
      } finally {
        const next = { ...geometryRef.current }; delete next[memberId]; geometryRef.current = next
        setGeometry(next)
        setSaving(previous => ({ ...previous, [memberId]: false }))
      }
    }))
  }, [workspaceId])

  const onChanges = useCallback((changes: NodeChange[]) => {
    const noteChanges = changes.filter(change => change.type !== 'add' && change.type !== 'replace' && change.id.startsWith('note:'))
    if (noteChanges.some(change => (change.type === 'position' && change.dragging !== undefined) || (change.type === 'dimensions' && change.resizing !== undefined))) {
      const next = { ...geometryRef.current }
      for (const change of noteChanges) {
        if (change.type === 'position' && change.position && change.dragging !== undefined) next[change.id.slice(5)] = { ...next[change.id.slice(5)], positionX: change.position.x, positionY: change.position.y }
        if (change.type === 'dimensions' && change.dimensions && change.resizing !== undefined) next[change.id.slice(5)] = { ...next[change.id.slice(5)], width: change.dimensions.width, height: change.dimensions.height }
      }
      geometryRef.current = next
      setGeometry(next)
    }
    return changes.filter(change => change.type === 'select' || change.type === 'add' || change.type === 'replace' || !change.id.startsWith('note:'))
  }, [])

  const create = useCallback(async (point: { x: number; y: number }) => {
    const note = await useSheetStore.getState().createFloatingNote(workspaceId, sheetId, 'New note', point.x, point.y)
    if (useSheetStore.getState().workspaceId === workspaceId) useGraphStore.getState().setSelectedNode(`note:${note.id}`)
    return note
  }, [workspaceId, sheetId])

  const nodes = useMemo<Node<NoteNodeData>[]>(() => {
    if (!enabled || loadedWorkspace !== workspaceId) return []
    const byId = new Map(annotations.map(note => [note.id, note]))
    for (const note of Object.values(retained)) {
      if (!byId.has(note.id) && (note.sheetId === null || visibleSheetIds.includes(note.sheetId))) byId.set(note.id, note)
    }
    return [...byId.values()].map((note, index) => {
      const editable = !readOnly && note.sheetId === sheetId
      const draft = drafts.current.get(note.id)
      const local = geometry[note.id]
      const nodeId = `note:${note.id}`
      const isDeleted = !!deleted[note.id] || !annotations.some(current => current.id === note.id)
      return {
        id: nodeId, type: 'note', position: { x: local?.positionX ?? note.positionX ?? 40 + index * 24, y: local?.positionY ?? note.positionY ?? 40 + index * 24 },
        width: local?.width ?? note.width ?? 260, height: local?.height ?? note.height ?? 180,
        selected: selected.includes(nodeId), draggable: editable && !saving[note.id], selectable: true, deletable: false, zIndex: 15,
        data: {
          note, editable, deleted: isDeleted, geometrySaving: !!saving[note.id], geometryError: errors[note.id],
          initialDraft: draft && { body: draft.body, revision: draft.revision },
          onDraft: next => {
            if (next) {
              const first = !drafts.current.has(note.id)
              drafts.current.set(note.id, { note, ...next })
              if (first) setRetained(previous => ({ ...previous, [note.id]: note }))
            } else {
              drafts.current.delete(note.id)
              setRetained(previous => { const next = { ...previous }; delete next[note.id]; return next })
            }
          },
          onSave: async (body, revision) => {
            if (isDeleted) await useSheetStore.getState().createFloatingNote(workspaceId, note.sheetId, body, local?.positionX ?? note.positionX ?? 40, local?.positionY ?? note.positionY ?? 40)
            else await useSheetStore.getState().saveAnnotation(workspaceId, note.id, revision, { body })
          },
          onDelete: async () => {
            try { await useSheetStore.getState().deleteAnnotation(workspaceId, note.id, note.revision) }
            catch (reason) {
              setErrors(previous => ({ ...previous, [note.id]: reason instanceof Error ? reason.message : 'Could not delete this note.' }))
              throw reason
            }
          },
          onBeginGeometry: () => beginGeometry(note.id),
          onFinishGeometry: params => { void finishGeometry(note.id, { positionX: params.x, positionY: params.y, width: params.width, height: params.height }) },
        },
      }
    })
  }, [enabled, loadedWorkspace, annotations, retained, readOnly, sheetId, scopeKey, geometry, selected, saving, errors, deleted, workspaceId, beginGeometry, finishGeometry])
  return { nodes, create, onChanges, beginGeometry, finishGeometry }
}
