import { useEffect, useMemo, useRef, useState } from 'react'
import { COMMANDS, buildMenu, commandForKey, formatAccelerator, paletteCommands, type CommandId } from '../../shared/appMenu'
import { DEFAULT_SETTINGS, UI_ZOOM_MAX, UI_ZOOM_MIN, type AppSettings } from '../../shared/appSettings'
import { useGraphStore } from '../store/graphStore'
import { currentPlatform, emitCommand, useCommandHandlers } from './commands'

type Dialog = 'palette' | 'settings' | 'shortcuts' | 'about' | null

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  const tag = element?.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(element?.isContentEditable)
}

/**
 * Owns every command shortcut and the app-level dialogs (command palette,
 * Settings, Keyboard Shortcuts, About). Mounted once, above every screen.
 */
export function GlobalCommands() {
  const projectOpen = useGraphStore(state => state.currentProject !== null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const platform = currentPlatform()

  const say = (message: string) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  // Keys → commands. Commands with a Cmd/Ctrl modifier work everywhere; bare
  // keys (Shift+1) never fire while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      const id = commandForKey(event, platform)
      if (!id) return
      const spec = COMMANDS[id]
      const modified = event.metaKey || event.ctrlKey
      if (!modified && isEditable(event.target)) return
      if (spec.needsProject && !useGraphStore.getState().currentProject) return
      event.preventDefault()
      emitCommand(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [platform])

  // The native macOS menu reports clicks here.
  useEffect(() => window.axiom?.onMenuCommand?.(id => emitCommand(id)), [])

  // Project commands enable and disable with the project.
  useEffect(() => { void window.axiom?.setMenuState?.({ projectOpen }) }, [projectOpen])

  useCommandHandlers({
    'view.commandPalette': () => setDialog(current => (current === 'palette' ? null : 'palette')),
    'app.settings': () => setDialog('settings'),
    'help.shortcuts': () => setDialog(current => (current === 'shortcuts' ? null : 'shortcuts')),
    'app.about': () => setDialog('about'),
    'app.checkUpdates': () => {
      if (!window.axiom) return
      say('Checking for updates…')
      void window.axiom.checkForUpdates().then(result => {
        say({
          'up-to-date': 'Axiom is up to date.',
          available: 'A new version is available - see the update notice.',
          unavailable: 'Updates are checked in installed builds only.',
          failed: 'Could not check for updates. Try again later.',
        }[result])
      })
    },
    'view.zoomIn': () => { void window.axiom?.zoom('in').then(factor => say(`Interface zoom ${Math.round(factor * 100)}%`)) },
    'view.zoomOut': () => { void window.axiom?.zoom('out').then(factor => say(`Interface zoom ${Math.round(factor * 100)}%`)) },
    'view.resetZoom': () => { void window.axiom?.zoom('reset').then(() => say('Interface zoom 100%')) },
    'view.fullScreen': () => { void window.axiom?.toggleFullScreen() },
    'help.docs': () => { void window.axiom?.openHelp('docs') },
    'help.privacy': () => { void window.axiom?.openHelp('privacy') },
    'help.license': () => { void window.axiom?.openHelp('license') },
    'help.reportBug': () => { void window.axiom?.reportBug() },
    'help.copyDiagnostics': () => { void window.axiom?.copyDiagnostics().then(() => say('Diagnostics copied to the clipboard.')) },
    'help.openLogs': () => { void window.axiom?.openLogsFolder() },
  })

  return (
    <>
      {dialog === 'palette' && <CommandPalette projectOpen={projectOpen} platform={platform} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog platform={platform} onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {toast && <div className="axiom-app-toast" role="status">{toast}</div>}
    </>
  )
}

// ─── Shared modal shell ─────────────────────────────────────────────────────

function Modal({ title, width, onClose, children, className = '' }: {
  title: string
  width: number
  onClose: () => void
  children: React.ReactNode
  className?: string
}) {
  const surface = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = surface.current?.querySelector<HTMLElement>('[autofocus], input, button, select')
    first?.focus()
    return () => previous?.focus?.()
  }, [])
  return (
    <div
      className="axiom-dialog-backdrop axiom-app-modal__backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
    >
      <section
        ref={surface}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`axiom-dialog-surface axiom-app-modal ${className}`.trim()}
        style={{ '--axiom-dialog-width': `${width}px` } as React.CSSProperties}
      >
        <header className="axiom-dialog-header axiom-app-modal__header">
          <h2 className="axiom-dialog-title">{title}</h2>
          <button type="button" className="axiom-app-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="axiom-app-modal__body">{children}</div>
      </section>
    </div>
  )
}

