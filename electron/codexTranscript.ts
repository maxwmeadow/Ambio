import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { DeliveryEvent } from '../src/shared/agentDelivery.ts'

/**
 * What Codex does that its --json output leaves out, read from its own
 * session transcript.
 *
 * In code mode (codex-cli 0.165, gpt-6 models) Codex works through one `exec`
 * tool that runs a JavaScript snippet. A snippet that calls a shell command or
 * an MCP tool is reported on --json as that call, but one that only works on
 * data it holds in memory is reported as nothing, so a long mapping can show
 * minutes of reasoning and no activity. Codex writes every snippet to
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl as it goes;
 * this follows that file and says each tool-free snippet ran.
 *
 * The transcript is Codex's internal record, not an interface, and can change
 * in any release. Following it is best effort: anything unexpected - no file,
 * a format it does not recognise, an unreadable line - stops the following
 * quietly, with a note in the run's raw log, and the turn carries on with what
 * --json reports.
 */

type Event = Omit<DeliveryEvent, 'at'>

/** How often the transcript is checked for new lines. */
const POLL_MS = 500
/** How long to look for the transcript before giving up on it. */
const FIND_MS = 30_000
/** Lines read with none recognised before deciding the format has changed. */
const UNRECOGNISED_LIMIT = 50
/** Script lines shown per turn, so a looping agent cannot crowd out the rest. */
const SHOWN_LIMIT = 150
/** The most read from the transcript per check. */
const CHUNK = 1024 * 1024

/** A snippet that reaches a nested tool; --json already reports that call. */
const CALLS_A_TOOL = /\btools\s*(?:\.|\[)/

/** The values a snippet names in code mode's store, through load("…") or store("…"). */
function stored(code: string, call: 'load' | 'store'): string[] {
  return [...new Set([...code.matchAll(new RegExp(`\\b${call}\\(\\s*["'\`]([\\w.-]+)["'\`]`, 'g'))].map(match => match[1]))]
}

/**
 * A snippet in a few words: its leading comment if it has one, else the
 * values it reads and saves (which carry the agent's own names for its
 * working data), else its first line.
 */
export function scriptSummary(code: string): string {
  const clipped = (text: string) => { const flat = text.replace(/;$/, '').replace(/\s+/g, ' ').trim(); return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat }
  const lines = code.split(/\r?\n/).map(line => line.trim()).filter(line => line && line !== '{' && line !== '}')
  const comment = /^\/\/\s*(.+)$/.exec(lines[0] ?? '')?.[1]
  if (comment) return clipped(comment)
  const reads = stored(code, 'load'), saves = stored(code, 'store')
  // What it saves says most about it; a long list of what it reads is cut short.
  const named = reads.length > 3 ? `${reads.slice(0, 3).join(', ')} +${reads.length - 3}` : reads.join(', ')
  if (reads.length || saves.length) return clipped([saves.length ? `saves ${saves.join(', ')}` : '', reads.length ? `reads ${named}` : ''].filter(Boolean).join(' · '))
  return lines[0] ? clipped(lines[0]) : 'working on data in memory'
}

/** Whether a transcript line has the shape this reader expects: { type, payload }. */
export function recognised(entry: unknown): entry is { timestamp?: unknown; type: string; payload: Record<string, unknown> } {
  return !!entry && typeof entry === 'object'
    && typeof (entry as Record<string, unknown>).type === 'string'
    && !!(entry as Record<string, unknown>).payload && typeof (entry as Record<string, unknown>).payload === 'object'
}

/**
 * What one transcript line adds to the turn's activity: a tool-free `exec`
 * snippet written at or after `since` (ms). Anything else, including a line
 * that does not parse, adds nothing.
 */
export function codexTranscriptEvents(line: string, since = 0): Event[] {
  try { return entryEvents(JSON.parse(line), since) } catch { return [] }
}

function entryEvents(entry: unknown, since: number): Event[] {
  if (!recognised(entry)) return []
  const { payload } = entry
  if (payload.type !== 'custom_tool_call' || payload.name !== 'exec' || typeof payload.input !== 'string') return []
  if (CALLS_A_TOOL.test(payload.input)) return []
  // A continued session writes on after its earlier turns.
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  if (!Number.isNaN(at) && at < since) return []
  return [{ kind: 'tool', text: `Script · ${scriptSummary(payload.input)}` }]
}

/** The transcript of a Codex session, looked for in the date folders a recent session can be in. */
export function codexTranscriptPath(sessionId: string, env: NodeJS.ProcessEnv = process.env, now = new Date(), home = os.homedir()): string | undefined {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return undefined
  const sessions = join(env.CODEX_HOME || join(home, '.codex'), 'sessions')
  const pad = (value: number) => String(value).padStart(2, '0')
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const folders = new Set([
    join(sessions, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())),
    join(sessions, String(now.getUTCFullYear()), pad(now.getUTCMonth() + 1), pad(now.getUTCDate())),
    join(sessions, String(yesterday.getFullYear()), pad(yesterday.getMonth() + 1), pad(yesterday.getDate())),
  ])
  const suffix = `-${sessionId}.jsonl`
  for (const folder of folders) {
    let names: string[]
    try { names = fs.readdirSync(folder) } catch { continue }
    const name = names.find(entry => entry.startsWith('rollout-') && entry.endsWith(suffix))
    if (name) return join(folder, name)
  }
  return undefined
}

