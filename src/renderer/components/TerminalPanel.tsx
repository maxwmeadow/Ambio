import { Chevron } from './ui/Chevron'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalProfile } from '../../shared/terminal'
import { commandForKey } from '../../shared/appMenu'
import { currentPlatform } from '../app/commands'
import '@xterm/xterm/css/xterm.css'
import '../styles/terminal.css'

interface Session { id: string; profile: TerminalProfile; exitCode?: number }

export default function TerminalPanel({ workspaceId, open, width, onResize, onClose }: { workspaceId: string; open: boolean; width: number; onResize: (width: number) => void; onClose: () => void }) {
  const [profiles, setProfiles] = useState<TerminalProfile[]>([])
  const [profileId, setProfileId] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [{ id: active, focusTab }, setActive] = useState({ id: '', focusTab: false })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const panel = useRef<HTMLElement>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const options = useRef<HTMLDetailsElement>(null)
  const autoStarted = useRef(false)
  const restoreFocus = useRef<HTMLElement | null>(null)

  const add = useCallback((profile: TerminalProfile) => {
    const session = { id: crypto.randomUUID(), profile }
    setSessions(current => [...current, session]); setActive({ id: session.id, focusTab: false })
  }, [])
  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try {
      if (!window.ambio?.terminal) throw new Error('Terminals are available in the Ambio desktop app.')
      const found = await window.ambio.terminal.profiles()
      setProfiles(found)
      let saved = ''
      try { saved = localStorage.getItem('ambio:terminal-profile') ?? '' } catch { /* optional preference */ }
      const preferred = found.find(profile => profile.id === saved) ?? found[0]
      setProfileId(preferred?.id ?? '')
      if (!autoStarted.current && preferred) { autoStarted.current = true; add(preferred) }
      if (!found.length) setError('No shells found. Locate a shell executable or install one and refresh the list.')
    } catch (error) { setError(String(error)) }
    finally { setLoading(false) }
  }, [add])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (options.current && !options.current.contains(event.target as Node)) options.current.open = false
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])
  useLayoutEffect(() => {
    if (!open || !panel.current) return
    restoreFocus.current = document.activeElement as HTMLElement
    const root = panel.current
    return () => {
      if (root.contains(document.activeElement)) restoreFocus.current?.focus({ preventScroll: true })
    }
  }, [open])
  useLayoutEffect(() => {
    const strip = tabs.current
    const selected = strip?.querySelector('.ambio-terminal__tab[data-active="true"]')
    if (!open || !strip || !selected) return

    const reveal = () => {
      const viewport = strip.getBoundingClientRect()
      const tab = selected.getBoundingClientRect()
      if (tab.left < viewport.left) strip.scrollLeft += tab.left - viewport.left
      else if (tab.right > viewport.right) strip.scrollLeft += tab.right - viewport.right
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [active, open, sessions])
  const remove = (id: string) => {
    const next = sessions.filter(session => session.id !== id)
    if (active === id) setActive({ id: next.at(-1)?.id ?? '', focusTab: false })
    setSessions(next)
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
  }
  const selectedProfile = profiles.find(profile => profile.id === profileId)
  return (
    <aside ref={panel} className="ambio-terminal" aria-label="Terminal" hidden={!open}>
      <div className="ambio-terminal__resize" role="separator" aria-label="Terminal width" aria-orientation="vertical" aria-valuenow={Math.round(width)} aria-valuemin={360} aria-valuemax={Math.round(Math.max(360, window.innerWidth * .85))} tabIndex={0}
        onPointerDown={resize} onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) onResize(window.innerWidth - event.clientX)
        }} onPointerUp={event => {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }} onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onResize(width + (event.key === 'ArrowLeft' ? 32 : -32)) }
        }} />
      <header className="ambio-terminal__header">
      <div ref={tabs} className="ambio-terminal__tabs" role="tablist" aria-label="Terminal sessions" onKeyDown={event => {
        if (!(event.target as HTMLElement).matches('[role=tab]')) return
        const index = sessions.findIndex(session => session.id === active)
        const next = event.key === 'ArrowRight' ? (index + 1) % sessions.length : event.key === 'ArrowLeft' ? (index - 1 + sessions.length) % sessions.length : event.key === 'Home' ? 0 : event.key === 'End' ? sessions.length - 1 : -1
        if (next < 0) return
        event.preventDefault(); setActive({ id: sessions[next].id, focusTab: true })
        document.getElementById(`tab-${sessions[next].id}`)?.focus({ preventScroll: true })
      }}>
        {sessions.map((session, index) => {
          const label = `${index + 1}. ${session.profile.label}${session.exitCode === undefined ? '' : ` (exited ${session.exitCode})`}`
          return <div key={session.id} className="ambio-terminal__tab" data-active={session.id === active}>
            <button type="button" role="tab" id={`tab-${session.id}`} aria-controls={`screen-${session.id}`} aria-selected={session.id === active} tabIndex={session.id === active ? 0 : -1}
              title={label} onClick={() => setActive({ id: session.id, focusTab: false })}>{label}</button>
            <button type="button" aria-label={`Close terminal ${index + 1}`} title="Kill terminal" onClick={() => remove(session.id)}>×</button>
          </div>
        })}
        {!sessions.length && <span className="ambio-terminal__idle">{loading ? 'Finding shells…' : 'Terminal'}</span>}
      </div>
      <div className="ambio-terminal__actions">
        <button type="button" disabled={!selectedProfile || sessions.length >= 16} onClick={() => {
          if (options.current) options.current.open = false
          if (selectedProfile) add(selectedProfile)
        }} aria-label="New terminal" title={`New terminal${selectedProfile ? ` (${selectedProfile.label})` : ''}`}>+</button>
        <details ref={options} className="ambio-terminal__options" onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
        }}>
          <summary aria-label="Shell options" title="Shell options">…</summary>
          <div className="ambio-terminal__menu">
            <label>New terminals use
              <select aria-label="Shell profile" value={profileId} onChange={event => {
                setProfileId(event.target.value)
                try { localStorage.setItem('ambio:terminal-profile', event.target.value) } catch { /* session only */ }
              }} disabled={loading || !profiles.length}>
                {!profiles.length && <option value="">{loading ? 'Finding shells…' : 'No shells found'}</option>}
                {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void refresh()} disabled={loading}>Refresh shells</button>
            <button type="button" aria-label="Locate shell executable" onClick={() => {
              void window.ambio.terminal.locateProfile().then(profile => {
                if (!profile) return
                setError('')
                setProfiles(current => current.some(item => item.id === profile.id) ? current : [...current, profile]); setProfileId(profile.id)
                try { localStorage.setItem('ambio:terminal-profile', profile.id) } catch { /* session only */ }
                if (options.current) options.current.open = false
              }).catch(error => setError(String(error)))
            }}>Locate another shell…</button>
          </div>
        </details>
        <button type="button" onClick={onClose} aria-label="Hide terminal" title="Hide terminal (Ctrl+`)"><Chevron size={15} /></button>
      </div>
      </header>
      {error && <p role="alert" className="ambio-terminal__error">{error}</p>}
      <div className="ambio-terminal__body">
        {!sessions.length && !loading && <div className="ambio-terminal__empty"><p>Your workspace, at the command line.</p><p>Choose a shell and open a new terminal.</p></div>}
        {sessions.map(session => <TerminalScreen key={session.id} session={session} workspaceId={workspaceId} visible={open && active === session.id} focusTab={focusTab}
          onExit={exitCode => setSessions(current => current.map(item => item.id === session.id ? { ...item, exitCode } : item))} />)}
      </div>
    </aside>
  )
}

