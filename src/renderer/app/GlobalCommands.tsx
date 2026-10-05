import { useEffect, useMemo, useRef, useState } from 'react'
import { COMMANDS, buildMenu, commandForKey, commandIds, formatAccelerator, paletteCommands, type CommandId } from '../../shared/appMenu'
import { DEFAULT_SETTINGS, UI_ZOOM_MAX, UI_ZOOM_MIN, type AppSettings } from '../../shared/appSettings'
import { useGraphStore } from '../store/graphStore'
import { currentPlatform, emitCommand, useCommandHandlers } from './commands'
import { MarkdownView } from '../components/MarkdownView'

type Dialog = 'palette' | 'settings' | 'shortcuts' | 'about' | 'acknowledgements' | 'whatsNew' | null

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
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: string } | null>(null)

  // After an update, the release notes for the new version, once.
  useEffect(() => {
    void window.ambio?.takeWhatsNew?.().then(notes => {
      if (!notes) return
      setWhatsNew(notes)
      setDialog('whatsNew')
    })
  }, [])
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
      // A text field's own undo history answers its undo keys.
      if ((id === 'edit.undo' || id === 'edit.redo') && isEditable(event.target)) return
      if (spec.needsProject && !useGraphStore.getState().currentProject) return
      event.preventDefault()
      emitCommand(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [platform])

  // The native macOS menu reports clicks here.
  useEffect(() => window.ambio?.onMenuCommand?.(id => emitCommand(id)), [])

  // Project commands enable and disable with the project.
  useEffect(() => { void window.ambio?.setMenuState?.({ projectOpen }) }, [projectOpen])

  useCommandHandlers({
    'view.commandPalette': () => setDialog(current => (current === 'palette' ? null : 'palette')),
    'app.settings': () => setDialog('settings'),
    'help.shortcuts': () => setDialog(current => (current === 'shortcuts' ? null : 'shortcuts')),
    'app.about': () => setDialog('about'),
    'app.checkUpdates': () => {
      if (!window.ambio) return
      say('Checking for updates…')
      void window.ambio.checkForUpdates().then(result => {
        say({
          'up-to-date': 'Ambio is up to date.',
          available: 'A new version is available - see the update notice.',
          unavailable: 'Updates are checked in installed builds only.',
          failed: 'Could not check for updates. Try again later.',
        }[result])
      })
    },
    'view.zoomIn': () => { void window.ambio?.zoom('in').then(factor => say(`Interface zoom ${Math.round(factor * 100)}%`)) },
    'view.zoomOut': () => { void window.ambio?.zoom('out').then(factor => say(`Interface zoom ${Math.round(factor * 100)}%`)) },
    'view.resetZoom': () => { void window.ambio?.zoom('reset').then(() => say('Interface zoom 100%')) },
    'view.fullScreen': () => { void window.ambio?.toggleFullScreen() },
    'help.docs': () => { void window.ambio?.openHelp('docs') },
    'help.privacy': () => { void window.ambio?.openHelp('privacy') },
    'help.license': () => { void window.ambio?.openHelp('license') },
    'help.acknowledgements': () => setDialog('acknowledgements'),
    'help.whatsNew': () => {
      void window.ambio?.whatsNew?.().then(notes => {
        if (!notes) { say('Release notes are not available for this build.'); return }
        setWhatsNew(notes)
        setDialog('whatsNew')
      })
    },
    'help.reportBug': () => { void window.ambio?.reportBug() },
    'help.feedback': () => { void window.ambio?.openHelp('feedback') },
    'help.copyDiagnostics': () => { void window.ambio?.copyDiagnostics().then(() => say('Diagnostics copied to the clipboard.')) },
    'help.openLogs': () => { void window.ambio?.openLogsFolder() },
  })

  return (
    <>
      {dialog === 'palette' && <CommandPalette projectOpen={projectOpen} platform={platform} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog platform={platform} onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {dialog === 'acknowledgements' && <AcknowledgementsDialog onClose={() => setDialog(null)} />}
      {dialog === 'whatsNew' && whatsNew && (
        <Modal title={whatsNew.version === 'Unreleased' ? "What's New (unreleased)" : `What's New in ${whatsNew.version}`} width={620} onClose={() => setDialog(null)}>
          <div className="ambio-whats-new"><MarkdownView source={whatsNew.notes} /></div>
        </Modal>
      )}
      {toast && <div className="ambio-app-toast" role="status">{toast}</div>}
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
      className="ambio-dialog-backdrop ambio-app-modal__backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
    >
      <section
        ref={surface}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`ambio-dialog-surface ambio-app-modal ${className}`.trim()}
        style={{ '--ambio-dialog-width': `${width}px` } as React.CSSProperties}
      >
        <header className="ambio-dialog-header ambio-app-modal__header">
          <h2 className="ambio-dialog-title">{title}</h2>
          <button type="button" className="ambio-app-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="ambio-app-modal__body">{children}</div>
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
      className="ambio-dialog-backdrop ambio-palette__backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <section className="ambio-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus
          className="ambio-palette__input"
          value={query}
          placeholder="Type a command…"
          aria-label="Command"
          aria-controls="ambio-palette-results"
          spellCheck={false}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, results.length - 1)) }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)) }
            if (event.key === 'Enter' && results[active]) { event.preventDefault(); run(results[active].id) }
          }}
        />
        <ul id="ambio-palette-results" ref={list} className="ambio-palette__results" role="listbox">
          {results.length === 0 && <li className="ambio-palette__empty">No matching commands</li>}
          {results.map((spec, index) => (
            <li
              key={spec.id}
              data-index={index}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'ambio-palette__item ambio-palette__item--active' : 'ambio-palette__item'}
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
      label: section.id === 'app' ? 'Ambio' : section.label,
      commands: commandIds(section.entries)
        .map(id => COMMANDS[id])
        .filter(spec => spec.accelerator),
    }))
    .filter(section => section.commands.length > 0)
  const seen = new Set<CommandId>()
  return (
    <Modal title="Keyboard Shortcuts" width={560} onClose={onClose}>
      <div className="ambio-shortcuts">
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
  useEffect(() => { void window.ambio?.getAppInfo().then(setInfo) }, [])
  return (
    <Modal title="About Ambio" width={420} onClose={onClose}>
      <div className="ambio-about">
        <strong>Ambio</strong>
        <p>Version {info?.version ?? '…'}{info && !info.isPackaged ? ' (development)' : ''}</p>
        <p>A live architecture map of your codebase, shared with your coding agents.</p>
        <p>Free software under the GNU Affero General Public License v3.0.</p>
        <div className="ambio-about__links">
          <button type="button" onClick={() => void window.ambio?.openHelp('license')}>License</button>
          <button type="button" onClick={() => void window.ambio?.openHelp('privacy')}>Privacy</button>
          <button type="button" onClick={() => void window.ambio?.openHelp('releases')}>Release notes</button>
          <button type="button" onClick={() => void window.ambio?.openHelp('source')}>Source code</button>
          <button type="button" onClick={() => { onClose(); setTimeout(() => emitCommand('help.acknowledgements'), 0) }}>Acknowledgements</button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Acknowledgements ───────────────────────────────────────────────────────

function AcknowledgementsDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    void (window.ambio?.thirdPartyNotices?.() ?? Promise.resolve('Available in the desktop app.')).then(setText)
  }, [])
  return (
    <Modal title="Acknowledgements" width={760} onClose={onClose}>
      <div className="ambio-acknowledgements">
        <p>Ambio is built on open-source software. These are the components it includes and their licenses.</p>
        <pre>{text ?? 'Loading…'}</pre>
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
  const [editors, setEditors] = useState<Array<{ id: string; label: string }>>([])
  const projectOpen = useGraphStore(state => state.currentProject !== null)

  useEffect(() => {
    if (!window.ambio) { setLoaded(true); return }
    void window.ambio.getSettings().then(current => {
      setSettings(current)
      setInitialMotion(current.reduceMotion)
      setLoaded(true)
    })
    void window.ambio.getAppPaths().then(setPaths)
    void window.ambio.getAppInfo().then(info => setVersion(info.version))
    void window.ambio.listEditors?.().then(setEditors)
    return window.ambio.onSettingsChanged(setSettings)
  }, [])

  const update = (patch: Partial<AppSettings>) => {
    setSettings(current => ({ ...current, ...patch }))
    void window.ambio?.setSettings(patch).then(setSettings)
  }

  return (
    <Modal title="Settings" width={720} onClose={onClose} className="ambio-settings">
      <div className="ambio-settings__layout">
        <nav className="ambio-settings__nav" aria-label="Settings sections">
          {SECTIONS.map(item => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              className={section === item.id ? 'ambio-settings__nav-item ambio-settings__nav-item--active' : 'ambio-settings__nav-item'}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ambio-settings__panel" aria-busy={!loaded}>
          {section === 'general' && (
            <>
              <Toggle
                label="Reopen the last project on launch"
                detail="Start where you left off. When off, Ambio always opens on the project list."
                checked={settings.reopenLastProject}
                onChange={value => update({ reopenLastProject: value })}
              />
              <Toggle
                label="Notify me about work orders"
                detail="A system notification when an agent picks up or replies to a work order while Ambio is in the background."
                checked={settings.workOrderNotifications}
                onChange={value => update({ workOrderNotifications: value })}
              />
              <Toggle
                label="Check for updates automatically"
                detail="Ambio asks GitHub Releases for new versions. Nothing about you or your code is sent."
                checked={settings.checkForUpdates}
                onChange={value => update({ checkForUpdates: value })}
              />
              <div className="ambio-settings__row">
                <div>
                  <strong>Open files in</strong>
                  <small>
                    {editors.length > 0
                      ? 'Used by Open in Editor. Source files never open in the system default app, which may run them.'
                      : 'No code editor found. Install VS Code, Cursor, Zed or another editor with a command-line launcher.'}
                  </small>
                </div>
                <select
                  value={editors.some(editor => editor.id === settings.editor) ? settings.editor : 'auto'}
                  aria-label="Open files in"
                  onChange={event => update({ editor: event.target.value })}
                >
                  <option value="auto">{editors[0] ? `Automatic (${editors[0].label})` : 'Automatic'}</option>
                  {editors.map(editor => <option key={editor.id} value={editor.id}>{editor.label}</option>)}
                </select>
              </div>
              <div className="ambio-settings__row">
                <div>
                  <strong>Version {version}</strong>
                  {checkResult && <small>{checkResult}</small>}
                </div>
                <button
                  type="button"
                  className="ambio-settings__button"
                  onClick={() => {
                    setCheckResult('Checking…')
                    void window.ambio?.checkForUpdates().then(result => setCheckResult({
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
              <div className="ambio-settings__row">
                <div>
                  <strong>Interface zoom</strong>
                  <small>Scales all of Ambio. Also {formatAccelerator('CmdOrCtrl+=', currentPlatform())} and {formatAccelerator('CmdOrCtrl+-', currentPlatform())}.</small>
                </div>
                <div className="ambio-settings__zoom">
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
              <div className="ambio-settings__row">
                <div>
                  <strong>Reduce motion</strong>
                  <small>
                    Calms the map&rsquo;s animations.
                    {initialMotion !== null && initialMotion !== settings.reduceMotion && ' Takes effect the next time Ambio starts.'}
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
              <p className="ambio-settings__text">
                Ambio installs itself into your coding agents (Claude Code, Cursor, Codex and others) from the
                Connect an Agent screen, which also repairs a connection that stopped working.
              </p>
              <div className="ambio-settings__row">
                <div>
                  <strong>Connect an agent</strong>
                  <small>{projectOpen ? 'Opens the connection screen for this project.' : 'Open a project first.'}</small>
                </div>
                <button
                  type="button"
                  className="ambio-settings__button"
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
              <p className="ambio-settings__text">
                Your code, project maps and history stay on this machine. Ambio does not collect usage analytics.
                Diagnostics are only ever copied by you.
              </p>
              <PathRow label="Project data" path={paths?.data} onOpen={() => void window.ambio?.openAppPath('data')} />
              <PathRow label="Logs" path={paths?.logs} onOpen={() => void window.ambio?.openAppPath('logs')} />
              <div className="ambio-settings__row">
                <div><strong>Diagnostics</strong><small>Version, OS and recent log lines, with your home folder replaced by ~.</small></div>
                <button type="button" className="ambio-settings__button" onClick={() => emitCommand('help.copyDiagnostics')}>Copy</button>
              </div>
              <DeleteAllData />
              <div className="ambio-settings__row">
                <div><strong>Privacy policy</strong><small>Exactly what stays local and what does not.</small></div>
                <button type="button" className="ambio-settings__button" onClick={() => void window.ambio?.openHelp('privacy')}>Read</button>
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
              <CliInstallRow />
              <PathRow label="Settings folder" path={paths?.config} onOpen={() => void window.ambio?.openAppPath('config')} />
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

function DeleteAllData() {
  return (
    <div className="ambio-settings__row">
      <div>
        <strong>Delete all Ambio data</strong>
        <small>Every project map, your settings and the logs on this computer. Your code is not touched. Ambio restarts afterwards.</small>
      </div>
      <button
        type="button"
        className="ambio-settings__button ambio-settings__button--danger"
        onClick={() => { void window.ambio?.clearAllData() }}
      >
        Delete…
      </button>
    </div>
  )
}

/** `ambio .` in a terminal, like `code .`. */
function CliInstallRow() {
  const [result, setResult] = useState<{ ok: boolean; manual?: string; detail: string } | null>(null)
  return (
    <div className="ambio-settings__row">
      <div>
        <strong>Command-line launcher</strong>
        <small>{result?.detail ?? 'Open any folder from a terminal with: ambio .'}</small>
      </div>
      {result?.manual ? (
        <button type="button" className="ambio-settings__button" onClick={() => void window.ambio?.copyText(result.manual!)}>Copy</button>
      ) : (
        <button type="button" className="ambio-settings__button" onClick={() => { void window.ambio?.installCli().then(setResult) }}>
          {result?.ok ? 'Installed' : 'Install'}
        </button>
      )}
    </div>
  )
}

/** Undo every agent install. Two clicks, because it reaches into other tools' settings. */
function RemoveFromAgents() {
  const [armed, setArmed] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const projectRoot = useGraphStore(state => state.currentProject?.rootPath)
  return (
    <div className="ambio-settings__row">
      <div>
        <strong>Remove Ambio from all agents</strong>
        <small>
          {result ?? 'Deletes the "ambio" connection and the ambio-map and ambio-inbox workflows Ambio added to your agents. Nothing else in their settings changes.'}
        </small>
      </div>
      <button
        type="button"
        className={armed ? 'ambio-settings__button ambio-settings__button--danger' : 'ambio-settings__button'}
        onClick={() => {
          if (!armed) { setArmed(true); return }
          setArmed(false)
          void window.ambio?.uninstallAllAgents(projectRoot).then(outcome => setResult(outcome.detail))
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
    <label className="ambio-settings__row ambio-settings__toggle">
      <div><strong>{label}</strong><small>{detail}</small></div>
      <input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
    </label>
  )
}

function PathRow({ label, path, onOpen }: { label: string; path?: string; onOpen: () => void }) {
  return (
    <div className="ambio-settings__row">
      <div><strong>{label}</strong><small><code>{path ?? '…'}</code></small></div>
      <button type="button" className="ambio-settings__button" onClick={onOpen}>Open</button>
    </div>
  )
}