export interface TranscriptFollow {
  sessionId: string
  /** Snippets written before this time (ms) belong to earlier turns. */
  since: number
  env?: NodeJS.ProcessEnv
  report: (event: Event) => void
  /** Why following stopped early, for the run's raw log. */
  note: (text: string) => void
  /** Where to look, and how long for; tests name the file. */
  locate?: () => string | undefined
  findMs?: number
}

/** Follows a Codex session's transcript until the returned stop is called. Never throws. */
export function followCodexTranscript(follow: TranscriptFollow): () => void {
  const locate = follow.locate ?? (() => codexTranscriptPath(follow.sessionId, follow.env))
  const started = Date.now()
  let path: string | undefined
  let offset = 0
  let pending = ''
  let read = 0
  let understood = 0
  let shown = 0
  let stopped = false
  const stop = () => { if (!stopped) { stopped = true; clearInterval(timer) } }
  const giveUp = (reason: string) => { stop(); try { follow.note(`Not following Codex's transcript: ${reason}`) } catch { /* the note is a courtesy */ } }
  const check = () => {
    if (stopped) return
    try {
      if (!path) {
        path = locate()
        if (!path) { if (Date.now() - started >= (follow.findMs ?? FIND_MS)) giveUp('no transcript was found for this session.'); return }
      }
      const size = fs.statSync(path).size
      if (size < offset) return giveUp('the transcript was replaced while it was being read.')
      if (size === offset) return
      const buffer = Buffer.alloc(Math.min(CHUNK, size - offset))
      const fd = fs.openSync(path, 'r')
      let length: number
      try { length = fs.readSync(fd, buffer, 0, buffer.length, offset) } finally { fs.closeSync(fd) }
      offset += length
      pending += buffer.subarray(0, length).toString('utf8')
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      // One very long line (a large tool result) is skipped, not held.
      if (pending.length > 8 * CHUNK) pending = ''
      for (const line of lines) {
        if (!line) continue
        read++
        let entry: unknown
        try { entry = JSON.parse(line) } catch { continue }
        if (recognised(entry)) understood++
        for (const event of entryEvents(entry, follow.since)) {
          if (shown >= SHOWN_LIMIT) break
          shown++
          follow.report(event)
        }
      }
      if (!understood && read >= UNRECOGNISED_LIMIT) giveUp('its format is not one Ambio recognises.')
    } catch (error) {
      giveUp(error instanceof Error ? error.message : String(error))
    }
  }
  const timer = setInterval(check, POLL_MS)
  timer.unref?.()
  // A last look picks up what was written just before the turn ended.
  return () => { check(); stop() }
}
