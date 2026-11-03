import { spawn, type IPty } from 'node-pty'
import type { TerminalEvent, TerminalProfile, TerminalStart } from '../src/shared/terminal.ts'

const HIGH_WATER = 256 * 1024
const LOW_WATER = 64 * 1024

export function terminalSize(cols: number, rows: number): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) throw new Error('Invalid terminal size.')
  return { cols, rows }
}

/** PTYs belong to one renderer. Reload, crash, window close and quit dispose them. */
export class Terminals {
  private sessions = new Map<string, { pty: IPty; pending: number; paused: boolean; owner: number }>()
  private launch: typeof spawn
  constructor(launch: typeof spawn = spawn) { this.launch = launch }

  start(owner: number, input: TerminalStart, profile: TerminalProfile, cwd: string, send: (event: TerminalEvent) => void): void {
    if (typeof input.id !== 'string' || !/^[\w-]{1,80}$/.test(input.id) || this.sessions.has(input.id)) throw new Error('Invalid terminal session.')
    if (this.sessions.size >= 16) throw new Error('Close a terminal before opening another (limit 16).')
    const size = terminalSize(input.cols, input.rows)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(ELECTRON_|AMBIO_|VITE_|NODE_OPTIONS$|NODE_INSPECT)/i.test(key)) env[key] = value
    }
    env.TERM_PROGRAM = 'Ambio'
    env.COLORTERM = 'truecolor'
    const pty = this.launch(profile.path, profile.args, { ...size, cwd, env, name: 'xterm-256color' })
    const session = { pty, pending: 0, paused: false, owner }
    this.sessions.set(input.id, session)
    pty.onData(data => {
      session.pending += data.length
      if (!session.paused && session.pending >= HIGH_WATER) { session.paused = true; pty.pause() }
      send({ id: input.id, type: 'data', data })
    })
    pty.onExit(({ exitCode }) => {
      if (this.sessions.get(input.id) !== session) return
      this.sessions.delete(input.id)
      send({ id: input.id, type: 'exit', exitCode })
    })
  }

  private owned(owner: number, id: string) {
    const session = this.sessions.get(id)
    return session?.owner === owner ? session : undefined
  }
  write(owner: number, id: string, data: string): void {
    if (typeof data !== 'string' || data.length > 64 * 1024) return
    this.owned(owner, id)?.pty.write(data)
  }
  resize(owner: number, id: string, cols: number, rows: number): void {
    const size = terminalSize(cols, rows)
    this.owned(owner, id)?.pty.resize(size.cols, size.rows)
  }
  acknowledge(owner: number, id: string, count: number): void {
    const session = this.owned(owner, id)
    if (!session || !Number.isSafeInteger(count) || count < 0) return
    session.pending = Math.max(0, session.pending - count)
    if (session.paused && session.pending <= LOW_WATER) { session.paused = false; session.pty.resume() }
  }
  stop(owner: number, id: string): void {
    const session = this.owned(owner, id)
    if (!session) return
    this.sessions.delete(id)
    try { session.pty.kill() } catch { /* already exited */ }
  }
  stopOwner(owner: number): void {
    for (const id of this.sessions.keys()) this.stop(owner, id)
  }
  close(): void {
    for (const [id, session] of this.sessions) this.stop(session.owner, id)
  }
}
