import { useEffect, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'
import { SendToAgentDialog } from './SendToAgentDialog'
import { useSheetStore, refreshInbox } from '../store/sheetStore'
import { ChromeButton } from './ui/ChromeButton'
import { InvestigationsMenu } from './InvestigationsMenu'
import { RecordingControl } from './RecordingControl'
import { WindowControls } from './ui/WindowControls'
import { AppMenuBar } from '../app/AppMenuBar'
import { useCommandHandlers } from '../app/commands'

interface ToolbarProps {
  onSearch: () => void
  /** Return to the project launcher, leaving this project open in archd. */
  onCloseProject: () => void
  onManageAgentConnections: () => void
  projectName?: string
  agentLogOpen: boolean
  onToggleAgentLog: () => void
}

export function Toolbar({
  onSearch, onCloseProject, onManageAgentConnections, projectName, agentLogOpen, onToggleAgentLog,
}: ToolbarProps) {
  const { fitView, getNodes } = useReactFlow()
  const isIndexing = useGraphStore(s => s.isIndexing)
  const selectionMode = useGraphStore(s => s.selectionMode)
  const setSelectionMode = useGraphStore(s => s.setSelectionMode)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const [agentMsgOpen, setAgentMsgOpen] = useState(false)
  const queuedMsgs = useSheetStore(s => s.inboxAvailableCount)
  const activeSheetId = useSheetStore(s => s.activeSheetId)
  const activeSheetName = useSheetStore(s =>
    s.activeSheetId ? s.sheets.find(sheet => sheet.id === s.activeSheetId)?.name : undefined
  )
  const surfaceName = activeSheetId ? (activeSheetName ?? 'Overlay Sheet') : 'The Floor'
  const surfaceKind = activeSheetId ? 'Overlay Sheet' : 'Live Code Graph'

  useEffect(() => {
    setAgentMsgOpen(false)
    if (!workspaceId) return
    void refreshInbox(workspaceId)
    const timer = setInterval(() => { void useSheetStore.getState().fetchSheets(workspaceId) }, 5000)
    return () => clearInterval(timer)
  }, [workspaceId])

  useCommandHandlers({
    'view.fitView': () => fitView({ padding: 0.15, duration: 850 }),
    // Frames what is selected; with nothing selected it frames the inspected node.
    'view.zoomSelection': () => {
      const selected = getNodes().filter(node => node.selected).map(node => ({ id: node.id }))
      const fallback = useGraphStore.getState().selectedNodeId
      const nodes = selected.length > 0 ? selected : fallback ? [{ id: fallback }] : []
      if (nodes.length > 0) void fitView({ nodes, padding: 0.3, duration: 600, maxZoom: 1.6 })
    },
    'map.lasso': () => setSelectionMode(!useGraphStore.getState().selectionMode),
  })

  useEffect(() => {
    void window.ambio?.setTitleBarHeight?.(34)
    const openDispatch = () => setAgentMsgOpen(true)
    window.addEventListener('ambio:open-agent-dispatch', openDispatch)
    return () => window.removeEventListener('ambio:open-agent-dispatch', openDispatch)
  }, [])

  return (
    <>
      <header className="ambio-toolbar">
      <div className="ambio-title-strip">
        <div className="ambio-title-strip__identity">
          <AmbioLogo />
          <AppMenuBar />
          <strong>Ambio Architecture Workbench</strong>
          {projectName && (
            <>
              <span className="ambio-title-strip__divider">-</span>
              <span className="ambio-title-strip__project">{projectName}</span>
            </>
          )}
        </div>
        <div className={isIndexing ? 'ambio-title-strip__status ambio-title-strip__status--busy' : 'ambio-title-strip__status'}>
          {isIndexing ? 'INDEXING SOURCE…' : 'INDEX CLEAN'}
        </div>
        <WindowControls />
      </div>

      <div className="ambio-command-strip">
        <div className="ambio-command-group" data-onboarding-target="dispatch">
          <ChromeButton
            onClick={() => setSelectionMode(!selectionMode)}
            label={selectionMode ? 'Lasso Active' : 'Lasso Select'}
            visualLabel={selectionMode ? 'Lasso Active' : 'Lasso'}
            active={selectionMode}
          >
            {selectionMode ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3"/>
              </svg>
            )}
          </ChromeButton>
        </div>

        <div className="ambio-command-separator" />

        <div className="ambio-command-group">
          <RecordingControl workspaceId={workspaceId} />
          <InvestigationsMenu workspaceId={workspaceId} />
          <ChromeButton
            onClick={onToggleAgentLog}
            label="Agent log"
            active={agentLogOpen}
            ariaExpanded={agentLogOpen}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/>
            </svg>
          </ChromeButton>
        </div>

        <div className="ambio-command-separator" />

        <div className="ambio-command-group">
          <ChromeButton
            onClick={() => setAgentMsgOpen(true)}
            label={queuedMsgs > 0 ? `Message agent (${queuedMsgs} queued)` : 'Message agent'}
            visualLabel="Message agent"
            active={queuedMsgs > 0}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            {queuedMsgs > 0 && <span className="ambio-command-badge">{queuedMsgs}</span>}
          </ChromeButton>
        </div>

        <div className="ambio-surface-readout">
          <span>{surfaceName}</span>
          <strong>{surfaceKind}</strong>
        </div>

        <div className="ambio-command-spacer" />

        <div className="ambio-command-group ambio-command-group--navigation">
          {/* The one way out, and the only project-switching control there
              needs to be. The launcher it returns to already offers the folder
              picker this used to sit beside, plus New Project and your recents
              - so a second button here could only ever do less. */}
          <ChromeButton onClick={onCloseProject} label="All projects" visualLabel="Projects">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 5h7v6H3zM14 5h7v6h-7zM3 13h7v6H3zM14 13h7v6h-7z"/>
            </svg>
          </ChromeButton>
          <ChromeButton onClick={onSearch} label="Search" visualLabel="Search indexed files…" shortcut="Ctrl+K">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
            </svg>
          </ChromeButton>
          <ChromeButton onClick={() => fitView({ padding: 0.15, duration: 850 })} label="Fit view" visualLabel="Fit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
          </ChromeButton>
        </div>
      </div>

      </header>
      <SendToAgentDialog key={workspaceId} isOpen={agentMsgOpen} onClose={() => setAgentMsgOpen(false)} onManageConnections={onManageAgentConnections} />
    </>
  )
}

function AmbioLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <polygon points="10,1 19,6 19,14 10,19 1,14 1,6" fill="color-mix(in srgb, var(--workbench-accent) 16%, transparent)" stroke="var(--workbench-accent)" strokeWidth="1.5"/>
      <circle cx="10" cy="10" r="3" fill="var(--workbench-accent)" opacity="0.8"/>
      <line x1="10" y1="1" x2="10" y2="7" stroke="var(--workbench-accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="10" y1="13" x2="10" y2="19" stroke="var(--workbench-accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="1" y1="6" x2="7" y2="9" stroke="var(--workbench-accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="13" y1="11" x2="19" y2="14" stroke="var(--workbench-accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="19" y1="6" x2="13" y2="9" stroke="var(--workbench-accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="7" y1="11" x2="1" y2="14" stroke="var(--workbench-accent)" strokeWidth="1" opacity="0.5"/>
    </svg>
  )
}
