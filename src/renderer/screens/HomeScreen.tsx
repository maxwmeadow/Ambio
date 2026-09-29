import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import { clearProjectLocalState } from '../projectLocalState'
import { AxiomMark, WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import { handleLauncherKey, launcherProjects } from './homeScreenModel'

interface HomeScreenProps {
  onOpenProject: (config: ProjectConfig) => void
  onOpenDialog: () => void
  onCreateProject: (config: ProjectConfig) => void
}

interface CommandDeckStatus {
  workspaceId: string
  indexed: boolean
  files: number
  systems: number
  unreviewedClaims: number
  unexplained: number
  unexpected: number
  activeWork: Array<{ id: string; agent?: string; goal: string; startedAt: number }>
  openPlans: number
  pendingProposals: number
  lastActivityAt: number
}

const WORKBENCH_CAPABILITIES = [
  { index: '01', title: 'Living code topology', detail: 'Automatically maps system boundaries, imports, and call graphs as code changes.' },
  { index: '02', title: 'Visual agent dispatch', detail: 'Sketch new components on canvas; connected MCP agents turn your design into code.' },
  { index: '03', title: 'Semantic zoom', detail: 'Glide seamlessly from high-level architecture down to files, symbols, and live source.' },
] as const

// Mirror of the folder-name sanitiser in main.ts, for the live path preview.
function safeFolderName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
}

