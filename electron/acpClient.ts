import type { DeliveryEvent } from '../src/shared/agentDelivery.ts'
import type { TurnMode } from './agentDrivers.ts'

/**
 * One turn of a conversation with an agent that speaks the Agent Client
 * Protocol (agentclientprotocol.com): JSON-RPC 2.0, one message a line, over
 * the agent process's stdin and stdout.
 *
 * Where a host's print mode is a prompt in and text out, ACP is a session:
 * Ambio hands the agent its own MCP server for that session, continues the
 * session an earlier turn left, hears what the agent is doing as it does it,
 * and answers the agent's requests for permission. This module is only the
 * protocol. The process, its receipt and its log belong to the runner.
 */

export interface AcpMcpServer { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }

export interface AcpTurn {
  cwd: string
  prompt: string
  mode: TurnMode
  mcpServers: AcpMcpServer[]
  /** The agent session an earlier turn of this conversation ran in. */
  resume?: string
  /** Sends one line to the agent. */
  send: (line: string) => void
  onSession: (sessionId: string) => void
  onEvent: (event: Omit<DeliveryEvent, 'at'>) => void
  /**
   * Puts a question to the user in the conversation. A build's edits are what
   * was ordered; a command it wants to run is asked about first. Without
   * this, a build's requests are allowed as before.
   */
}

export interface AcpOutcome {
  /** Why the agent stopped: end_turn, max_tokens, refusal, cancelled… */
  stopReason: string
  /** True when the turn ran in the session it was asked to continue. */
  resumed: boolean
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void }

// A question or a proposal may look, run commands and talk to Ambio; it may
// not edit the project's files. A build is allowed everything it asks for.
// ACP names what a tool call does, so the rule is on the kind.
const CHANGES_THE_PROJECT = new Set(['edit', 'delete', 'move'])

