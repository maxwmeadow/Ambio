import { useConversationPreferences } from '../store/conversationPreferences'
import { useCanvasFitView } from '../canvas/useCanvasFitView'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { usePresence } from './ui/usePresence'

const TerminalPanel = lazy(() => import('./TerminalPanel'))

interface ToolbarProps {
  onSearch: () => void
  onManageAgentConnections: () => void
}

export function Toolbar({
  onSearch, onManageAgentConnections,
}: ToolbarProps) {
  const { getNodes } = useReactFlow()
  const fitView = useCanvasFitView()
  const reviewingChanges = useGraphStore(s => s.deltaReviewing)
  const selectionMode = useGraphStore(s => s.selectionMode)
  const setSelectionMode = useGraphStore(s => s.setSelectionMode)
  const placingNote = useGraphStore(s => s.placingNote)
  const setPlacingNote = useGraphStore(s => s.setPlacingNote)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const projectName = useGraphStore(s => s.currentProject?.name)
  const [sidebar, setSidebar] = useState<'agent' | 'terminal' | null>(null)
  const sidebarPresence = usePresence(sidebar !== null)
  const lastSidebar = useRef(sidebar)
  useLayoutEffect(() => { if (sidebar) lastSidebar.current = sidebar }, [sidebar])
  const shownSidebar = sidebarPresence.mounted ? sidebar ?? lastSidebar.current : null
  const agentMsgOpen = sidebar === 'agent'
  const terminalOpen = sidebar === 'terminal'
  const clampSidebarWidth = (width: number) => Math.round(Math.max(360, Math.min(window.innerWidth * .85, width)))
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return clampSidebarWidth(Number(localStorage.getItem('ambio:sidebar-width') || localStorage.getItem('ambio:terminal-width') || localStorage.getItem('ambio:inbox-width')) || 560) }
    catch { return 560 }
  })
  const resizeSidebar = (width: number) => setSidebarWidth(clampSidebarWidth(width))
  useLayoutEffect(() => {
    const style = document.documentElement.style
    style.setProperty('--workbench-sidebar-width', `${sidebarWidth}px`)
    return () => { style.removeProperty('--workbench-sidebar-width') }
  }, [sidebarWidth])
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.workbenchSidebarState = sidebarPresence.closing ? 'closing' : sidebarPresence.mounted ? 'open' : 'closed'
    return () => { delete root.dataset.workbenchSidebarState }
  }, [sidebarPresence.mounted, sidebarPresence.closing])
  useEffect(() => { try { localStorage.setItem('ambio:sidebar-width', String(sidebarWidth)) } catch { /* session only */ } }, [sidebarWidth])
  useEffect(() => {
    const fit = () => setSidebarWidth(width => clampSidebarWidth(width))
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  const [terminalMounted, setTerminalMounted] = useState(false)
  const requestedConversation = useConversationPreferences(s => s.requested)
  useEffect(() => { if (requestedConversation?.workspaceId === workspaceId) setSidebar('agent') }, [requestedConversation, workspaceId])
  const queuedMsgs = useConversationPreferences(s => s.attention[workspaceId] ?? 0)

  useEffect(() => {
    setTerminalMounted(false)
    setSidebar(useConversationPreferences.getState().requested?.workspaceId === workspaceId ? 'agent' : null)
    if (!workspaceId) return
    void refreshInbox(workspaceId)
    const timer = setInterval(() => { void useSheetStore.getState().fetchSheets(workspaceId) }, 5000)
    return () => clearInterval(timer)
  }, [workspaceId])

  useCommandHandlers({
    'view.terminal': () => {
      setTerminalMounted(true)
      setSidebar(current => current === 'terminal' ? null : 'terminal')
    },
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
    const openDispatch = () => setSidebar('agent')
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
        {/* Left to right as the screen is laid out: where you are (over the
            sheet rail), what you do to the canvas, search in the middle, and
            the right-hand panels last, above the panel they open. */}
        <div className="ambio-command-strip__start">
          <div className="ambio-location" aria-label="Where you are">
            {projectName && <div className="ambio-project-readout" aria-label="Current project" title={projectName}>
              <span>Project</span>
              <strong>{projectName}</strong>
            </div>}
            {/* Boundaried: a malformed checkouts response once blanked the whole
                workbench through the panel this replaced. */}
            <ErrorBoundary fallback={null}>
              <BranchChip workspaceId={workspaceId} />
            </ErrorBoundary>
          </div>

          <div className="ambio-command-separator" />

          <div className="ambio-command-group ambio-segmented" role="group" aria-label="Canvas tool" data-onboarding-target="dispatch">
            <ChromeButton
              onClick={() => { setSelectionMode(false); setPlacingNote(false) }}
              label="Select"
              active={!selectionMode && !placingNote}
              ariaPressed={!selectionMode && !placingNote}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 3l14 8-6 2-3 6z"/>
              </svg>
            </ChromeButton>
            <ChromeButton
              onClick={() => setSelectionMode(!selectionMode)}
              label="Lasso Select"
              visualLabel="Lasso"
              active={selectionMode}
              ariaPressed={selectionMode}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3"/>
              </svg>
            </ChromeButton>
            <ChromeButton
              onClick={() => setPlacingNote(!placingNote)}
              label="Note: click the canvas to place one"
              visualLabel="Note"
              active={placingNote}
              ariaPressed={placingNote}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/>
              </svg>
            </ChromeButton>
          </div>

          <div className="ambio-command-separator" />

          <div className="ambio-command-group">
            <RecordingControl workspaceId={workspaceId} />
            <ChromeButton
              onClick={() => emitCommand('view.reviewChanges')}
              label="Review Changes"
              active={reviewingChanges}
              ariaExpanded={reviewingChanges}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 5H5v16h14V5h-4M9 3h6v4H9zM8 14l3 3 5-6"/>
              </svg>
            </ChromeButton>
            <InvestigationsMenu workspaceId={workspaceId} trigger />
          </div>
        </div>

        <div className="ambio-command-group ambio-command-group--search">
          <ChromeButton onClick={onSearch} label="Search" visualLabel="Search the project…" shortcut="Ctrl+K">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
            </svg>
          </ChromeButton>
        </div>

        <div className="ambio-command-strip__end">
          {/* One panel slot on the right edge: Terminal or the agent. */}
          <div className="ambio-command-group ambio-segmented" role="group" aria-label="Right panel">
            <ChromeButton onClick={() => emitCommand('view.terminal')} label="Terminal" active={terminalOpen} ariaExpanded={terminalOpen}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 5 6 6-6 6M12 19h8" /></svg>
            </ChromeButton>
            <ChromeButton
              onClick={() => setSidebar(current => current === 'agent' ? null : 'agent')}
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
      </div>

      </header>
      <ProjectActivity key={workspaceId} workspaceId={workspaceId} />
      <ProposalDraftProgress key={`draft:${workspaceId}`} workspaceId={workspaceId} />
      <div className="ambio-workbench-sidebar" hidden={!sidebarPresence.mounted} data-closing={sidebarPresence.closing || undefined}
        aria-hidden={sidebarPresence.closing || undefined} ref={element => { if (element) element.inert = sidebarPresence.closing || !sidebarPresence.mounted }}>
        <SendToAgentDialog key={workspaceId} isOpen={shownSidebar === 'agent'} onClose={() => setSidebar(null)} onManageConnections={onManageAgentConnections} onResize={resizeSidebar} />
        {terminalMounted && <Suspense fallback={null}><TerminalPanel key={`terminal:${workspaceId}`} workspaceId={workspaceId} open={shownSidebar === 'terminal'} width={sidebarWidth} onResize={resizeSidebar} onClose={() => setSidebar(null)} /></Suspense>}
      </div>
    </>
  )
}
