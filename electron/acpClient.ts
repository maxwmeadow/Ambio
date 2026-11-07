import type { DeliveryEvent, DeliveryUsage } from '../src/shared/agentDelivery.ts'
import { prose, thinkingEvents, type TurnMode } from './agentDrivers.ts'

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
  authentication?: 'grok'
  model?: string
  thinking?: string
  /** Antigravity cannot silently replace a retained session. */
  strictResume?: boolean
  steering?: boolean
  /** Optional human permission desk; without it the host's existing policy applies. */
  onPermission?: (question: { title: string; detail: string; kind?: string }, signal: AbortSignal) => Promise<boolean>
  /** Sends one line to the agent. */
  send: (line: string) => void
  onSession: (sessionId: string) => void
  onEvent: (event: Omit<DeliveryEvent, 'at'>) => void
  /** Token use the agent reports for the turn's prompts, summed across corrections. */
  onUsage?: (usage: DeliveryUsage) => void
}

export interface AcpOutcome {
  /** Why the agent stopped: end_turn, max_tokens, refusal, cancelled… */
  stopReason: string
  /** True when the turn ran in the session it was asked to continue. */
  resumed: boolean
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }

class GrokRequestTimeout extends Error {}

/** Session construction can wait for each of the user's MCP servers to start. */
export function grokRequestTimeout(method: string): number | undefined {
  return method === 'session/prompt' ? undefined
    : ['session/new', 'session/load', 'session/resume'].includes(method) ? 120000 : 30000
}

// A question or a proposal may look, run commands and talk to Ambio; it may
// not edit the project's files. A build is allowed everything it asks for.
// ACP names what a tool call does, so the rule is on the kind.
const CHANGES_THE_PROJECT = new Set(['edit', 'delete', 'move'])

