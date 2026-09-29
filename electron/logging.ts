import fs from 'fs'
import os from 'os'
import { join } from 'path'

// Local, rotating log files. Nothing here is ever sent anywhere: logs exist so
// a user can look at them, or choose to attach them to a bug report.

export const LOG_MAX_BYTES = 2 * 1024 * 1024
export const LOG_BACKUPS = 2

export type LogChannel = 'main' | 'archd' | 'renderer'

export class RotatingLog {
  readonly path: string
  private readonly maxBytes: number
  private readonly backups: number
  private size: number

  constructor(path: string, maxBytes = LOG_MAX_BYTES, backups = LOG_BACKUPS) {
    this.path = path
    this.maxBytes = maxBytes
    this.backups = backups
    try { this.size = fs.statSync(path).size } catch { this.size = 0 }
  }

  write(line: string): void {
    const entry = line.endsWith('\n') ? line : `${line}\n`
    try {
      if (this.size + Buffer.byteLength(entry) > this.maxBytes) this.rotate()
      fs.appendFileSync(this.path, entry)
      this.size += Buffer.byteLength(entry)
    } catch {
      // Logging must never take the app down with it.
    }
  }

  private rotate(): void {
    for (let index = this.backups; index >= 1; index--) {
      const from = index === 1 ? this.path : `${this.path}.${index - 1}`
      const to = `${this.path}.${index}`
      try { fs.renameSync(from, to) } catch { /* nothing to rotate yet */ }
    }
    this.size = 0
  }

  /** The newest lines across the current file and its backups. */
  tail(lines: number): string[] {
    const collected: string[] = []
    for (let index = 0; index <= this.backups && collected.length < lines; index++) {
      const file = index === 0 ? this.path : `${this.path}.${index}`
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { continue }
      const fileLines = text.split('\n').filter(Boolean)
      collected.unshift(...fileLines.slice(-(lines - collected.length)))
    }
    return collected.slice(-lines)
  }
}

export function timestamped(level: string, message: string): string {
  return `${new Date().toISOString()} [${level}] ${message}`
}

/**
 * Diagnostics are read by people outside this machine, so the home directory
 * - usually the user's account name - is replaced with "~".
 */
export function redactHome(text: string, home = os.homedir()): string {
  if (!home || home === '/') return text
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
  let result = text
  for (const variant of variants) result = result.split(variant).join('~')
  return result
}

export interface DiagnosticsInput {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  osRelease: string
  locale: string
  packaged: boolean
  archdRunning: boolean
  archdRestartsLastMinute: number
  projectCount: number
  logs: Partial<Record<LogChannel, string[]>>
}

export function formatDiagnostics(input: DiagnosticsInput): string {
  const lines = [
    '## Axiom diagnostics',
    '',
    `- Axiom ${input.appVersion}${input.packaged ? '' : ' (development)'}`,
    `- ${input.platform} ${input.arch}, OS ${input.osRelease}, locale ${input.locale}`,
    `- Electron ${input.electron}, Chrome ${input.chrome}, Node ${input.node}`,
    `- Background service: ${input.archdRunning ? 'running' : 'not running'}` +
      (input.archdRestartsLastMinute > 0 ? `, ${input.archdRestartsLastMinute} restart(s) in the last minute` : ''),
    `- Projects: ${input.projectCount}`,
  ]
  for (const channel of ['main', 'archd', 'renderer'] as const) {
    const log = input.logs[channel]
    if (!log || log.length === 0) continue
    lines.push('', `<details><summary>${channel}.log (last ${log.length} lines)</summary>`, '', '```', ...log, '```', '</details>')
  }
  return redactHome(lines.join('\n'))
}

export function createLogs(dir: string): Record<LogChannel, RotatingLog> {
  fs.mkdirSync(dir, { recursive: true })
  return {
    main: new RotatingLog(join(dir, 'main.log')),
    archd: new RotatingLog(join(dir, 'archd.log')),
    renderer: new RotatingLog(join(dir, 'renderer.log')),
  }
}