function TerminalScreen({ session, workspaceId, visible, focusTab, onExit }: { session: Session; workspaceId: string; visible: boolean; focusTab: boolean; onExit: (exitCode: number) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<{ terminal: Terminal; fit: FitAddon }>()
  const exit = useRef(onExit); exit.current = onExit
  useEffect(() => {
    if (!host.current) return
    const bridge = window.ambio.terminal
    // Effect lifetimes get distinct PTYs so a development StrictMode cleanup
    // cannot kill the replacement while an asynchronous start is in flight.
    const ptyId = crypto.randomUUID()
    const terminal = new Terminal({ cursorBlink: true, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, lineHeight: 1.25, scrollback: 5000,
      theme: { background: '#202b28', foreground: '#e2e8de', cursor: '#a1d4ba', selectionBackground: '#527d6c88',
        black: '#26332d', red: '#ed8e86', green: '#a3c991', yellow: '#ddc282', blue: '#8ebad0', magenta: '#c5a3cf', cyan: '#8cccc0', white: '#e2e8de',
        brightBlack: '#82968a', brightRed: '#ffaaa1', brightGreen: '#c0e4ab', brightYellow: '#f2d89c', brightBlue: '#a8d4eb', brightMagenta: '#dfbfe8', brightCyan: '#a7e6d6', brightWhite: '#ffffff' } })
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current)
    instance.current = { terminal, fit }
    let disposed = false, started = false
    let pasting = false, queuedInput = '', startupInput = ''
    const writeInput = (data: string) => {
      if (!started) { startupInput += data; return }
      for (let offset = 0; offset < data.length; offset += 32 * 1024) bridge.write(ptyId, data.slice(offset, offset + 32 * 1024))
    }
    terminal.attachCustomKeyEventHandler(event => {
      const command = commandForKey(event, currentPlatform())
      if (command === 'view.terminal' || command === 'view.commandPalette') return false
      const paste = event.key.toLowerCase() === 'v' && !event.altKey &&
        (currentPlatform() === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
      if (paste) {
        event.preventDefault()
        if (event.type === 'keydown' && !pasting) {
          pasting = true
          void bridge.readClipboard().then(text => {
            if (!disposed) { pasting = false; terminal.paste(text) }
          }).finally(() => {
            pasting = false
            if (!disposed) writeInput(queuedInput)
            queuedInput = ''
          }).catch(() => { /* clipboard may be unavailable */ })
        }
        return false
      }
      // Preserve shell Ctrl+C; copy a selection with the familiar shortcut.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        if (event.type === 'keydown') void window.ambio.copyText(terminal.getSelection())
        return false
      }
      return true
    })
    const unsubscribe = bridge.onEvent(event => {
      if (event.id !== ptyId) return
      if (event.type === 'data') terminal.write(event.data, () => bridge.acknowledge(ptyId, event.data.length))
      else { terminal.options.disableStdin = true; terminal.write(`\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`); exit.current(event.exitCode) }
    })
    const input = terminal.onData(data => { if (pasting) queuedInput += data; else writeInput(data) })
    const resized = terminal.onResize(size => { if (started) bridge.resize(ptyId, size.cols, size.rows) })
    const fitVisible = () => { if (host.current?.offsetWidth && host.current.offsetHeight) fit.fit() }
    const observer = new ResizeObserver(fitVisible); observer.observe(host.current)
    fitVisible()
    void bridge.start({ id: ptyId, workspaceId, profileId: session.profile.id, cols: terminal.cols, rows: terminal.rows }).then(() => {
      started = true
      if (disposed) void bridge.stop(ptyId)
      else { fitVisible(); bridge.resize(ptyId, terminal.cols, terminal.rows); writeInput(startupInput); startupInput = '' }
    }).catch(error => {
      if (disposed) return
      terminal.write(`\r\nCould not start ${session.profile.label}: ${String(error)}\r\nClose this tab and try a new terminal.\r\n`)
      exit.current(-1)
    })
    return () => {
      disposed = true; instance.current = undefined; unsubscribe(); input.dispose(); resized.dispose(); observer.disconnect(); terminal.dispose()
      void bridge.stop(ptyId)
    }
  }, [session.id, session.profile.id, workspaceId])
  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      instance.current?.fit.fit()
      if (focusTab && document.activeElement?.id === `tab-${session.id}`) return
      instance.current?.terminal.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, focusTab, session.id])
  return <div id={`screen-${session.id}`} role="tabpanel" aria-labelledby={`tab-${session.id}`} className="ambio-terminal__screen" ref={host} hidden={!visible} />
}