function clip(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const DETAIL_MAX = 64000

/** A file change as a unified diff: the changed lines with three lines around them. */
export function unifiedDiff(file: string, oldText: string | null | undefined, newText: string | null | undefined): string {
  const split = (text: string | null | undefined) => text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []
  const before = split(oldText), after = split(newText)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  const removed = before.slice(start, before.length - end), added = after.slice(start, after.length - end)
  // The changed middle as removals and additions, matched line by line where
  // it is small enough to compare; otherwise all of it is replaced.
  const body: string[] = []
  if (removed.length * added.length <= 1_000_000) {
    const lcs = Array.from({ length: removed.length + 1 }, () => new Uint32Array(added.length + 1))
    for (let i = removed.length - 1; i >= 0; i--) for (let j = added.length - 1; j >= 0; j--) lcs[i][j] = removed[i] === added[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    let i = 0, j = 0
    while (i < removed.length || j < added.length) {
      if (i < removed.length && j < added.length && removed[i] === added[j]) { body.push(` ${removed[i++]}`); j++ }
      else if (j < added.length && (i === removed.length || lcs[i][j + 1] > lcs[i + 1][j])) body.push(`+${added[j++]}`)
      else body.push(`-${removed[i++]}`)
    }
  } else body.push(...removed.map(line => `-${line}`), ...added.map(line => `+${line}`))
  const lead = before.slice(Math.max(0, start - 3), start), tail = before.slice(before.length - end, before.length - end + 3)
  const oldStart = start - lead.length, oldCount = lead.length + removed.length + tail.length, newCount = lead.length + added.length + tail.length
  const header = `--- ${oldText == null ? '/dev/null' : `a/${file}`}\n+++ b/${file}\n@@ -${oldCount ? oldStart + 1 : 0},${oldCount} +${newCount ? oldStart + 1 : 0},${newCount} @@`
  return [header, ...lead.map(line => ` ${line}`), ...body, ...tail.map(line => ` ${line}`)].join('\n')
}

/** ACP tool content in the fields every agent's activity uses: text as output, file changes as a diff. */
export function acpToolDetail(content: unknown, rawOutput?: any): Pick<DeliveryEvent, 'output' | 'diff' | 'exitCode'> {
  const items: any[] = Array.isArray(content) ? content.slice(0, 32) : []
  const output = items.flatMap(item => item?.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string' ? [item.content.text] : []).join('\n')
  const diff = items.flatMap(item => item?.type === 'diff' && typeof item.path === 'string'
    ? [unifiedDiff(item.path.slice(0, 1024), typeof item.oldText === 'string' ? item.oldText.slice(0, DETAIL_MAX) : null, typeof item.newText === 'string' ? item.newText.slice(0, DETAIL_MAX) : '')] : []).join('\n')
  const exit = rawOutput?.exit_code ?? rawOutput?.exitCode
  return {
    ...(output ? { output: output.slice(0, DETAIL_MAX) } : {}),
    ...(diff ? { diff: diff.slice(0, DETAIL_MAX) } : {}),
    ...(typeof exit === 'number' ? { exitCode: exit } : {}),
  }
}

/** The usage a prompt's result reports (agy 1.5: inputTokens, cachedReadTokens, thoughtTokens…), or none. */
export function acpUsage(usage: any): DeliveryUsage | undefined {
  if (!usage || typeof usage !== 'object' || typeof usage.inputTokens !== 'number') return undefined
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    inputTokens: count(usage.inputTokens), cachedInputTokens: count(usage.cachedReadTokens), outputTokens: count(usage.outputTokens),
    reasoningOutputTokens: count(usage.thoughtTokens), totalTokens: count(usage.totalTokens) || count(usage.inputTokens) + count(usage.outputTokens),
  }
}

/** The agent's own mode that matches what this turn asks for, if it has one. */
export function acpModeFor(mode: TurnMode, available: Array<{ id: string; name?: string }>, defaultForAsk = false): string | undefined {
  const wanted = mode === 'ask' ? /^ask$|question/i : mode === 'propose' ? /plan|architect/i : /^(agent|code|build|default)$/i
  return available.find(item => wanted.test(item.id))?.id ?? available.find(item => wanted.test(item.name ?? ''))?.id
    ?? (defaultForAsk && mode === 'ask' ? available.find(item => item.id === 'default')?.id : undefined)
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
  /** Each tool call is one activity item; an update replaces it and keeps what it did not repeat. */
  private tools = new Map<string, Omit<DeliveryEvent, 'at'>>()
  private text = ''
  /** The message the agent is writing is one item, saved a few times a second as it grows. */
  private textId = ''
  private texts = 0
  private textTimer: ReturnType<typeof setTimeout> | undefined
  private usage: DeliveryUsage | undefined
  private thoughtText = ''
  private closed = false
  private cancelled = false
  private prompting = false
  private steeringWork: Array<Promise<void>> = []
  private steeredOutcome: any
  private permissionWaits = new Set<AbortController>()
  private configuration: any

  constructor(turn: AcpTurn) { this.turn = turn }

  private request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      // Handshakes and setup are bounded; a model turn has no time limit.
      const timeout = grokRequestTimeout(method)
      const timer = timeout === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id)
        const recovery = method === 'authenticate' ? 'Run grok login in a terminal, then send again.'
          : method.startsWith('session/') ? 'Check Grok’s MCP server startup and session output, then try again.'
            : 'Check Grok’s output and installed version, then try again.'
        reject(new GrokRequestTimeout(`${this.turn.authentication === 'grok' ? 'Grok' : 'The agent'} did not answer ${method} within ${timeout / 1000}s. ${this.turn.authentication === 'grok' ? recovery : 'Check the agent’s version, sign-in and server startup, then try again.'}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.turn.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** The agent process ended; nothing still waiting will be answered. */
  close(reason = 'The agent exited before the turn finished.'): void {
    if (this.closed) return
    this.closed = true
    for (const controller of this.permissionWaits) controller.abort()
    this.flushText()
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(reason)) }
    this.pending.clear()
  }

  /** Ask the agent to stop the turn in progress. */
  cancel(): void {
    this.cancelled = true
    for (const controller of this.permissionWaits) controller.abort()
    if (this.sessionId && !this.closed) this.turn.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }))
  }

  /** Only hosts whose running-prompt semantics are qualified enable this. */
  async steer(prompt: string): Promise<void> {
    if (!this.turn.steering || !this.prompting || this.closed || this.cancelled) throw new Error('This agent is not accepting input. Your draft is kept.')
    const work = (async () => {
      const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] })
      if (result.stopReason && result.stopReason !== 'end_turn') throw new Error(`The agent did not accept the update (${result.stopReason}).`)
      this.steeredOutcome = result
      this.addUsage(result.usage)
      this.turn.onEvent({ kind: 'sent', text: prompt })
    })()
    this.steeringWork.push(work)
    return work
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
      clearTimeout(waiting.timer)
      if (message.error) waiting.reject(new Error(String(message.error.message ?? 'The agent refused the request.')))
      else waiting.resolve(message.result ?? {})
      return
    }
    if (message.method === 'session/update') {
      if (message.params?.sessionId === this.sessionId) this.update(message.params?.update)
      return
    }
    if (message.id === undefined) return
    if (message.method === 'session/request_permission') {
      const params = message.params ?? {}
      const kind = params.toolCall?.kind ?? this.toolKinds.get(params.toolCall?.toolCallId)
      const options: Array<{ optionId: string; kind?: string }> = Array.isArray(params.options) ? params.options : []
      const title = clip(String(params.toolCall?.title ?? (this.toolTitles.get(params.toolCall?.toolCallId) || kind)), 1000)
      const answer = (optionId: string | undefined) => {
        if (!this.closed) this.turn.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: optionId && !this.cancelled ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } }))
      }
      if (params.sessionId !== this.sessionId || this.cancelled) { answer(undefined); return }
      if (this.turn.mode !== 'build' && CHANGES_THE_PROJECT.has(kind ?? 'other')) {
        this.turn.onEvent({ kind: 'tool', text: `Refused · ${title} (this turn does not change the project)` })
      }
      if (this.turn.onPermission && !(this.turn.mode !== 'build' && CHANGES_THE_PROJECT.has(kind ?? 'other'))) {
        const controller = new AbortController()
        this.permissionWaits.add(controller)
        let detail = ''
        try { detail = JSON.stringify(params.toolCall?.rawInput ?? params.toolCall?.content ?? '').slice(0, 8000) } catch { /* title remains available */ }
        void this.turn.onPermission({ title, detail, kind }, controller.signal).then(
          allowed => answer(options.find(option => option.kind === (allowed ? 'allow_once' : 'reject_once'))?.optionId),
          () => answer(undefined),
        ).finally(() => this.permissionWaits.delete(controller))
      } else answer(acpPermission(this.turn.mode, kind, options))
      return
    }
    // Ambio offers the agent no file system or terminal of its own; the agent
    // uses its own tools, which are the ones its permissions govern.
    this.turn.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Ambio does not provide ${message.method}` } }))
  }

  private flushText(): void {
    this.flushThought()
    clearTimeout(this.textTimer); this.textTimer = undefined
    if (this.text.trim()) this.turn.onEvent({ ...(this.textId ? { id: this.textId } : {}), kind: 'text', text: prose(this.text) })
    this.text = ''; this.textId = ''
  }

  private writeLive(): void {
    this.textTimer = undefined
    if (this.text.trim() && !this.closed) this.turn.onEvent({ id: this.textId, kind: 'text', text: prose(this.text), live: true })
  }

  private addUsage(reported: unknown): void {
    const usage = acpUsage(reported)
    if (!usage || !this.turn.onUsage) return
    const prior = this.usage
    this.usage = prior ? {
      inputTokens: prior.inputTokens + usage.inputTokens, cachedInputTokens: prior.cachedInputTokens + usage.cachedInputTokens,
      outputTokens: prior.outputTokens + usage.outputTokens, reasoningOutputTokens: prior.reasoningOutputTokens + usage.reasoningOutputTokens,
      totalTokens: prior.totalTokens + usage.totalTokens,
    } : usage
    this.turn.onUsage(this.usage)
  }

  /** A tool call or its update, as the one activity item for that call. */
  private reportTool(update: any, first: boolean): void {
    const id = typeof update.toolCallId === 'string' && update.toolCallId ? update.toolCallId : undefined
    const prior = id ? this.tools.get(id) : undefined
    const where = Array.isArray(update.locations) && update.locations[0]?.path ? ` · ${clip(String(update.locations[0].path), 1000)}` : ''
    // The label the call started with stays; agy's updates retitle it with a full path.
    const label = prior?.text ?? (first ? `${clip(String(update.title ?? update.name ?? update.kind ?? 'tool'), 1000)}${where}`
      : clip(String(update.title ?? this.toolTitles.get(id ?? '') ?? 'Tool result'), 1000))
    const event: Omit<DeliveryEvent, 'at'> = {
      ...prior, ...(id ? { id } : {}), kind: update.status === 'failed' ? 'error' : 'tool', text: label,
      ...(typeof update.status === 'string' ? { status: update.status } : {}), ...acpToolDetail(update.content, update.rawOutput),
    }
    if (id) this.tools.set(id, event)
    this.turn.onEvent(event)
  }

  private flushThought(): void {
    for (const event of thinkingEvents(this.thoughtText)) this.turn.onEvent(event)
    this.thoughtText = ''
  }

  private update(update: any): void {
    if (!update || this.replaying) return
    if (update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content?.type === 'text' && typeof update.content.text === 'string') this.thoughtText += update.content.text
      return
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      // What it thought before it spoke is said first.
      this.flushThought()
      if (update.content?.type === 'text' && typeof update.content.text === 'string') {
        this.text += update.content.text
        this.textId ||= `live:${++this.texts}`
        this.textTimer ??= setTimeout(() => this.writeLive(), 250)
      }
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      // What it said before reaching for a tool is one thing it said.
      this.flushText()
      if (typeof update.toolCallId === 'string') {
        this.toolKinds.set(update.toolCallId, String(update.kind ?? 'other'))
        this.toolTitles.set(update.toolCallId, String(update.title ?? update.name ?? ''))
      }
      this.reportTool(update, true)
      return
    }
    if (update.sessionUpdate === 'tool_call_update') this.reportTool(update, false)
  }

  /** Run the turn to its end. Rejects when the agent cannot start or run it. */
  async open(): Promise<any> {
    const turn = this.turn
    const initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ambio', title: 'Ambio', version: '1' },
    })
    if (turn.authentication === 'grok') {
      const methods: Array<{ id: string }> = initialized.authMethods ?? []
      const methodId = process.env.XAI_API_KEY && methods.some(method => method.id === 'xai.api_key')
        ? 'xai.api_key' : methods.find(method => method.id === 'cached_token')?.id ?? methods.find(method => method.id === 'grok.com')?.id
      if (!methodId) throw new Error('Grok has no supported headless authentication method. Update Grok, then try again.')
      try { await this.request('authenticate', { methodId, _meta: { headless: true } }) }
      catch { throw new Error('Grok is not signed in. Run grok login in a terminal, then send again.') }
    }
    const capabilities = initialized.agentCapabilities ?? {}
    let resumed = false
    let session: any
    const setup = { cwd: turn.cwd, mcpServers: turn.mcpServers }
    if (turn.resume && turn.strictResume && !(capabilities.sessionCapabilities?.resume || capabilities.loadSession)) throw new Error('This agent cannot reopen the retained conversation. Start a new conversation to continue.')
    if (turn.resume && (capabilities.sessionCapabilities?.resume || capabilities.loadSession)) {
      try {
        if (capabilities.sessionCapabilities?.resume) session = await this.request('session/resume', { sessionId: turn.resume, ...setup })
        else {
          this.replaying = true
          session = await this.request('session/load', { sessionId: turn.resume, ...setup })
        }
        this.sessionId = turn.resume
        resumed = true
      } catch (error) {
        // A timeout does not establish that a retained session is gone, and a
        // second session would start all the same slow MCP servers again.
        if (error instanceof GrokRequestTimeout || turn.strictResume) throw error
      }
      finally { this.replaying = false; this.text = '' }
    }
    if (!resumed) {
      try { session = await this.request('session/new', setup) } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(turn.authentication !== 'grok' && /auth/i.test(message) ? `${message}. Sign in to this agent in its own terminal, then send again.` : message)
      }
      this.sessionId = String(session.sessionId ?? '')
      if (!this.sessionId) throw new Error('The agent did not start a session.')
    }
    turn.onSession(this.sessionId)
    this.configuration = session
    return session
  }

  /** A catalog probe creates no turn and explicitly closes its empty session. */
  async disposeSession(): Promise<void> {
    if (this.sessionId && !this.closed) await this.request('session/close', { sessionId: this.sessionId })
  }

  /** Run the turn to its end. Configuration errors never send a prompt. */
  async run(): Promise<AcpOutcome> {
    const turn = this.turn
    const session = await this.open()
    const options: any[] = Array.isArray(session?.configOptions) ? session.configOptions : []
    const values = (option: any): any[] => (option.options ?? []).flatMap((item: any) => Array.isArray(item.options) ? item.options : [item])
    if (turn.model) {
      const option = options.find(option => option.category === 'model' || option.id === 'model')
      if (option && values(option).some(item => item.value === turn.model)) {
        const result = await this.request('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value: turn.model })
        if (Array.isArray(result.configOptions)) this.configuration.configOptions = result.configOptions
      } else if (session?.models?.availableModels?.some((model: any) => model.modelId === turn.model)) {
        await this.request('session/set_model', { sessionId: this.sessionId, modelId: turn.model })
      } else throw new Error('The selected model is not available in this ACP session. Choose an available model or start a new conversation with another model.')
    }
    if (turn.thinking) {
      const option = (this.configuration.configOptions ?? []).find((option: any) => option.category === 'thought_level' || option.id === 'thought_level')
      if (!option || !values(option).some(item => item.value === turn.thinking)) throw new Error('The selected thinking level is not available for this model.')
      await this.request('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value: turn.thinking })
    }
    // The mode is set on every turn: a continued session keeps the last one.
    const modes = session?.modes
    const modeId = Array.isArray(modes?.availableModes) ? acpModeFor(turn.mode, modes.availableModes, turn.strictResume) : undefined
    if (modeId && modeId !== modes.currentModeId) {
      try { await this.request('session/set_mode', { sessionId: this.sessionId, modeId }) } catch (error) { if (turn.strictResume) throw error }
    }
    if (this.cancelled || this.closed) throw new Error('The turn was stopped before it began.')
    this.prompting = true
    let result: any
    try {
      result = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: turn.prompt }] })
      this.addUsage(result.usage)
      // agy resolves the original request before its steered replacement ends.
      // Keep the process alive until every accepted correction has completed.
      for (let i = 0; i < this.steeringWork.length; i++) await this.steeringWork[i]
      result = this.steeredOutcome ?? result
    }
    finally { this.prompting = false }
    this.flushText()
    return { stopReason: String(result.stopReason ?? 'end_turn'), resumed: !!turn.resume && this.sessionId === turn.resume }
  }
}