function clip(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The agent's own mode that matches what this turn asks for, if it has one. */
export function acpModeFor(mode: TurnMode, available: Array<{ id: string; name?: string }>): string | undefined {
  const wanted = mode === 'ask' ? /^ask$|question/i : mode === 'propose' ? /plan|architect/i : /^(agent|code|build|default)$/i
  return available.find(item => wanted.test(item.id))?.id ?? available.find(item => wanted.test(item.name ?? ''))?.id
}

/** Which of the offered answers a turn in this mode gives to a permission request. */
export function acpPermission(mode: TurnMode, kind: string | undefined, options: Array<{ optionId: string; kind?: string }>): string | undefined {
  const allowed = mode === 'build' || !CHANGES_THE_PROJECT.has(kind ?? 'other')
  const pick = (kinds: string[]) => kinds.map(wanted => options.find(option => option.kind === wanted)).find(Boolean)?.optionId
  return allowed ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always'])
}

export class AcpClient {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private turn: AcpTurn
  private sessionId = ''
  /** Loading a session replays its history; that is not this turn speaking. */
  private replaying = false
  private toolKinds = new Map<string, string>()
  private toolTitles = new Map<string, string>()
  private text = ''
  private closed = false

  constructor(turn: AcpTurn) { this.turn = turn }

  private request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.turn.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** The agent process ended; nothing still waiting will be answered. */
  close(reason = 'The agent exited before the turn finished.'): void {
    if (this.closed) return
    this.closed = true
    this.flushText()
    for (const waiting of this.pending.values()) waiting.reject(new Error(reason))
    this.pending.clear()
  }

  /** Ask the agent to stop the turn in progress. */
  cancel(): void {
    if (this.sessionId && !this.closed) this.turn.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }))
  }

  /** One line of the agent's output. */
  receive(line: string): void {
    if (!line.startsWith('{')) return
    let message: any
    try { message = JSON.parse(line) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.method === undefined && message.id !== undefined) {
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      if (message.error) waiting.reject(new Error(String(message.error.message ?? 'The agent refused the request.')))
      else waiting.resolve(message.result ?? {})
      return
    }
    if (message.method === 'session/update') { this.update(message.params?.update); return }
    if (message.id === undefined) return
    if (message.method === 'session/request_permission') {
      const params = message.params ?? {}
      const kind = params.toolCall?.kind ?? this.toolKinds.get(params.toolCall?.toolCallId)
      const options: Array<{ optionId: string; kind?: string }> = Array.isArray(params.options) ? params.options : []
      const title = clip(String(params.toolCall?.title ?? (this.toolTitles.get(params.toolCall?.toolCallId) || kind)), 120)
      const answer = (optionId: string | undefined) =>
        this.turn.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } }))
      if (this.turn.mode !== 'build' && CHANGES_THE_PROJECT.has(kind ?? 'other')) {
        this.turn.onEvent({ kind: 'tool', text: `Refused · ${title} (this turn does not change the project)` })
      }
      answer(acpPermission(this.turn.mode, kind, options))
      return
    }
    // Ambio offers the agent no file system or terminal of its own; the agent
    // uses its own tools, which are the ones its permissions govern.
    this.turn.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Ambio does not provide ${message.method}` } }))
  }

  private flushText(): void {
    if (this.text.trim()) this.turn.onEvent({ kind: 'text', text: clip(this.text, 1200) })
    this.text = ''
  }

  private update(update: any): void {
    if (!update || this.replaying) return
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content?.type === 'text' && typeof update.content.text === 'string') this.text += update.content.text
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      // What it said before reaching for a tool is one thing it said.
      this.flushText()
      if (typeof update.toolCallId === 'string') {
        this.toolKinds.set(update.toolCallId, String(update.kind ?? 'other'))
        this.toolTitles.set(update.toolCallId, String(update.title ?? update.name ?? ''))
      }
      const where = Array.isArray(update.locations) && update.locations[0]?.path ? ` · ${clip(String(update.locations[0].path), 120)}` : ''
      this.turn.onEvent({ kind: 'tool', text: `${clip(String(update.title ?? update.name ?? update.kind ?? 'tool'), 160)}${where}` })
      return
    }
    if (update.sessionUpdate === 'tool_call_update' && update.status === 'failed') {
      this.turn.onEvent({ kind: 'error', text: `A tool call failed${update.title ? `: ${clip(String(update.title), 160)}` : '.'}` })
    }
  }

  /** Run the turn to its end. Rejects when the agent cannot start or run it. */
  async run(): Promise<AcpOutcome> {
    const turn = this.turn
    const initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ambio', title: 'Ambio', version: '1' },
    })
    const capabilities = initialized.agentCapabilities ?? {}
    let resumed = false
    let session: any
    const setup = { cwd: turn.cwd, mcpServers: turn.mcpServers }
    if (turn.resume && (capabilities.sessionCapabilities?.resume || capabilities.loadSession)) {
      try {
        if (capabilities.sessionCapabilities?.resume) session = await this.request('session/resume', { sessionId: turn.resume, ...setup })
        else {
          this.replaying = true
          session = await this.request('session/load', { sessionId: turn.resume, ...setup })
        }
        this.sessionId = turn.resume
        resumed = true
      } catch { /* the session is gone; this turn starts a new one */ }
      finally { this.replaying = false; this.text = '' }
    }
    if (!resumed) {
      try { session = await this.request('session/new', setup) } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(/auth/i.test(message) ? `${message}. Sign in to this agent in its own terminal, then send again.` : message)
      }
      this.sessionId = String(session.sessionId ?? '')
      if (!this.sessionId) throw new Error('The agent did not start a session.')
    }
    turn.onSession(this.sessionId)
    // The mode is set on every turn: a continued session keeps the last one.
    const modes = session?.modes
    const modeId = Array.isArray(modes?.availableModes) ? acpModeFor(turn.mode, modes.availableModes) : undefined
    if (modeId && modeId !== modes.currentModeId) {
      try { await this.request('session/set_mode', { sessionId: this.sessionId, modeId }) } catch { /* the permission answers still hold the line */ }
    }
    const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: turn.prompt }] })
    this.flushText()
    return { stopReason: String(result.stopReason ?? 'end_turn'), resumed }
  }
}
