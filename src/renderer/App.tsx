import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { ReactFlowProvider } from '@xyflow/react'

import { AxiomCanvas } from './canvas/AxiomCanvas'
import { subscribeToDeltaRefresh } from './canvas/deltaRefresh'
import { Toolbar } from './components/Toolbar'
import { StatusBar } from './components/StatusBar'
import { DetailPanel } from './components/DetailPanel'
import { DocumentsPanel } from './components/DocumentsPanel'
import { BinDragGhostLayer } from './components/BinDragGhostLayer'
import { SearchBar } from './components/SearchBar'
import { InjectConfirmBanner } from './components/InjectConfirmBanner'
import { AgentLogPanel } from './components/AgentLogPanel'
import { PaperTextureDefs } from './canvas/nodes/PaperTexture'
import { DeltaPanel } from './components/DeltaPanel'
import { ArchitectureProposalPanel } from './components/ArchitectureProposalPanel'
import { ReplayBar } from './components/ReplayBar'
import { CasePanel } from './components/CasePanel'
import { OnboardingGuide } from './components/OnboardingGuide'
import { AgentLane } from './components/AgentLane'
import { InterruptionLane } from './components/InterruptionLane'
import { EmptyIndexNotice } from './components/EmptyIndexNotice'
import { HomeScreen } from './screens/HomeScreen'
import { ProjectSetupScreen } from './screens/ProjectSetupScreen'
import { ProjectReviewScreen } from './screens/ProjectReviewScreen'
import { ConnectAgentScreen } from './screens/ConnectAgentScreen'
import { readAuthorship } from './canvas/architectureAuthorship.ts'
import { isCanvasSourceFile } from '../shared/fileKinds'
import {
  migrateLegacyProjectLifecycle,
} from './projectLocalState'

import { useGraphStore, connectToArchd } from './store/graphStore'
import { useOnboardingStore } from './store/onboardingStore'
import { raiseFailure, raiseInvitation, raiseNotice, resolveInterruption, useInterruptionStore } from './store/interruptionStore.ts'
import { useUpdateStatus } from './useUpdateStatus'
import { resumeDecision } from '../shared/sessionResume.ts'
import { useRegistryStore } from './store/registryStore'
import { useProposalStore } from './store/architectureProposalStore'
import { SheetRail } from './components/SheetRail'
import type { ProjectConfig } from '../shared/types'
import {
  completeSourceBoundaries,
  projectHasEnteredWorkbench,
  projectUsesBlankSetup,
  resolveProjectSourceBoundaries,
  sourceBoundariesAreComplete,
} from '../shared/projectLifecycle'
import { useShallow } from 'zustand/react/shallow'

import { demoSnapshot } from './demo/demoGraph'
import { ErrorBoundary } from './components/ErrorBoundary'

const APP_PARAMS = new URLSearchParams(window.location.search)
const E2E_MODE = APP_PARAMS.get('e2e') === '1'
const E2E_HOME = E2E_MODE && APP_PARAMS.get('home') === '1'
const E2E_SETUP = E2E_MODE && APP_PARAMS.get('setup') === '1'
const E2E_CONNECT = E2E_MODE && APP_PARAMS.get('connect') === '1'
const E2E_REVIEW = E2E_MODE && APP_PARAMS.get('review') === '1'
const E2E_BLANK_PROJECT = E2E_MODE && APP_PARAMS.get('blank') === '1'
const E2E_PROJECT: ProjectConfig = {
  id: 'demo',
  name: 'Axiom Canvas Fixture',
  rootPath: '/axiom-e2e',
  ignoredPaths: [],
  languageOverrides: {},
  layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
  openedAt: 0,
}
// The deterministic canvas fixture predates inferred-system filtering. Its
// six named systems are authored test data, not classifier guesses; stamp that
// explicitly so E2E continues to exercise the full Floor rather than silently
// turning into a one-system fixture.
const E2E_SNAPSHOT = {
  ...demoSnapshot,
  systems: demoSnapshot.systems.map(system => ({ ...system, source: 'user' as const })),
}

// Which project was open when we last closed. Absent means the user backed out
// to the launcher on purpose, which the next launch has to respect.
const RESUME_KEY = 'axiom_resume_project'

