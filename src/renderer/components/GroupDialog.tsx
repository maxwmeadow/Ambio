import React, { useState } from 'react'
import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'
import { DialogActions, DialogButton, DialogError, DialogField, DialogForm, DialogFrame, DialogNote } from './ui/DialogPrimitives'
import { archdApi } from '../archdEndpoint.ts'
import { apiEditArchitecture } from '../canvas/arcdApi'

interface GroupDialogProps {
  isOpen: boolean
  onClose: () => void
  selectedFileIds: string[]
  onSuccess: () => void
}

export function GroupDialog({ isOpen, onClose, selectedFileIds, onSuccess }: GroupDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { currentProject, systems, applySnapshot } = useGraphStore(useShallow(s => ({
    currentProject: s.currentProject,
    systems: s.systems,
    applySnapshot: s.applySnapshot,
  })))

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('System name is required')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const isDemo = !window.ambio

      if (isDemo) {
        // Demo mode: mutate store directly
        const systemId = `sys_${Math.random().toString(36).slice(2, 9)}`
        const now = Date.now()
        const newSystem = {
          id: systemId,
          workspaceId: 'demo',
          name: name.trim(),
          parentId: null as string | null,
          source: 'user' as const,
          color: null,
          description: description.trim() || null,
          agentNotes: null,
          depth: 0,
          positionX: 0,
          positionY: 0,
          createdAt: now,
          updatedAt: now,
        }
        useGraphStore.setState(s => ({
          systems: [...s.systems, newSystem],
          files: s.files.map(f =>
            selectedFileIds.includes(f.id) ? { ...f, systemId } : f
          ),
        }))
      } else {
        // Live: call Go REST API
        const workspaceId = currentProject?.id ?? ''
        // One recorded step: the new system and the files that belong to it.
        await apiEditArchitecture(workspaceId, [{
          op: 'create',
          name: name.trim(),
          description: description.trim() || null,
          fileIds: selectedFileIds,
        }])

        // Re-fetch snapshot so canvas reflects the new assignments
        const snapRes = await fetch(`${archdApi()}/api/snapshot/${workspaceId}`)
        if (snapRes.ok) {
          const snap = await snapRes.json()
          applySnapshot(snap)
        }
      }

      setName('')
      setDescription('')
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create system')
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogFrame title="New System" width={420}>
        <DialogForm onSubmit={handleSubmit}>
          {error && (
            <DialogError>
              {error}
            </DialogError>
          )}

          <DialogField label="System name">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Auth & Session Management"
              className="ambio-dialog-input"
              autoFocus
            />
          </DialogField>

          <DialogField label="Description" optional="optional">
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What this system is responsible for..."
              rows={3}
              className="ambio-dialog-input ambio-dialog-input--textarea"
            />
          </DialogField>

          <DialogNote>
            Grouping <strong>{selectedFileIds.length}</strong> selected{' '}
            {selectedFileIds.length === 1 ? 'file' : 'files'} into this system.
          </DialogNote>

          <DialogActions inset>
            <DialogButton
              type="button"
              onClick={onClose}
              disabled={loading}
              variant="secondary"
            >
              Cancel
            </DialogButton>
            <DialogButton
              type="submit"
              disabled={loading}
              variant="primary"
            >
              {loading ? 'Creating…' : 'Create System'}
            </DialogButton>
          </DialogActions>
        </DialogForm>
    </DialogFrame>
  )
}
