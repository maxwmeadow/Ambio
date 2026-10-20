import { useConversationPreferences } from '../store/conversationPreferences'
import { useCanvasFitView } from '../canvas/useCanvasFitView'
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
import { AmbioWordmark } from './ui/AmbioBrand'
import { emitCommand, useCommandHandlers } from '../app/commands'
import { ProposalDraftProgress } from './ProposalDraftProgress'
import { ProjectActivity } from './ProjectActivity'
import { BranchChip } from './BranchChip'
import { ErrorBoundary } from './ErrorBoundary'

interface ToolbarProps {
  onSearch: () => void
  onManageAgentConnections: () => void
}

export function Toolbar({
  onSearch, onManageAgentConnections,
}: ToolbarProps) {
  const { getNodes } = useReactFlow()
  const fitView = useCanvasFitView()
  const hasChanges = useGraphStore(s => !!s.delta && !s.deltaReviewing)
  const selectionMode = useGraphStore(s => s.selectionMode)
  const setSelectionMode = useGraphStore(s => s.setSelectionMode)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const [agentMsgOpen, setAgentMsgOpen] = useState(false)
  const requestedConversation = useConversationPreferences(s => s.requested)
  useEffect(() => { if (requestedConversation?.workspaceId === workspaceId) setAgentMsgOpen(true) }, [requestedConversation, workspaceId])
  const queuedMsgs = useConversationPreferences(s => s.attention[workspaceId] ?? 0)
  const activeSheetId = useSheetStore(s => s.activeSheetId)
  const activeSheetName = useSheetStore(s =>
    s.activeSheetId ? s.sheets.find(sheet => sheet.id === s.activeSheetId)?.name : undefined
  )

  useEffect(() => {
    setAgentMsgOpen(useConversationPreferences.getState().requested?.workspaceId === workspaceId)
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
          <AmbioWordmark reversed />
          <AppMenuBar />
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
          <ChromeButton
            onClick={() => emitCommand('view.reviewChanges')}
            label="Review Changes"
            active={hasChanges}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 5H5v16h14V5h-4M9 3h6v4H9zM8 14l3 3 5-6"/>
            </svg>
          </ChromeButton>
        </div>

        {activeSheetId && <div className="ambio-surface-readout">
          <strong>{activeSheetName ?? 'Overlay Sheet'}</strong>
        </div>}
        {/* Boundaried: a malformed checkouts response once blanked the whole
            workbench through the panel this replaced. */}
        <ErrorBoundary fallback={null}>
          <BranchChip workspaceId={workspaceId} />
        </ErrorBoundary>

        <div className="ambio-command-spacer" />

        <div className="ambio-command-group ambio-command-group--navigation">
          <ChromeButton onClick={onSearch} label="Search" visualLabel="Search files…" shortcut="Ctrl+K">
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

        <div className="ambio-command-separator" />

        {/* Last on the right: the panel it opens is on the right edge, under it. */}
        <div className="ambio-command-group">
          <ChromeButton
            onClick={() => setAgentMsgOpen(open => !open)}
            label={queuedMsgs > 0 ? `Message agent (${queuedMsgs} need attention)` : 'Message agent'}
            visualLabel="Message agent"
            active={agentMsgOpen || queuedMsgs > 0}
            ariaExpanded={agentMsgOpen}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            {queuedMsgs > 0 && <span className="ambio-command-badge">{queuedMsgs}</span>}
          </ChromeButton>
        </div>
      </div>

      </header>
      <InvestigationsMenu workspaceId={workspaceId} />
      <ProjectActivity key={workspaceId} workspaceId={workspaceId} />
      <ProposalDraftProgress key={`draft:${workspaceId}`} workspaceId={workspaceId} />
      <SendToAgentDialog key={workspaceId} isOpen={agentMsgOpen} onClose={() => setAgentMsgOpen(false)} onManageConnections={onManageAgentConnections} />
    </>
  )
}
