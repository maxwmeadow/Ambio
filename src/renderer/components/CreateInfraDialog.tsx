import { useGraphStore } from '../store/graphStore'
import type { InfraService } from '../../shared/types'
import { InfraPickerDialog } from './InfraPickerDialog'

interface CreateInfraDialogProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * Creation adapter for the shared infrastructure catalog. This component owns
 * only the create-node API call; all infrastructure browsing UI and behavior
 * lives in InfraPickerDialog.
 */
export function CreateInfraDialog({ isOpen, onClose }: CreateInfraDialogProps) {
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')

  if (!isOpen) return null

  const createInfra = async (service: InfraService, name: string) => {
    const response = await fetch('http://127.0.0.1:7743/api/infra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        service: service.id,
        name,
        createdBy: 'user',
      }),
    })
    if (!response.ok) throw new Error(await response.text())
    // The node arrives through the infra:upserted patch. Hosting becomes a
    // frame on the canvas; everything else lives in the infrastructure
    // sidebar, so open it on what was just added rather than leave the
    // person wondering where it went.
    const created = await response.json().catch(() => null) as { id?: string } | null
    if (service.category !== 'platform') {
      const store = useGraphStore.getState()
      store.setInfraSidebarOpen(true)
      if (created?.id) {
        store.setSelectedInfra(created.id)
        store.setInspectedNode(created.id)
      }
    }
  }

  return (
    <InfraPickerDialog
      mode="create"
      onCreate={createInfra}
      onClose={onClose}
    />
  )
}