async function rememberOpenProject(projectId: string) {
  if (window.axiom) {
    await window.axiom.setResumeProjectId(projectId)
    return
  }
  try {
    localStorage.setItem(RESUME_KEY, projectId)
  } catch {
    // Storage refused; resume degrades to the launcher, which is the old
    // behavior and never wrong, only slower.
  }
}

async function forgetOpenProject() {
  if (window.axiom) {
    await window.axiom.setResumeProjectId(null)
    return
  }
  try {
    localStorage.removeItem(RESUME_KEY)
  } catch { /* see rememberOpenProject */ }
}

/** Setup finished according to the journey that created this project. */
function projectIsReady(config: ProjectConfig): boolean {
  // A moved folder cannot resume; the launcher asks where it went.
  if (config.rootMissing) return false
  config = migrateLegacyProjectLifecycle(config)
  return sourceBoundariesAreComplete(config) && projectHasEnteredWorkbench(config)
}

export default function App() {
  const [searchOpen, setSearchOpen] = useState(false)
  const [agentLogOpen, setAgentLogOpen] = useState(false)
  const caseOpen = useGraphStore(state => state.caseFile !== null || state.replay !== null)
  // Shared with the canvas documents bin, so both entry points open one browser.
  const documentsOpen = useGraphStore(state => state.documentsOpen)
  const setDocumentsOpen = useGraphStore(state => state.setDocumentsOpen)
  const [currentProject, setCurrentProject] = useState<ProjectConfig | null>(
    E2E_MODE && !E2E_HOME && !E2E_SETUP ? E2E_PROJECT : null
  )
  // Pending project awaiting setup configuration before indexing starts
  const [pendingSetup, setPendingSetup] = useState<ProjectConfig | null>(
    E2E_SETUP ? { ...E2E_PROJECT, rootPath: '.' } : null
  )
  const [reviewActive, setReviewActive] = useState(E2E_REVIEW)
  // Gates the launcher until the resume decision is known, so a resuming
  // launch never flashes the project list on its way into the workbench.
  const [resumeChecked, setResumeChecked] = useState(E2E_MODE)
  // A project created through New Project is deliberately an empty folder, so
  // it must never be diagnosed as misconfigured for being empty.
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const enterOnboardingProject = useOnboardingStore(s => s.enterProject)

  const { files: graphFiles, systems: graphSystems, isIndexing: graphIndexing } =
    useGraphStore(useShallow(s => ({
      files: s.files,
      systems: s.systems,
      isIndexing: s.isIndexing,
    })))
  const [completedAgentSetupId, setCompletedAgentSetupId] = useState<string | null>(null)
  const [initialJourneyProjectId, setInitialJourneyProjectId] = useState<string | null>(null)
  const [browsingWithoutAgent, setBrowsingWithoutAgent] = useState<string | null>(null)
  const [agentSetupOpen, setAgentSetupOpen] = useState(false)
  const sourceGraphFiles = useMemo(() => graphFiles.filter(isCanvasSourceFile), [graphFiles])
  const architectureIsAuthored = readAuthorship({
    systems: graphSystems,
    files: sourceGraphFiles,
  }).authored > 0

  const {
    applySnapshot,
    beginIndexing,
    setConnectionStatus,
    setCurrentProject: setStoreProject,
    setIndexingComplete,
  } = useGraphStore(
    useShallow(s => ({
      applySnapshot: s.applySnapshot,
      beginIndexing: s.beginIndexing,
      setConnectionStatus: s.setConnectionStatus,
      setCurrentProject: s.setCurrentProject,
      setIndexingComplete: s.setIndexingComplete,
    }))
  )

  // In browser mode, connect to archd WebSocket on mount
  useEffect(() => {
    if (E2E_MODE) {
      if (E2E_HOME || E2E_SETUP) {
        setStoreProject(null)
        setConnectionStatus('connected')
        return
      }
      setStoreProject(E2E_PROJECT)
      setConnectionStatus('connected')
      applySnapshot(E2E_SNAPSHOT)
      // E2E-only affordance: expose the store so tests can drive live patches
      // (graph:patch choreography) deterministically without a real daemon.
      ;(window as unknown as { __axiomGraphStore?: unknown }).__axiomGraphStore = useGraphStore
      return
    }
    if (!window.axiom) {
      connectToArchd()
    }
    // Infra service registry - one fetch, shared by canvas nodes and dialogs
    void useRegistryStore.getState().fetchRegistry()
  }, [applySnapshot, setConnectionStatus, setStoreProject])

  // archd is restarted by the main process when it dies. Say so while it
  // happens, and say plainly when it will not come back.
  useEffect(() => {
    if (E2E_MODE || !window.axiom?.onArchdStatus) return
    return window.axiom.onArchdStatus(status => {
      if (status.state === 'restarting') {
        raiseNotice('archd-status', 'Reconnecting to Axiom\'s background service…',
          'It stopped unexpectedly and is restarting. The map resumes updating on its own.')
      } else if (status.state === 'running') {
        resolveInterruption('archd-status')
        resolveInterruption('archd-failed')
      } else {
        resolveInterruption('archd-status')
        raiseFailure('archd-failed', 'Axiom\'s background service is not running', status.detail, [{
          label: 'Try again',
          primary: true,
          run: () => {
            resolveInterruption('archd-failed')
            void window.axiom.restartArchd()
          },
        }, {
          label: 'Report a bug',
          run: () => { void window.axiom.reportBug() },
        }])
      }
    })
  }, [])

  // An update never interrupts work: it waits in the lane until chosen.
  const updateStatus = useUpdateStatus()
  const workbenchOpen = currentProject !== null
  useEffect(() => {
    if (!workbenchOpen || updateStatus.state === 'idle') return
    if (updateStatus.state === 'ready') {
      raiseInvitation('app-update', `Axiom ${updateStatus.version} is ready`,
        'It installs when you restart Axiom. Your projects reopen where you left them.',
        [{ label: 'Restart to update', primary: true, run: () => { void window.axiom.installUpdate() } }],
        undefined, 'It will also install the next time you quit Axiom.')
    } else {
      raiseInvitation('app-update', `Axiom ${updateStatus.version} is available`,
        'Download it from the release page and replace this copy.',
        [{ label: 'Download', primary: true, run: () => { void window.axiom.installUpdate() } }])
    }
  }, [workbenchOpen, updateStatus])

  // A delta:ready event covers project open. Focus refresh covers the other
  // daily path: Axiom stayed open while an agent changed the architecture.
  useEffect(() => {
    if (E2E_MODE) return
    return subscribeToDeltaRefresh(window, () => useGraphStore.getState().loadDelta())
  }, [])

  useEffect(() => {
    if (!currentProject) return
    const onProposal = (event: Event) => {
      const notice = (event as CustomEvent<{ workspaceId: string; proposalId: string }>).detail
      if (notice.workspaceId !== currentProject.id) return
      // Decision and layout writes update their own store. A new proposal
      // refreshes the invitation even when Axiom was already open.
      const proposalStore = useProposalStore.getState()
      if (proposalStore.proposal?.id !== notice.proposalId) void proposalStore.load(currentProject.id)
    }
    const refreshProposal = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:7743/api/architecture-proposals?workspace=${encodeURIComponent(currentProject.id)}`)
        if (!response.ok) return
        const proposals = await response.json() as Array<{ id: string }>
        const head = proposals[0]
        if (head && useProposalStore.getState().proposal?.id !== head.id) {
          await useProposalStore.getState().load(currentProject.id)
        }
      } catch { /* the daemon can reconnect before its API is ready */ }
    }
    window.addEventListener('axiom:proposal', onProposal)
    window.addEventListener('axiom:proposal-refresh', refreshProposal)
    return () => {
      window.removeEventListener('axiom:proposal', onProposal)
      window.removeEventListener('axiom:proposal-refresh', refreshProposal)
    }
  }, [currentProject?.id])

  // Load this project's onboarding progress before anything renders against it,
  // so the guide and the status bar agree about where the user left off.
  useEffect(() => {
    if (currentProject) enterOnboardingProject(currentProject.id)
  }, [currentProject, enterOnboardingProject])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (currentProject) setSearchOpen(s => !s)
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentProject])

  const openProject = useCallback(async (incomingConfig: ProjectConfig) => {
    let config = migrateLegacyProjectLifecycle(incomingConfig)
    let returning = projectHasEnteredWorkbench(config)
    // Older builds did not persist this milestone. Their existing index is
    // durable evidence that opening should go straight to the workbench.
    if (!returning && window.axiom) {
      try {
        const scope = await fetch(`http://127.0.0.1:7743/api/workspace-scope/${encodeURIComponent(config.id)}?rootPath=${encodeURIComponent(config.rootPath)}`)
        if (scope.ok && ((await scope.json()) as { indexed?: boolean }).indexed) returning = true
      } catch { /* a genuinely new project still follows its initial journey */ }
    }
    config = { ...config, workbenchOpenedAt: config.workbenchOpenedAt || Date.now() }
    setCurrentProject(config)
    setStoreProject(config)
    // Questions and failures belong to the project that raised them. A new
    // workspace starts with an empty lane.
    useInterruptionStore.getState().clear()
    const isBlankProject = projectUsesBlankSetup(config)
    setInitialJourneyProjectId(returning ? null : config.id)
    setReviewActive(!returning && !isBlankProject && !config.reviewCompletedAt)
    setCreatedProjectId(isBlankProject ? config.id : null)

    if (window.axiom) {
      beginIndexing()
      // Save to recent projects list via IPC. Failing here used to leave the
      // workbench mounted against a project that never actually opened, so the
      // user got an empty canvas with no way to tell it had failed.
      try {
        await window.axiom.openProject(config)
      } catch (err) {
        console.error('[openProject] could not record the project:', err)
        void forgetOpenProject()
        setCurrentProject(null)
        setStoreProject(null)
        raiseFailure(
          'project-open',
          `Could not open ${config.name}`,
          err instanceof Error ? err.message : String(err),
        )
        return
      }
      void rememberOpenProject(config.id).catch(error =>
        raiseFailure('resume-save', 'Could not save project resume state', String(error)))
      // Connect to archd WebSocket for real-time graph updates
      connectToArchd('ws://127.0.0.1:7744/ws')
      // Register workspace with archd and start indexing
      console.log('[openProject] posting workspace:', { workspaceId: config.id, rootPath: config.rootPath, ignoredPaths: config.ignoredPaths })
      // The app starts archd and can open the last project in the same
      // second, before archd is listening. One refused connection then raised
      // a permanent "could not reach archd" over a canvas that loaded moments
      // later. Retry while the daemon starts; only a daemon that never
      // answers is a failure.
      const registerWorkspace = async (): Promise<Response> => {
        let lastError: unknown
        for (let attempt = 0; attempt < 12; attempt++) {
          try {
            return await fetch('http://127.0.0.1:7743/api/workspace', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                workspaceId: config.id,
                name: config.name,
                rootPath: config.rootPath,
                ignoredPaths: config.ignoredPaths,
                sourceBoundariesReviewedAt: config.sourceBoundariesReviewedAt,
              }),
            })
          } catch (err) {
            lastError = err
            await new Promise(resolve => setTimeout(resolve, Math.min(400 * (attempt + 1), 2000)))
          }
        }
        throw lastError
      }
      registerWorkspace().then(async response => {
        // archd answered but refused the project - for instance a database
        // written by a newer Axiom. Say exactly that, not "unreachable".
        if (!response.ok) {
          setIndexingComplete()
          let detail = `archd answered ${response.status}.`
          try {
            const body = await response.json() as { error?: string }
            if (body.error) detail = body.error
          } catch { /* keep the status line */ }
          raiseFailure('workspace-register', `Could not open ${config.name}`,
            `${detail} Your code is untouched.`)
          return
        }
        // Snapshot is pushed over WS on open, but if the socket connects a
        // beat late the broadcast is missed and the canvas stays empty - pull
        // it explicitly, retrying while indexing warms up.
        let tries = 0
        const pull = async () => {
          tries++
          // A WebSocket patch may beat this cold-load fallback. Once live data
          // exists, never replace it with a snapshot that would clear node FX.
          const live = useGraphStore.getState()
          if (live.systems.length > 0 || live.files.length > 0 || live.infraNodes.length > 0) {
            return
          }
          try {
            const res = await fetch(`http://127.0.0.1:7743/api/snapshot/${config.id}`)
            if (res.ok) {
              const snap = await res.json()
              const hasGraph = (snap.systems?.length ?? 0) > 0 ||
                (snap.files?.length ?? 0) > 0 ||
                (snap.infraNodes?.length ?? 0) > 0
              if (hasGraph || tries >= 10) {
                const latest = useGraphStore.getState()
                if (latest.systems.length > 0 || latest.files.length > 0 || latest.infraNodes.length > 0) {
                  return
                }
                applySnapshot(snap)
                return
              }
            }
          } catch { /* archd still starting */ }
          if (tries < 10) {
            setTimeout(pull, 1500)
            return
          }
          // Giving up silently left the user staring at a blank canvas with
          // nothing to read and nothing to click. Say what happened, and make
          // retrying one button rather than a restart.
          raiseFailure(
            'snapshot-cold-load',
            'Could not load this project from archd',
            'The daemon did not answer after 15 seconds. Your code is untouched - this is the map, not the repository.',
            [{
              label: 'Retry',
              primary: true,
              run: () => {
                useInterruptionStore.getState().resolve('snapshot-cold-load')
                tries = 0
                void pull()
              },
            }],
          )
        }
        void pull()
      }).catch(err => {
        setIndexingComplete()
        console.error('[openProject] archd workspace error:', err)
        // The retry above only exists once the workspace POST resolves. When
        // the POST itself rejects - archd not listening, port taken, refused
        // - nothing downstream ever runs, so this was the path that actually
        // produced the silent blank canvas.
        raiseFailure(
          'workspace-register',
          'Could not reach archd to open this project',
          `${err instanceof Error ? err.message : String(err)} - your code is untouched; this is the map, not the repository.`,
          [{
            label: 'Retry',
            primary: true,
            run: () => {
              useInterruptionStore.getState().resolve('workspace-register')
              void openProjectRef.current?.(config)
            },
          }],
        )
      })
    } else {
      // Browser demo: load fake data
      setConnectionStatus('connected')
      setTimeout(() => {
        applySnapshot(demoSnapshot)
      }, 800)
    }
  }, [applySnapshot, beginIndexing, setConnectionStatus, setIndexingComplete, setStoreProject])

  // Lets a Retry action re-run the open without making openProject depend on
  // itself, which useCallback cannot express.
  const openProjectRef = useRef(openProject)
  useEffect(() => { openProjectRef.current = openProject }, [openProject])

  const routeProjectBySourceBoundaryState = useCallback(async (config: ProjectConfig) => {
    if (sourceBoundariesAreComplete(config)) {
      await openProject(config)
      return
    }

    // Migrate projects indexed before explicit completion state existed. The
    // backend is authoritative because projects.json/localStorage can be
    // cleared independently from the per-project index.
    const scopeUrl =
      `http://127.0.0.1:7743/api/workspace-scope/${encodeURIComponent(config.id)}?rootPath=${encodeURIComponent(config.rootPath)}`
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(scopeUrl)
      if (response.ok) {
        const status = await response.json() as {
          indexed: boolean
          ignoredPaths?: string[]
          sourceBoundariesReviewedAt?: number | null
        }
        const completed = resolveProjectSourceBoundaries(config, status)
        if (completed) {
          await openProject(completed)
          return
        }
      }
      } catch {
        // archd may still be starting directly after the Electron window.
      }
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    setPendingSetup(config)
  }, [openProject])

  // Resume where you were. Axiom opened on the launcher every single time, so
  // reaching your own codebase cost a click through a list you had already
  // chosen from yesterday - the wrong first impression for a tool meant to be
  // opened every morning. Runs once per launch, before anything is open.
  useEffect(() => {
    if (resumeChecked) return
    if (!window.axiom) { setResumeChecked(true); return }
    let active = true
    void (async () => {
      try {
        const recent = await window.axiom!.listRecentProjects()
        if (!active) return
        const storedResume = await window.axiom!.getResumeProjectId()
        const legacyResume = localStorage.getItem(RESUME_KEY)
        if (legacyResume) localStorage.removeItem(RESUME_KEY)
        const decision = resumeDecision({
          resumeProjectId: storedResume ?? legacyResume,
          recentIds: recent.map(project => project.id),
          readyIds: new Set(recent.filter(projectIsReady).map(project => project.id)),
        })
        if (decision.kind === 'resume') {
          const target = recent.find(project => project.id === decision.projectId)
          if (target) await openProject(target)
        }
      } catch {
        // A failed resume must never trap the user on a blank screen: fall
        // through to the launcher, which always works.
      } finally {
        if (active) setResumeChecked(true)
      }
    })()
    return () => { active = false }
  }, [resumeChecked, openProject])

  // Leaving a project. Deliberate, so the next launch honours it rather than
  // resuming straight back into what was just left. archd keeps the project
  // indexed; this closes the view, not the workspace.
  const closeProject = useCallback(async () => {
    try { await forgetOpenProject() }
    catch (error) {
      raiseFailure('resume-clear', 'Could not clear project resume state', String(error))
      return
    }
    useInterruptionStore.getState().clear()
    setCurrentProject(null)
    setStoreProject(null)
    setCompletedAgentSetupId(null)
    setInitialJourneyProjectId(null)
    setBrowsingWithoutAgent(null)
    setAgentSetupOpen(false)
    setReviewActive(false)
    setDocumentsOpen(false)
  }, [setStoreProject])

  const openProjectDialog = useCallback(async () => {
    if (window.axiom) {
      const config = await window.axiom.openProjectDialog()
      if (config) {
        await routeProjectBySourceBoundaryState(config)
      }
    }
  }, [routeProjectBySourceBoundaryState])

  const confirmSetup = useCallback((config: ProjectConfig) => {
    setPendingSetup(null)
    openProject(config)
  }, [openProject])

  const cancelSetup = useCallback(() => {
    setPendingSetup(null)
  }, [])

  // Project setup configuration screen (after folder picked, before indexing)
  if (pendingSetup) {
    return (
      <ProjectSetupScreen
        baseConfig={pendingSetup}
        onConfirm={confirmSetup}
        onCancel={cancelSetup}
      />
    )
  }

  // Hold the frame while we decide whether to resume. Without this the
  // launcher paints for a beat and is yanked away, which reads as a glitch.
  if (!currentProject && !resumeChecked) {
    return <div className="axiom-resume-hold" aria-busy="true" aria-label="Opening your last project" />
  }

  // Home screen when no project is open
  if (!currentProject) {
    return (
      <HomeScreen
        onOpenProject={(config) => {
          void routeProjectBySourceBoundaryState(config)
        }}
        onOpenDialog={openProjectDialog}
        onCreateProject={(config) => {
          // A brand-new project has no source boundaries to choose, but it still
          // needs a live agent before the user begins on its empty Floor.
          const completed = completeSourceBoundaries({
            ...config,
            creationSource: 'new-project',
            rootIsEmpty: true,
          }, [])
          setCreatedProjectId(completed.id)
          openProject(completed)
        }}
      />
    )
  }

  const blankProject = currentProject
    ? E2E_BLANK_PROJECT || projectUsesBlankSetup(currentProject)
    : false
  const blankAgentSetupComplete = currentProject
    ? completedAgentSetupId === currentProject.id || (currentProject.agentSetupCompletedAt ?? 0) > 0
    : false
  const needsAgentSetup = currentProject && initialJourneyProjectId === currentProject.id && (blankProject
    ? !blankAgentSetupComplete
    : !architectureIsAuthored && browsingWithoutAgent !== currentProject.id)
  if (currentProject && (E2E_CONNECT || (!E2E_MODE && (agentSetupOpen || needsAgentSetup)))) {
    return (
      <ConnectAgentScreen
        project={currentProject}
        fileCount={sourceGraphFiles.length}
        indexing={graphIndexing}
        blankProject={blankProject}
        backLabel={agentSetupOpen ? '← Canvas' : '← Projects'}
        onComplete={() => {
          void window.axiom?.completeProjectLifecycle(currentProject.id, 'agentSetupCompletedAt')
            .then(updated => setCurrentProject(current => current?.id === updated.id ? updated : current))
            .catch(error => raiseFailure('agent-setup-save', 'Could not save agent setup', String(error)))
          setCompletedAgentSetupId(currentProject.id)
          setAgentSetupOpen(false)
        }}
        onReview={() => { setBrowsingWithoutAgent(currentProject.id); setAgentSetupOpen(false) }}
        onSkip={() => {
          setBrowsingWithoutAgent(currentProject.id)
          setAgentSetupOpen(false)
          void window.axiom?.completeProjectLifecycle(currentProject.id, 'reviewCompletedAt')
            .then(updated => setCurrentProject(current => current?.id === updated.id ? updated : current))
            .catch(error => raiseFailure('review-save', 'Could not save review completion', String(error)))
          setReviewActive(false)
        }}
        onBack={agentSetupOpen ? () => setAgentSetupOpen(false) : closeProject}
      />
    )
  }

  if (currentProject && reviewActive) {
    return (
      <ProjectReviewScreen
        project={currentProject}
        onFinishReview={() => {
          void window.axiom?.completeProjectLifecycle(currentProject.id, 'reviewCompletedAt')
            .then(updated => setCurrentProject(current => current?.id === updated.id ? updated : current))
            .catch(error => raiseFailure('review-save', 'Could not save review completion', String(error)))
          setReviewActive(false)
        }}
        onBack={() => setBrowsingWithoutAgent(null)}
      />
    )
  }

  return (
    <ReactFlowProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        {/* Top toolbar */}
        <Toolbar
          onSearch={() => setSearchOpen(true)}
          onCloseProject={closeProject}
          onManageAgentConnections={() => setAgentSetupOpen(true)}
          projectName={currentProject.name}
          agentLogOpen={agentLogOpen}
          onToggleAgentLog={() => setAgentLogOpen(open => !open)}
        />

        {/* Sheet rail + canvas area */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <SheetRail />
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* REVISION 2: sheets are layers over the live canvas, not separate
              views - AxiomCanvas renders the base layer + active sheet overlay. */}
          <ErrorBoundary>
            <AxiomCanvas />
          </ErrorBoundary>

          {/* Beside the canvas, not inside it: the ghost that carries a node
              between the Floor and the unsorted bin must be able to appear
              without re-rendering the canvas that owns the drag. */}
          <BinDragGhostLayer />

          {documentsOpen && <DocumentsPanel onClose={() => setDocumentsOpen(false)} />}

          {/* Paint servers every node references. Defined once; renders nothing. */}
          <PaperTextureDefs />

          {/* Morning Delta - what changed while you weren't watching */}
          <DeltaPanel />

          {/* The architecture an agent proposed, for you to confirm */}
          <ArchitectureProposalPanel />

          {/* Detail panel (right side) */}
          <DetailPanel />

          {/* Search overlay */}
          {searchOpen && <SearchBar onClose={() => setSearchOpen(false)} />}

          {/* The one surface anything is allowed to interrupt you through.
              Everything below raises into it and renders nothing itself. */}
          <InterruptionLane />


          {/* Raises a decision when an agent asks to override a runtime value */}
          <InjectConfirmBanner />

          {/* Recovers the "indexed nothing, blank Floor, nothing to click" trap */}
          <EmptyIndexNotice
            onReconfigure={() => setPendingSetup(currentProject)}
            hasExclusions={(currentProject.ignoredPaths?.length ?? 0) > 0}
            suppress={createdProjectId === currentProject.id}
          />

          {/* Agent activity log - everything the agent is doing, live */}
          {agentLogOpen && <AgentLogPanel onClose={() => setAgentLogOpen(false)} />}

          {/* The agent's investigation: hypotheses, runs and their evidence,
              verdicts, the conclusion, and a way to talk back. Before the
              replay bar so the transport can move out from under it. */}
          <ErrorBoundary>
            <CasePanel />
          </ErrorBoundary>

          {/* Investigation Capture replay controls */}
          <ReplayBar />

          {/* Setup tips wait while a case is open or replaying - in a trial
              the first one sat on top of the replay transport. */}
          {!E2E_MODE && !caseOpen && <OnboardingGuide projectId={currentProject.id} />}

          {/* Which worktree each agent is in, and how the branches relate.
              Boundaried because a panel throwing during render takes the whole
              workbench with it - a malformed collisions response did exactly
              that, blanking the app behind a "Render Error" screen. Losing one
              panel is acceptable; losing the canvas is not. */}
          <ErrorBoundary>
            <AgentLane />
          </ErrorBoundary>
          </div>
        </div>

        {/* Status bar */}
        <StatusBar workspaceId={currentProject.id} />
      </div>
    </ReactFlowProvider>
  )
}