export function HomeScreen({ onOpenProject, onOpenDialog, onCreateProject }: HomeScreenProps) {
  const [recentProjects, setRecentProjects] = useState<ProjectConfig[]>([])
  const [deckStatus, setDeckStatus] = useState<Record<string, CommandDeckStatus>>({})
  const [projectToDelete, setProjectToDelete] = useState<ProjectConfig | null>(null)
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  // The project whose actions menu is open, and a moved project awaiting a
  // decision about where its folder went.
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const [missingProject, setMissingProject] = useState<ProjectConfig | null>(null)
  const [locating, setLocating] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // New Project flow
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLocation, setNewLocation] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Search & keyboard navigation for recent projects
  const [searchQuery, setSearchQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [isSearchFocused, setIsSearchFocused] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const recentListRef = useRef<HTMLUListElement>(null)

  const projectList = useMemo(
    () => launcherProjects(recentProjects, searchQuery, showAll),
    [recentProjects, searchQuery, showAll],
  )
  const filteredProjects = projectList.visible

  // A moved folder cannot be opened; ask where it went instead of failing
  // inside the workbench with an empty map.
  const openOrLocate = (project: ProjectConfig) => {
    if (project.rootMissing) {
      setRemoveError(null)
      setMissingProject(project)
      return
    }
    onOpenProject(project)
  }

  useEffect(() => {
    if (activeIndex !== null && (activeIndex >= filteredProjects.length || activeIndex < 0)) {
      setActiveIndex(filteredProjects.length > 0 ? 0 : null)
    }
  }, [filteredProjects.length, activeIndex])

  useEffect(() => {
    if (activeIndex === null) return
    recentListRef.current?.querySelector(`[data-project-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, filteredProjects])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Do not intercept if a modal dialog is active
      if (projectToDelete || creating || missingProject || menuProjectId) return

      const action = handleLauncherKey(event, {
        isSearchFocused,
        hasQuery: searchQuery.length > 0,
        totalProjects: filteredProjects.length,
        activeIndex,
      })

      switch (action.type) {
        case 'FOCUS_SEARCH':
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
          break
        case 'NAVIGATE':
          setActiveIndex(action.nextIndex ?? null)
          break
        case 'OPEN':
          if (action.nextIndex !== undefined && action.nextIndex !== null && filteredProjects[action.nextIndex]) {
            openOrLocate(filteredProjects[action.nextIndex])
          }
          break
        case 'CLEAR_SEARCH':
          setSearchQuery('')
          setActiveIndex(null)
          searchInputRef.current?.blur()
          break
        case 'NOOP':
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [projectToDelete, creating, missingProject, menuProjectId, isSearchFocused, searchQuery, filteredProjects, activeIndex, onOpenProject])

  useEffect(() => {
    let active = true
    if (window.axiom) {
      void window.axiom.listRecentProjects()
        .then(projects => { if (active) setRecentProjects(projects) })
        .catch(() => { if (active) setRecentProjects([]) })
    }
    return () => { active = false }
  }, [])

  // Status follows whatever rows are on screen. Fetching a fixed first few
  // left every later row reading "READING MAP…" forever.
  const requestedStatus = useRef(new Set<string>())
  useEffect(() => {
    if (!window.axiom) return
    const pending = filteredProjects.filter(project =>
      !project.rootMissing && !requestedStatus.current.has(project.id))
    if (pending.length === 0) return
    pending.forEach(project => requestedStatus.current.add(project.id))
    let active = true
    void Promise.all(pending.map(async project => {
      try {
        const response = await fetch(
          `http://127.0.0.1:7743/api/command-deck?workspace=${encodeURIComponent(project.id)}`,
        )
        if (!response.ok) return null
        return await response.json() as CommandDeckStatus
      } catch {
        return null
      }
    })).then(statuses => {
      if (!active) return
      const found = statuses.filter((status): status is CommandDeckStatus => Boolean(status))
      if (found.length === 0) return
      setDeckStatus(previous => ({
        ...previous,
        ...Object.fromEntries(found.map(status => [status.workspaceId, status])),
      }))
    })
    return () => { active = false }
  }, [filteredProjects])

  // Close the row menu on any click elsewhere or Escape.
  useEffect(() => {
    if (!menuProjectId) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && (event.target as HTMLElement | null)?.closest('.axiom-launcher__row-menu')) return
      setMenuProjectId(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menuProjectId])

  const replaceProject = (updated: ProjectConfig) =>
    setRecentProjects(previous => previous.map(project => project.id === updated.id ? updated : project))

  const locateProject = async (project: ProjectConfig) => {
    if (!window.axiom) return
    setLocating(true)
    setRemoveError(null)
    try {
      const updated = await window.axiom.relocateProject(project.id)
      if (!updated) return
      replaceProject(updated)
      setMissingProject(null)
      onOpenProject(updated)
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Axiom could not use that folder.')
    } finally {
      setLocating(false)
    }
  }

  const setHidden = async (project: ProjectConfig, hidden: boolean) => {
    setMenuProjectId(null)
    if (!window.axiom) return
    try {
      replaceProject(await window.axiom.setProjectHidden(project.id, hidden))
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Axiom could not update the project list.')
    }
  }

  const revealLabel = window.axiom?.platform === 'darwin'
    ? 'Reveal in Finder'
    : window.axiom?.platform === 'win32' ? 'Show in Explorer' : 'Open containing folder'

  const confirmDelete = async () => {
    if (!projectToDelete) return
    if (!window.axiom) {
      setRecentProjects(previous => previous.filter(project => project.id !== projectToDelete.id))
      setProjectToDelete(null)
      return
    }
    setRemovingProjectId(projectToDelete.id)
    setRemoveError(null)
    try {
      await window.axiom.removeProject(projectToDelete.id)
      // Deleting is deleting. The database goes with the project; so does every
      // local hint keyed to it, or reopening the same folder later inherits
      // "you already reviewed this" from a workspace that no longer exists.
      clearProjectLocalState(projectToDelete.id)
      setRecentProjects(previous => previous.filter(project => project.id !== projectToDelete.id))
      setProjectToDelete(null)
    } catch (error) {
      setRemoveError(error instanceof Error
        ? error.message
        : 'Axiom could not delete this project. Nothing was removed from the project list.')
    } finally {
      setRemovingProjectId(null)
    }
  }

  const openDialog = () => {
    if (window.axiom) { onOpenDialog(); return }
    // Browser demo fallback
    onOpenProject({
      id: 'demo', name: 'Demo Project', rootPath: '/demo', ignoredPaths: [],
      languageOverrides: {}, layoutPreferences: { zoom: 0.5, panX: 0, panY: 0 }, openedAt: Date.now(),
    })
  }

  const startNew = () => {
    if (!window.axiom) {
      onCreateProject({
        id: 'demo-new', name: 'Untitled Model', rootPath: '/demo-new', ignoredPaths: [],
        languageOverrides: {}, layoutPreferences: { zoom: 1, panX: 0, panY: 0 }, openedAt: Date.now(),
      })
      return
    }
    setNewName(''); setNewLocation(null); setCreateError(null); setCreating(true)
  }

  const chooseLocation = async () => {
    if (!window.axiom) return
    const dir = await window.axiom.chooseDirectory()
    if (dir) { setNewLocation(dir); setCreateError(null) }
  }

  const confirmCreate = async () => {
    if (!window.axiom || !newLocation || !safeFolderName(newName)) return
    setCreateBusy(true); setCreateError(null)
    try {
      const config = await window.axiom.createProject(newLocation, newName)
      onCreateProject(config)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create the project.')
      setCreateBusy(false)
    }
  }

  const safeName = safeFolderName(newName)
  const canCreate = !!newLocation && !!safeName && !createBusy

  return (
    <main className="axiom-launcher">
      <WorkbenchTitleBar className="axiom-launcher__titlebar" context="Project Navigator" status="READY" />

      <div className="axiom-launcher__body">
        <section className="axiom-launcher__introduction" aria-labelledby="axiom-launcher-title">
          <div className="axiom-launcher__eyebrow">SPATIAL ARCHITECTURE WORKBENCH</div>
          <AxiomMark />
          <h1 id="axiom-launcher-title">Axiom</h1>
          <p className="axiom-launcher__statement">
            See your entire codebase.<br />
            Steer what your agents build.
          </p>
          <p className="axiom-launcher__description">
            A live architecture canvas wired directly to your repository and AI coding agents.
            Explore real system topology, sketch new features as visual blueprints, and review
            agent changes spatially instead of reading 40-file diffs.
          </p>

          <ol className="axiom-launcher__capabilities">
            {WORKBENCH_CAPABILITIES.map(capability => (
              <li key={capability.index}>
                <span>{capability.index}</span>
                <div>
                  <strong>{capability.title}</strong>
                  <p>{capability.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="axiom-launcher__workspace" aria-labelledby="axiom-workspace-title">
          <div className="axiom-launcher__workspace-heading">
            <span>START</span>
            <div>
              <h2 id="axiom-workspace-title">Command Deck</h2>
              <p>See what changed, what agents are doing, and what intent is still open — then enter the canvas.</p>
            </div>
          </div>

          <div className="axiom-launcher__forks">
            <button className="axiom-launcher__fork axiom-launcher__fork--new" onClick={startNew}>
              <span className="axiom-launcher__fork-glyph" aria-hidden="true">＋</span>
              <span className="axiom-launcher__fork-copy">
                <strong>New Project</strong>
                <small>Create an empty workspace and sketch architecture for agents to build.</small>
              </span>
              <span className="axiom-launcher__fork-arrow" aria-hidden="true">→</span>
            </button>

            <button className="axiom-launcher__fork axiom-launcher__fork--open" onClick={openDialog}>
              <span className="axiom-launcher__fork-glyph" aria-hidden="true">▤</span>
              <span className="axiom-launcher__fork-copy">
                <strong>Open Codebase</strong>
                <small>Index an existing repository into a living, agent-connected architecture map.</small>
              </span>
              <span className="axiom-launcher__fork-arrow" aria-hidden="true">→</span>
            </button>
          </div>

          {recentProjects.length > 0 && (
            <div className="axiom-launcher__recent">
              <div className="axiom-launcher__section-label">
                <span>{projectList.mode === 'search' ? 'MATCHING PROJECTS' : projectList.mode === 'all' ? 'ALL PROJECTS' : 'RECENTLY OPENED'}</span>
                <small>{filteredProjects.length} OF {recentProjects.length} PROJECTS</small>
              </div>

              <div className="axiom-launcher__search-box">
                <span className="axiom-launcher__search-icon" aria-hidden="true">⌕</span>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={event => {
                    setSearchQuery(event.target.value)
                    setActiveIndex(0)
                  }}
                  onFocus={() => setIsSearchFocused(true)}
                  onBlur={() => setIsSearchFocused(false)}
                  placeholder="Search all projects (/ to focus, ↑↓ to navigate)…"
                  aria-label="Search all projects"
                  spellCheck={false}
                />
                {searchQuery ? (
                  <button
                    type="button"
                    className="axiom-launcher__search-clear"
                    onClick={() => {
                      setSearchQuery('')
                      setActiveIndex(null)
                      searchInputRef.current?.focus()
                    }}
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                ) : (
                  <kbd className="axiom-launcher__search-shortcut" title="Press / to focus search">/</kbd>
                )}
              </div>

              {removeError && (
                <div className="axiom-launcher__remove-error" role="alert">{removeError}</div>
              )}

              {filteredProjects.length === 0 ? (
                <div className="axiom-launcher__empty-search" role="status">
                  No projects matching &ldquo;{searchQuery}&rdquo;
                </div>
              ) : (
                <ul ref={recentListRef} aria-label="Recent projects">
                  {filteredProjects.map((project, index) => {
                    const isActive = index === activeIndex
                    const menuOpen = menuProjectId === project.id
                    return (
                      <li
                        key={project.id}
                        data-project-index={index}
                        className={[
                          'axiom-launcher__recent-item',
                          isActive ? 'axiom-launcher__recent-item--active' : '',
                          project.rootMissing ? 'axiom-launcher__recent-item--missing' : '',
                        ].filter(Boolean).join(' ')}
                        onMouseEnter={() => setActiveIndex(index)}
                      >
                        <button
                          className={`axiom-launcher__recent-open${isActive ? ' axiom-launcher__recent-open--active' : ''}`}
                          onClick={() => openOrLocate(project)}
                          aria-label={project.rootMissing ? `Locate the folder for ${project.name}` : `Open ${project.name}`}
                        >
                          <span className="axiom-launcher__project-index" aria-hidden="true">◆</span>
                          <span className="axiom-launcher__project-copy">
                            <strong>{project.name}</strong>
                            <small title={project.rootPath}>{project.rootPath}</small>
                            {project.rootMissing
                              ? (
                                <span className="axiom-launcher__deck-signals">
                                  <span className="axiom-launcher__deck-signal axiom-launcher__deck-signal--attention">FOLDER NOT FOUND · LOCATE</span>
                                </span>
                              )
                              : <ProjectDeckSignals status={deckStatus[project.id]} />}
                          </span>
                          <time dateTime={new Date(project.openedAt).toISOString()}>{timeAgo(project.openedAt)}</time>
                        </button>
                        <div className="axiom-launcher__row-menu">
                          <button
                            className="axiom-launcher__recent-remove"
                            onClick={() => setMenuProjectId(menuOpen ? null : project.id)}
                            disabled={removingProjectId !== null}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label={`Actions for ${project.name}`}
                            title="Project actions"
                          >
                            {removingProjectId === project.id ? '…' : '⋯'}
                          </button>
                          {menuOpen && (
                            <div className="axiom-launcher__menu" role="menu" aria-label={`${project.name} actions`}>
                              <button role="menuitem" autoFocus onClick={() => { setMenuProjectId(null); openOrLocate(project) }}>
                                {project.rootMissing ? 'Locate folder…' : 'Open'}
                              </button>
                              {!project.rootMissing && (
                                <button role="menuitem" onClick={() => { setMenuProjectId(null); window.axiom?.showInFolder(project.rootPath) }}>
                                  {revealLabel}
                                </button>
                              )}
                              {!project.rootMissing && (
                                <button role="menuitem" onClick={() => { setMenuProjectId(null); void locateProject(project) }}>
                                  Change folder location…
                                </button>
                              )}
                              {project.hiddenFromRecents
                                ? <button role="menuitem" onClick={() => void setHidden(project, false)}>Show in recents</button>
                                : <button role="menuitem" onClick={() => void setHidden(project, true)}>Hide from recents</button>}
                              <hr />
                              <button
                                role="menuitem"
                                className="axiom-launcher__menu-danger"
                                onClick={() => {
                                  setMenuProjectId(null)
                                  setRemoveError(null)
                                  setProjectToDelete(project)
                                }}
                              >
                                Delete project map…
                              </button>
                            </div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}

              {!searchQuery && (projectList.notShown > 0 || showAll) && (
                <button
                  type="button"
                  className="axiom-launcher__show-all"
                  onClick={() => { setShowAll(value => !value); setActiveIndex(null) }}
                >
                  {showAll ? 'Show recent projects only' : `Show all ${recentProjects.length} projects`}
                </button>
              )}
            </div>
          )}

          <footer className="axiom-launcher__local-note">
            <span aria-hidden="true" />
            <p><strong>LOCAL WORKSPACE</strong> Project indexes and layout state remain on this machine.</p>
          </footer>
        </section>
      </div>

      {projectToDelete && (
        <div
          className="axiom-create__scrim"
          onClick={() => removingProjectId === null && setProjectToDelete(null)}
        >
          <div
            className="axiom-remove-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="axiom-remove-title"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
              if (event.key === 'Escape' && removingProjectId === null) {
                setProjectToDelete(null)
              }
            }}
            tabIndex={-1}
          >
            <div className="axiom-remove-modal__head">
              <span className="axiom-remove-modal__kicker">DELETE PROJECT MAP</span>
              <h3 id="axiom-remove-title">Delete the map for &ldquo;{projectToDelete.name}&rdquo;?</h3>
              <button
                className="axiom-remove-modal__close"
                onClick={() => setProjectToDelete(null)}
                aria-label="Cancel"
                disabled={removingProjectId !== null}
              >
                ×
              </button>
            </div>

            <p className="axiom-remove-modal__body">
              Axiom will forget this project: its systems, layout, sheets, and change history are deleted and cannot be
              recovered. Your code on disk is not touched. To only tidy this list, use Hide from recents instead.
            </p>

            {removeError && <div className="axiom-create__error" role="alert">{removeError}</div>}

            <div className="axiom-remove-modal__actions">
              <button
                className="axiom-remove-modal__cancel"
                onClick={() => setProjectToDelete(null)}
                disabled={removingProjectId !== null}
                autoFocus
              >
                Cancel
              </button>
              <button
                className="axiom-remove-modal__danger"
                onClick={() => void confirmDelete()}
                disabled={removingProjectId !== null}
              >
                {removingProjectId !== null ? 'Deleting…' : 'Delete Map'}
              </button>
            </div>
          </div>
        </div>
      )}

      {missingProject && (
        <div className="axiom-create__scrim" onClick={() => !locating && setMissingProject(null)}>
          <div
            className="axiom-remove-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="axiom-missing-title"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => { if (event.key === 'Escape' && !locating) setMissingProject(null) }}
            tabIndex={-1}
          >
            <div className="axiom-remove-modal__head">
              <span className="axiom-remove-modal__kicker">FOLDER NOT FOUND</span>
              <h3 id="axiom-missing-title">Where did &ldquo;{missingProject.name}&rdquo; go?</h3>
              <button
                className="axiom-remove-modal__close"
                onClick={() => setMissingProject(null)}
                aria-label="Cancel"
                disabled={locating}
              >
                ×
              </button>
            </div>
            <p className="axiom-remove-modal__body">
              Axiom can&rsquo;t find <code>{missingProject.rootPath}</code>. If you moved or renamed the folder, point
              Axiom at its new location and the map, layout, and history come with it. Your files stay where they are.
            </p>
            {removeError && <div className="axiom-create__error" role="alert">{removeError}</div>}
            <div className="axiom-remove-modal__actions">
              <button
                className="axiom-remove-modal__cancel"
                onClick={() => { const project = missingProject; setMissingProject(null); setProjectToDelete(project) }}
                disabled={locating}
              >
                Delete Map
              </button>
              <button
                className="axiom-create__go"
                onClick={() => void locateProject(missingProject)}
                disabled={locating}
                autoFocus
              >
                {locating ? 'Moving map…' : 'Locate Folder…'}
              </button>
            </div>
          </div>
        </div>
      )}

      {creating && (
        <div className="axiom-create__scrim" onClick={() => !createBusy && setCreating(false)}>
          <div
            className="axiom-create"
            role="dialog"
            aria-modal="true"
            aria-labelledby="axiom-create-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="axiom-create__head">
              <span className="axiom-create__kicker">NEW PROJECT</span>
              <h3 id="axiom-create-title">Create a model from scratch</h3>
              <button className="axiom-create__close" onClick={() => setCreating(false)} aria-label="Cancel" disabled={createBusy}>×</button>
            </div>

            <label className="axiom-create__field">
              <span>PROJECT NAME</span>
              <input
                autoFocus
                value={newName}
                onChange={event => { setNewName(event.target.value); setCreateError(null) }}
                onKeyDown={event => { if (event.key === 'Enter' && canCreate) void confirmCreate() }}
                placeholder="e.g. pose-engine"
                spellCheck={false}
              />
            </label>

            <label className="axiom-create__field">
              <span>LOCATION</span>
              <button type="button" className="axiom-create__location" onClick={() => void chooseLocation()}>
                {newLocation
                  ? <code title={newLocation}>{newLocation}</code>
                  : <em>Choose a parent folder…</em>}
                <span aria-hidden="true">⌕</span>
              </button>
            </label>

            {newLocation && safeName && (
              <p className="axiom-create__preview">
                Creates <code>{newLocation}{newLocation.includes('\\') ? '\\' : '/'}{safeName}</code>
              </p>
            )}

            {createError && <div className="axiom-create__error" role="alert">{createError}</div>}

            <div className="axiom-create__actions">
              <button className="axiom-create__cancel" onClick={() => setCreating(false)} disabled={createBusy}>Cancel</button>
              <button className="axiom-create__go" onClick={() => void confirmCreate()} disabled={!canCreate}>
                {createBusy ? 'Creating…' : 'Create & Open'} <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

function ProjectDeckSignals({ status }: { status?: CommandDeckStatus }) {
  if (!status) {
    return <span className="axiom-launcher__deck-signals axiom-launcher__deck-signals--loading">READING MAP…</span>
  }
  if (!status.indexed) {
    return <span className="axiom-launcher__deck-signals">NOT INDEXED</span>
  }
  const signals: Array<{ label: string; tone?: string }> = []
  if (status.activeWork.length > 0) {
    signals.push({
      label: `${status.activeWork.length} AGENT${status.activeWork.length === 1 ? '' : 'S'} ACTIVE`,
      tone: 'live',
    })
  }
  if (status.unreviewedClaims > 0) {
    signals.push({ label: `${status.unreviewedClaims} TO REVIEW`, tone: 'review' })
  }
  if (status.unexplained > 0) {
    signals.push({ label: `${status.unexplained} UNEXPLAINED`, tone: 'attention' })
  }
  if (status.unexpected > 0) {
    signals.push({ label: `${status.unexpected} DRIFT`, tone: 'attention' })
  }
  if (status.openPlans > 0) {
    signals.push({ label: `${status.openPlans} OPEN PLAN${status.openPlans === 1 ? '' : 'S'}` })
  }
  if (status.pendingProposals > 0) {
    signals.push({ label: `${status.pendingProposals} PROPOSAL${status.pendingProposals === 1 ? '' : 'S'}` })
  }
  if (signals.length === 0) {
    signals.push({ label: `${status.systems} SYSTEMS · MAP CLEAN`, tone: 'clean' })
  }
  return (
    <span className="axiom-launcher__deck-signals">
      {signals.slice(0, 3).map(signal => (
        <span
          key={signal.label}
          className={signal.tone
            ? `axiom-launcher__deck-signal axiom-launcher__deck-signal--${signal.tone}`
            : 'axiom-launcher__deck-signal'}
        >
          {signal.label}
        </span>
      ))}
    </span>
  )
}

export function timeAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
