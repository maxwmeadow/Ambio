import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { COMMANDS, buildMenu, formatAccelerator, type MenuSection } from '../../shared/appMenu'
import { useGraphStore } from '../store/graphStore'
import { currentPlatform, emitCommand, requestOpenRecent } from './commands'
import type { ProjectConfig } from '../../shared/types'

/**
 * The menu bar on Windows and Linux, drawn inside Axiom's custom title bar.
 * macOS uses the native menu bar instead, so this renders nothing there.
 */
export function AppMenuBar() {
  const platform = currentPlatform()
  const projectOpen = useGraphStore(state => state.currentProject !== null)
  const [developer, setDeveloper] = useState(false)
  const [open, setOpen] = useState<MenuSection['id'] | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const bar = useRef<HTMLDivElement>(null)
  const [recent, setRecent] = useState<ProjectConfig[]>([])

  // Open Recent is read fresh each time the File menu opens.
  useEffect(() => {
    if (open !== 'file' || !window.axiom) return
    void window.axiom.listRecentProjects().then(projects => setRecent(
      projects
        .filter(project => !project.hiddenFromRecents && !project.rootMissing)
        .sort((left, right) => (right.openedAt ?? 0) - (left.openedAt ?? 0))
        .slice(0, 6),
    ))
  }, [open])

  useEffect(() => {
    if (!window.axiom) return
    void window.axiom.developerMenuEnabled().then(setDeveloper)
    return window.axiom.onSettingsChanged(() => { void window.axiom.developerMenuEnabled().then(setDeveloper) })
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(null)
        return
      }
      const target = event.target as HTMLElement | null
      if (!target?.closest('.axiom-menubar, .axiom-menubar__dropdown')) setOpen(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  if (platform === 'darwin' || !window.axiom) return null
  const sections = buildMenu(platform, { developer })

  const show = (id: MenuSection['id'], button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    setAnchor({ left: rect.left, top: rect.bottom })
    setOpen(id)
  }

  const section = sections.find(candidate => candidate.id === open)

  return (
    <>
      <div className="axiom-menubar" ref={bar} role="menubar" aria-label="Application menu">
        {sections.map(item => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === item.id}
            className={open === item.id ? 'axiom-menubar__top axiom-menubar__top--open' : 'axiom-menubar__top'}
            onMouseDown={event => {
              event.preventDefault()
              if (open === item.id) setOpen(null)
              else show(item.id, event.currentTarget)
            }}
            onMouseEnter={event => { if (open && open !== item.id) show(item.id, event.currentTarget) }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
                event.preventDefault()
                show(item.id, event.currentTarget)
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {/* Portalled out of the title bar so its text styles cannot leak in. */}
      {section && createPortal(
        <div
          className="axiom-menubar__dropdown"
          role="menu"
          aria-label={section.label}
          style={{ left: anchor.left, top: anchor.top }}
        >
          {section.entries.map((entry, index) => {
            if (entry.kind === 'separator') return <hr key={`separator-${index}`} />
            if (entry.kind === 'recent') {
              return (
                <div key="recent" className="axiom-menubar__recent" role="group" aria-label="Open Recent">
                  <span className="axiom-menubar__group-label">Open Recent</span>
                  {recent.length === 0 && <span className="axiom-menubar__empty">No recent projects</span>}
                  {recent.map(project => (
                    <button
                      key={project.id}
                      type="button"
                      role="menuitem"
                      title={project.rootPath}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => { setOpen(null); requestOpenRecent(project.id) }}
                    >
                      <span>{project.name}</span>
                    </button>
                  ))}
                  {recent.length > 0 && (
                    <button
                      type="button"
                      role="menuitem"
                      className="axiom-menubar__subtle"
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => { setOpen(null); emitCommand('project.clearRecent') }}
                    >
                      <span>{COMMANDS['project.clearRecent'].label}</span>
                    </button>
                  )}
                </div>
              )
            }
            if (entry.kind === 'role') {
              return (
                <button
                  key={entry.role}
                  type="button"
                  role="menuitem"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => { setOpen(null); void window.axiom.runMenuRole(entry.role) }}
                >
                  <span>{entry.label}</span>
                  {entry.accelerator && <kbd>{formatAccelerator(entry.accelerator, platform)}</kbd>}
                </button>
              )
            }
            const spec = COMMANDS[entry.id]
            const disabled = Boolean(spec.needsProject && !projectOpen)
            return (
              <button
                key={`${section.id}-${spec.id}`}
                type="button"
                role="menuitem"
                disabled={disabled}
                // Edit actions need the focused field to keep focus.
                onMouseDown={event => event.preventDefault()}
                onClick={() => { setOpen(null); emitCommand(spec.id) }}
              >
                <span>{spec.label}</span>
                {spec.accelerator && <kbd>{formatAccelerator(spec.accelerator, platform)}</kbd>}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
