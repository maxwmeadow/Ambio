import { ContextMenu, type ContextMenuEntry, type ContextMenuItem } from '../components/ContextMenu'
import { startSplitSheet, systemPath } from './splitSystem.ts'
import { emitCommand } from '../app/commands'
import { COMMANDS } from '../../shared/appMenu'
import { useGraphStore } from '../store/graphStore'
import { raiseNotice } from '../store/interruptionStore.ts'
import { commitMeaningEdits } from './meaningActions.ts'
import { openFileCode } from './openFileCode.ts'

export type CanvasContextTarget =
  | { kind: 'file'; id: string }
  | { kind: 'system'; id: string }
  | { kind: 'infra'; id: string }
  | { kind: 'pane' }

interface Props {
  x: number
  y: number
  target: CanvasContextTarget
  onClose: () => void
  onShowDetails: (id: string) => void
  onZoomTo: (id: string) => void
  /** Present only on the live, editable Floor: meaning edits are offered. */
  floorEdits?: {
    groupFiles: (fileId: string) => void
    /**
     * Changes that need code go to an agent as a work order, never faked
     * here: removing code is drawn as a removal on a new sheet and sent.
     */
    removeCode: (nodeId: string, label: string, instruction: string) => void
    newSystemHere: (screen: { x: number; y: number }) => void
    /** Start a sheet from the selection containing this node, or the node alone. */
    newSheetFrom: (nodeId: string) => void
  }
}

type Item = ContextMenuItem
type Entry = ContextMenuEntry

function revealLabel(): string {
  const platform = window.ambio?.platform
  return platform === 'darwin' ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Open Containing Folder'
}

function copy(text: string) {
  if (window.ambio?.copyText) void window.ambio.copyText(text)
  else void navigator.clipboard?.writeText(text)
}

/** Right-click menu for the live canvas. */
export function CanvasContextMenu({ x, y, target, onClose, onShowDetails, onZoomTo, floorEdits }: Props) {
  return <ContextMenu x={x} y={y} entries={buildEntries(target, onShowDetails, onZoomTo, floorEdits, { x, y })} onClose={onClose} />
}

function buildEntries(
  target: CanvasContextTarget,
  onShowDetails: (id: string) => void,
  onZoomTo: (id: string) => void,
  floorEdits?: Props['floorEdits'],
  at: { x: number; y: number } = { x: 0, y: 0 },
): Entry[] {
  const store = useGraphStore.getState()
  const workspaceId = store.currentProject?.id
  const meaning = (edits: Parameters<typeof commitMeaningEdits>[1], confirmation: string) => {
    if (workspaceId) void commitMeaningEdits(workspaceId, edits, confirmation)
  }
  const messageAgent: Item = {
    label: 'Message Agent About This…',
    run: () => window.dispatchEvent(new Event('ambio:open-agent-dispatch')),
  }

  if (target.kind === 'pane') {
    return [
      { label: 'New Sheet…', run: () => emitCommand('map.newSheet') },
      { label: 'Add Infrastructure…', run: () => emitCommand('map.addInfra') },
      { label: COMMANDS['map.addNote'].label, run: () => emitCommand('map.addNote') },
      'separator',
      { label: store.selectionMode ? 'Stop Lasso Select' : 'Lasso Select', run: () => emitCommand('map.lasso') },
      { label: 'Fit Map to Window', run: () => emitCommand('view.fitView') },
      { label: 'Tidy Layout', run: () => emitCommand('map.tidy') },
      ...(floorEdits ? [
        'separator' as const,
        // A system with no code yet is a plan: drawn on a new sheet, ready to send.
        { label: 'New System Here…', run: () => floorEdits.newSystemHere(at) },
      ] : []),
    ]
  }

  if (target.kind === 'file') {
    const file = store.files.find(candidate => candidate.id === target.id)
    if (!file) return []
    return [
      ...(workspaceId ? [{ label: 'Open Code in Ambio', run: () => openFileCode(workspaceId, file) }] : []),
      {
        label: 'Open in Editor',
        run: () => {
          void window.ambio?.openFile(file.path).then(result => {
            if (!result.ok) raiseNotice('open-in-editor', 'Could not open in an editor', result.detail)
          })
        },
      },
      { label: revealLabel(), run: () => window.ambio?.showInFolder(file.path) },
      'separator',
      { label: 'Copy Path', run: () => copy(file.path) },
      { label: 'Copy Relative Path', run: () => copy(file.relPath) },
      ...(floorEdits ? fileMeaningEntries(file, store.systems, floorEdits, meaning) : []),
      ...(floorEdits ? [{ label: 'New Sheet from Selection…', run: () => floorEdits.newSheetFrom(file.id) }] : []),
      ...(floorEdits ? [{
        label: 'Delete This File…',
        danger: true,
        run: () => floorEdits.removeCode(file.id, file.relPath,
          `Delete ${file.relPath}. Remove anything only it uses, and update whatever imports it so nothing breaks.`),
      }] : []),
      'separator',
      { label: 'Properties', run: () => onShowDetails(file.id) },
      messageAgent,
    ]
  }

  if (target.kind === 'system') {
    const system = store.systems.find(candidate => candidate.id === target.id)
    if (!system) return []
    return [
      { label: 'Properties', run: () => onShowDetails(system.id) },
      { label: 'Zoom to System', run: () => onZoomTo(system.id) },
      { label: 'Copy Name', run: () => copy(system.name) },
      ...(floorEdits ? [
        'separator' as const,
        { label: 'New Sheet from Selection…', run: () => floorEdits.newSheetFrom(system.id) },
        {
          // Splitting moves code, so it is drawn on a sheet and sent, never done here.
          label: 'Split System…',
          run: () => {
            if (workspaceId) void startSplitSheet(workspaceId, { name: system.name, path: systemPath(system.id, store.systems) })
          },
        },
        {
          // Ungrouping changes meaning only: the contents move up a level and
          // no code is touched. Undo is offered in the confirmation.
          label: 'Ungroup',
          run: () => meaning([{ op: 'ungroup', systemId: system.id }], `${system.name} ungrouped`),
        },
        {
          label: `Delete ${system.name}'s Code…`,
          danger: true,
          run: () => floorEdits.removeCode(system.id, system.name,
            `Delete the code in ${system.name}. Remove what only it uses, and update whatever depends on it so nothing breaks.`),
        },
      ] : []),
      'separator',
      messageAgent,
    ]
  }

  return [
    { label: 'Properties', run: () => onShowDetails(target.id) },
    ...(floorEdits ? [{ label: 'New Sheet from Selection…', run: () => floorEdits.newSheetFrom(target.id) }] : []),
    messageAgent,
  ]
}

function fileMeaningEntries(
  file: { id: string; relPath: string; systemId: string | null },
  systems: Array<{ id: string; name: string }>,
  floorEdits: NonNullable<Props['floorEdits']>,
  meaning: (edits: Parameters<typeof commitMeaningEdits>[1], confirmation: string) => void,
): Entry[] {
  const owner = systems.find(system => system.id === file.systemId)
  const name = file.relPath.split('/').pop() ?? file.relPath
  const entries: Entry[] = ['separator', { label: 'Group into New System…', run: () => floorEdits.groupFiles(file.id) }]
  if (owner) {
    entries.push({
      label: `Take Out of ${owner.name}`,
      run: () => meaning([{ op: 'assign', fileIds: [file.id], systemId: null }], `${name} no longer belongs to ${owner.name}`),
    })
  }
  return entries
}