// ─── Command palette ────────────────────────────────────────────────────────

function CommandPalette({ projectOpen, platform, onClose }: {
  projectOpen: boolean
  platform: 'darwin' | 'win32' | 'linux'
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(() => paletteCommands(query, projectOpen), [query, projectOpen])
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (id: CommandId) => {
    onClose()
    // Let the palette unmount first so a command that opens a dialog gets focus.
    setTimeout(() => emitCommand(id), 0)
  }

  return (
    <div
      className="axiom-dialog-backdrop axiom-palette__backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <section className="axiom-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus
          className="axiom-palette__input"
          value={query}
          placeholder="Type a command…"
          aria-label="Command"
          aria-controls="axiom-palette-results"
          spellCheck={false}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, results.length - 1)) }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)) }
            if (event.key === 'Enter' && results[active]) { event.preventDefault(); run(results[active].id) }
          }}
        />
        <ul id="axiom-palette-results" ref={list} className="axiom-palette__results" role="listbox">
          {results.length === 0 && <li className="axiom-palette__empty">No matching commands</li>}
          {results.map((spec, index) => (
            <li
              key={spec.id}
              data-index={index}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'axiom-palette__item axiom-palette__item--active' : 'axiom-palette__item'}
              onMouseEnter={() => setActive(index)}
              onMouseDown={event => { event.preventDefault(); run(spec.id) }}
            >
              <span>{spec.label.replace(/…$/, '')}</span>
              {spec.accelerator && <kbd>{formatAccelerator(spec.accelerator, platform)}</kbd>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

// ─── Keyboard shortcuts ─────────────────────────────────────────────────────

function ShortcutsDialog({ platform, onClose }: { platform: 'darwin' | 'win32' | 'linux'; onClose: () => void }) {
  const sections = buildMenu(platform)
    .map(section => ({
      label: section.id === 'app' ? 'Axiom' : section.label,
      commands: section.entries
        .filter((entry): entry is { kind: 'command'; id: CommandId } => entry.kind === 'command')
        .map(entry => COMMANDS[entry.id])
        .filter(spec => spec.accelerator),
    }))
    .filter(section => section.commands.length > 0)
  const seen = new Set<CommandId>()
  return (
    <Modal title="Keyboard Shortcuts" width={560} onClose={onClose}>
      <div className="axiom-shortcuts">
        {sections.map(section => {
          const commands = section.commands.filter(spec => !seen.has(spec.id))
          commands.forEach(spec => seen.add(spec.id))
          if (commands.length === 0) return null
          return (
            <section key={section.label}>
              <h3>{section.label}</h3>
              <dl>
                {commands.map(spec => (
                  <div key={spec.id}>
                    <dt>{spec.label.replace(/…$/, '')}</dt>
                    <dd><kbd>{formatAccelerator(spec.accelerator!, platform)}</kbd></dd>
                  </div>
                ))}
              </dl>
            </section>
          )
        })}
        <section>
          <h3>Map</h3>
          <dl>
            <div><dt>Next / previous change while reviewing</dt><dd><kbd>J</kbd> <kbd>K</kbd></dd></div>
            <div><dt>Search projects on the launcher</dt><dd><kbd>/</kbd></dd></div>
          </dl>
        </section>
      </div>
    </Modal>
  )
}

// ─── About ──────────────────────────────────────────────────────────────────

function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ version: string; platform: string; isPackaged: boolean } | null>(null)
  useEffect(() => { void window.axiom?.getAppInfo().then(setInfo) }, [])
  return (
    <Modal title="About Axiom" width={420} onClose={onClose}>
      <div className="axiom-about">
        <strong>Axiom</strong>
        <p>Version {info?.version ?? '…'}{info && !info.isPackaged ? ' (development)' : ''}</p>
        <p>A live architecture map of your codebase, shared with your coding agents.</p>
        <p>Free software under the GNU Affero General Public License v3.0.</p>
        <div className="axiom-about__links">
          <button type="button" onClick={() => void window.axiom?.openHelp('license')}>License</button>
          <button type="button" onClick={() => void window.axiom?.openHelp('privacy')}>Privacy</button>
          <button type="button" onClick={() => void window.axiom?.openHelp('releases')}>Release notes</button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Settings ───────────────────────────────────────────────────────────────

type SettingsSection = 'general' | 'appearance' | 'agents' | 'privacy' | 'advanced'

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'agents', label: 'Agents' },
  { id: 'privacy', label: 'Privacy & Data' },
  { id: 'advanced', label: 'Advanced' },
]

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>('general')
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [initialMotion, setInitialMotion] = useState<AppSettings['reduceMotion'] | null>(null)
  const [paths, setPaths] = useState<{ config: string; data: string; logs: string } | null>(null)
  const [version, setVersion] = useState('')
  const [checkResult, setCheckResult] = useState<string | null>(null)
  const projectOpen = useGraphStore(state => state.currentProject !== null)

  useEffect(() => {
    if (!window.axiom) { setLoaded(true); return }
    void window.axiom.getSettings().then(current => {
      setSettings(current)
      setInitialMotion(current.reduceMotion)
      setLoaded(true)
    })
    void window.axiom.getAppPaths().then(setPaths)
    void window.axiom.getAppInfo().then(info => setVersion(info.version))
    return window.axiom.onSettingsChanged(setSettings)
  }, [])

  const update = (patch: Partial<AppSettings>) => {
    setSettings(current => ({ ...current, ...patch }))
    void window.axiom?.setSettings(patch).then(setSettings)
  }

  return (
    <Modal title="Settings" width={720} onClose={onClose} className="axiom-settings">
      <div className="axiom-settings__layout">
        <nav className="axiom-settings__nav" aria-label="Settings sections">
          {SECTIONS.map(item => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              className={section === item.id ? 'axiom-settings__nav-item axiom-settings__nav-item--active' : 'axiom-settings__nav-item'}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="axiom-settings__panel" aria-busy={!loaded}>
          {section === 'general' && (
            <>
              <Toggle
                label="Reopen the last project on launch"
                detail="Start where you left off. When off, Axiom always opens on the project list."
                checked={settings.reopenLastProject}
                onChange={value => update({ reopenLastProject: value })}
              />
              <Toggle
                label="Check for updates automatically"
                detail="Axiom asks GitHub Releases for new versions. Nothing about you or your code is sent."
                checked={settings.checkForUpdates}
                onChange={value => update({ checkForUpdates: value })}
              />
              <div className="axiom-settings__row">
                <div>
                  <strong>Version {version}</strong>
                  {checkResult && <small>{checkResult}</small>}
                </div>
                <button
                  type="button"
                  className="axiom-settings__button"
                  onClick={() => {
                    setCheckResult('Checking…')
                    void window.axiom?.checkForUpdates().then(result => setCheckResult({
                      'up-to-date': 'You have the latest version.',
                      available: 'A new version is available.',
                      unavailable: 'Updates are checked in installed builds only.',
                      failed: 'Could not reach GitHub. Try again later.',
                    }[result]))
                  }}
                >
                  Check now
                </button>
              </div>
            </>
          )}

          {section === 'appearance' && (
            <>
              <div className="axiom-settings__row">
                <div>
                  <strong>Interface zoom</strong>
                  <small>Scales all of Axiom. Also {formatAccelerator('CmdOrCtrl+=', currentPlatform())} and {formatAccelerator('CmdOrCtrl+-', currentPlatform())}.</small>
                </div>
                <div className="axiom-settings__zoom">
                  <input
                    type="range"
                    min={UI_ZOOM_MIN}
                    max={UI_ZOOM_MAX}
                    step={0.1}
                    value={settings.uiZoom}
                    aria-label="Interface zoom"
                    onChange={event => update({ uiZoom: Number(event.target.value) })}
                  />
                  <output>{Math.round(settings.uiZoom * 100)}%</output>
                </div>
              </div>
              <div className="axiom-settings__row">
                <div>
                  <strong>Reduce motion</strong>
                  <small>
                    Calms the map&rsquo;s animations.
                    {initialMotion !== null && initialMotion !== settings.reduceMotion && ' Takes effect the next time Axiom starts.'}
                  </small>
                </div>
                <select
                  value={settings.reduceMotion}
                  aria-label="Reduce motion"
                  onChange={event => update({ reduceMotion: event.target.value as AppSettings['reduceMotion'] })}
                >
                  <option value="system">Match system setting</option>
                  <option value="always">Always</option>
                </select>
              </div>
            </>
          )}

          {section === 'agents' && (
            <>
              <p className="axiom-settings__text">
                Axiom installs itself into your coding agents (Claude Code, Cursor, Codex and others) from the
                Connect an Agent screen, which also repairs a connection that stopped working.
              </p>
              <div className="axiom-settings__row">
                <div>
                  <strong>Connect an agent</strong>
                  <small>{projectOpen ? 'Opens the connection screen for this project.' : 'Open a project first.'}</small>
                </div>
                <button
                  type="button"
                  className="axiom-settings__button"
                  disabled={!projectOpen}
                  onClick={() => { onClose(); setTimeout(() => emitCommand('agent.connect'), 0) }}
                >
                  Connect…
                </button>
              </div>
              <RemoveFromAgents />
            </>
          )}

          {section === 'privacy' && (
            <>
              <p className="axiom-settings__text">
                Your code, project maps and history stay on this machine. Axiom does not collect usage analytics.
                Diagnostics are only ever copied by you.
              </p>
              <PathRow label="Project data" path={paths?.data} onOpen={() => void window.axiom?.openAppPath('data')} />
              <PathRow label="Logs" path={paths?.logs} onOpen={() => void window.axiom?.openAppPath('logs')} />
              <div className="axiom-settings__row">
                <div><strong>Diagnostics</strong><small>Version, OS and recent log lines, with your home folder replaced by ~.</small></div>
                <button type="button" className="axiom-settings__button" onClick={() => emitCommand('help.copyDiagnostics')}>Copy</button>
              </div>
              <div className="axiom-settings__row">
                <div><strong>Privacy policy</strong><small>Exactly what stays local and what does not.</small></div>
                <button type="button" className="axiom-settings__button" onClick={() => void window.axiom?.openHelp('privacy')}>Read</button>
              </div>
            </>
          )}

          {section === 'advanced' && (
            <>
              <Toggle
                label="Developer menu"
                detail="Adds Reload and Developer Tools to the View menu."
                checked={settings.developerMenu}
                onChange={value => update({ developerMenu: value })}
              />
              <PathRow label="Settings folder" path={paths?.config} onOpen={() => void window.axiom?.openAppPath('config')} />
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Undo every agent install. Two clicks, because it reaches into other tools' settings. */
function RemoveFromAgents() {
  const [armed, setArmed] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const projectRoot = useGraphStore(state => state.currentProject?.rootPath)
  return (
    <div className="axiom-settings__row">
      <div>
        <strong>Remove Axiom from all agents</strong>
        <small>
          {result ?? 'Deletes the "axiom" connection and the axiom-map and axiom-inbox workflows Axiom added to your agents. Nothing else in their settings changes.'}
        </small>
      </div>
      <button
        type="button"
        className={armed ? 'axiom-settings__button axiom-settings__button--danger' : 'axiom-settings__button'}
        onClick={() => {
          if (!armed) { setArmed(true); return }
          setArmed(false)
          void window.axiom?.uninstallAllAgents(projectRoot).then(outcome => setResult(outcome.detail))
        }}
        onBlur={() => setArmed(false)}
      >
        {armed ? 'Click again to remove' : 'Remove…'}
      </button>
    </div>
  )
}

function Toggle({ label, detail, checked, onChange }: {
  label: string
  detail: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="axiom-settings__row axiom-settings__toggle">
      <div><strong>{label}</strong><small>{detail}</small></div>
      <input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
    </label>
  )
}

function PathRow({ label, path, onOpen }: { label: string; path?: string; onOpen: () => void }) {
  return (
    <div className="axiom-settings__row">
      <div><strong>{label}</strong><small><code>{path ?? '…'}</code></small></div>
      <button type="button" className="axiom-settings__button" onClick={onOpen}>Open</button>
    </div>
  )
}
