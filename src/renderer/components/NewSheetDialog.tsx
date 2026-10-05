// NewSheetDialog - lasso a selection → curate it into a named Sheet
// (docs/history/UML_UX_PLAN.md "Creating and populating sheets"). Mirrors GroupDialog.
import React, { useState } from 'react'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'
import { describeSheetMembers, sheetMembersFor } from '../canvas/sheetFromSelection'
import { DialogActions, DialogButton, DialogError, DialogField, DialogForm, DialogFrame, DialogNote } from './ui/DialogPrimitives'

interface NewSheetDialogProps {
  isOpen: boolean
  onClose: () => void
  /** What was selected (or right-clicked) on the Floor: systems, files, infrastructure. */
  nodeIds: string[]
  onSuccess: () => void
}

export function NewSheetDialog({ isOpen, onClose, nodeIds, onSuccess }: NewSheetDialogProps) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const createSheet = useSheetStore(s => s.createSheet)
  const openSheet = useSheetStore(s => s.openSheet)
  const systems = useGraphStore(s => s.systems)
  const files = useGraphStore(s => s.files)
  const infraNodes = useGraphStore(s => s.infraNodes)

  if (!isOpen) return null
  const members = sheetMembersFor(nodeIds, { systems, files, infraNodes })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Sheet name is required')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const sheet = await createSheet(workspaceId, name.trim(), purpose.trim(), members)
      setName('')
      setPurpose('')
      onSuccess()
      onClose()
      void openSheet(workspaceId, sheet.id)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create sheet')
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogFrame title="New Sheet" width={420}>
        <DialogForm onSubmit={handleSubmit}>
          {error && (
            <DialogError>{error}</DialogError>
          )}
          <DialogField label="Sheet name">
            <input
              type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder='e.g. "Payment flow"' className="ambio-dialog-input" autoFocus
            />
          </DialogField>
          <DialogField label="Purpose" optional="optional - shown in the title block">
            <input
              type="text" value={purpose} onChange={e => setPurpose(e.target.value)}
              placeholder="What story does this sheet tell?" className="ambio-dialog-input"
            />
          </DialogField>
          <DialogNote>
            Starting the sheet with <strong>{describeSheetMembers(members)}</strong>. Elements stay
            live - renames and deletions in the codebase show up here.
          </DialogNote>
          <DialogActions inset>
            <DialogButton type="button" variant="secondary" onClick={onClose} disabled={loading}>Cancel</DialogButton>
            <DialogButton type="submit" variant="primary" disabled={loading}>
              {loading ? 'Creating…' : 'Create Sheet'}
            </DialogButton>
          </DialogActions>
        </DialogForm>
    </DialogFrame>
  )
}
