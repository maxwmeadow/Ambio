import type { DeliveryEvent, DeliveryUsage, ModelOption } from '../src/shared/agentDelivery.ts'
import type { AgentAccess } from '../src/shared/agentDelivery.ts'
import { codexSandbox, type DriverTurn } from './agentDrivers.ts'

type Activity = Omit<DeliveryEvent, 'at'>
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type Question = { question: string; header?: string; options?: Array<{ label: string; description?: string }> }

/** Stable protocol baseline exercised by the authenticated controls qualification. */
const MINIMUM_CONTROL_VERSION = [0, 162, 1]
const ITEM_CACHE_LIMIT = 2000
export function codexServerVersion(userAgent: string): string | undefined {
  const version = /\bcodex(?:[-_ ](?:desktop|cli))?\/([^\s()]+)/i.exec(userAgent)?.[1]
  if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(version)) return
  const [core, pre] = version.split('+')[0].split(/-(.+)/)
  if (!core.split('.').every(part => Number.isSafeInteger(Number(part))) || pre?.split('.').some(part => /^0\d+$/.test(part))) return
  return version
}
function qualifiedControls(userAgent: string): boolean {
  const version = codexServerVersion(userAgent)
  if (!version) return false
  const [core, pre] = version.split('+')[0].split(/-(.+)/)
  const parts = core.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (parts[i] !== MINIMUM_CONTROL_VERSION[i]) return parts[i] > MINIMUM_CONTROL_VERSION[i]
  // Prereleases sort below the stable baseline; build metadata has no precedence.
  return !pre
}
export function codexAccessLevels(userAgent: string): AgentAccess[] {
  return qualifiedControls(userAgent) ? ['ask', 'auto', 'full'] : ['ask', 'full']
}

export function codexAppServerPolicy(mode: DriverTurn['mode'], approval: CodexAppServerTurn['approval'], platform: NodeJS.Platform = process.platform, reviewer: CodexAppServerTurn['reviewer'] = 'user', userAgent = '') {
  const ask = approval === 'on-request'
  if (ask && (platform === 'win32' || reviewer === 'auto_review') && !qualifiedControls(userAgent)) {
    throw new Error('This Codex version has not been qualified for the selected access level. Update to a qualified CLI; access was not widened.')
  }
  return {
    sandbox: ask ? mode === 'build' ? 'workspace-write' : 'read-only' : codexSandbox(mode, platform),
    approvalPolicy: approval ?? 'never',
    ...(ask ? { approvalsReviewer: reviewer } : {}),
    // The default elevated helper fails on the qualified Windows installation.
    // Use a tested restricted-token implementation, never full access as a fallback.
    ...(ask ? { config: {
      sandbox_workspace_write: { network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
      ...(platform === 'win32' ? { windows: { sandbox: 'unelevated' } } : {}),
    } } : {}),
  }
}

/** An effort level's name as the menu shows it: Codex's own values, capitalized ("xhigh" reads "Extra high"). */
export function effortLabel(level: string): string {
  return level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1)
}

/** The reasoning efforts a model advertises (model/list), and its own default. */
export function codexEffort(model: any): Pick<ModelOption, 'thinkingLevels' | 'defaultThinking'> {
  const levels: string[] = (Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
    .map((item: any) => item?.reasoningEffort).filter((level: unknown): level is string => typeof level === 'string' && /^[a-z]{1,20}$/.test(level))
  if (!levels.length) return {}
  return {
    thinkingLevels: levels.map(level => ({ id: level, label: effortLabel(level) })),
    ...(levels.includes(model.defaultReasoningEffort) ? { defaultThinking: model.defaultReasoningEffort } : {}),
  }
}

export interface CodexAppServerTurn {
  cwd: string
  prompt: string
  mode: DriverTurn['mode']
  resume?: string
  model?: string
  /** A reasoning effort the model advertises; unset keeps the thread's own. */
  effort?: string
  approval?: 'never' | 'on-request'
  reviewer?: 'user' | 'auto_review'
  review?: boolean
  send: (line: string) => void
  onSession: (id: string) => void
  onEvent: (event: Activity) => void
  onUsage?: (usage: DeliveryUsage) => void
  onReady?: (ready: boolean) => void
  onServer?: (userAgent: string) => void
  approve?: (question: { title: string; detail: string; kind: string; questions?: Question[] }, signal: AbortSignal) => Promise<boolean | { answers: Record<string, string> }>
}

/** Native Codex stdio protocol. Process ownership and launch receipts stay in DeliveryRunner. */
export class CodexAppServer {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private approvals = new Map<string | number, AbortController>()
  private threadId = ''
  private turnId = ''
  private closed = false
  private cancelled = false
  private accepting = false
  private initialized?: Promise<void>
  private completion?: { resolve: (status: string) => void; reject: (error: Error) => void }
  private items = new Map<string, Activity>()
  private dirty = new Set<string>()
  private completedItems = new Set<string>()
  private flushTimer?: ReturnType<typeof setTimeout>
  private reviewText = ''
  private userAgent = ''
  private agents = new Map<string, string>()

  private turn: CodexAppServerTurn
  constructor(turn: CodexAppServerTurn) { this.turn = turn }

  private request(method: string, params: unknown, timeout = 30000): Promise<any> {
    if (this.closed || this.cancelled) return Promise.reject(new Error('The Codex session is closed.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex did not answer ${method}. Check its installed version and output. No turn was retried.`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.turn.send(JSON.stringify({ id, method, params })) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      const result = await this.request('initialize', { clientInfo: { name: 'ambio', title: 'Ambio', version: '0.1.0' }, ...(this.turn.reviewer === 'auto_review' ? { capabilities: { experimentalApi: true } } : {}) })
      this.userAgent = String(result.userAgent ?? 'Codex App Server')
      this.turn.onServer?.(this.userAgent)
      this.turn.send(JSON.stringify({ method: 'initialized', params: {} }))
    })()
  }

  async models(): Promise<ModelOption[]> {
    await this.initialize()
    const models: ModelOption[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = await this.request('model/list', { cursor, limit: 100 })
      for (const model of result.data ?? []) {
        if (typeof model.model === 'string' && !model.hidden) models.push({ id: model.model, label: model.displayName || model.model, ...codexEffort(model) })
      }
      if (!result.nextCursor || result.nextCursor === cursor) break
      cursor = result.nextCursor
    }
    return models
  }

  async run(): Promise<{ stopReason: string; resumed: boolean }> {
    await this.initialize()
    const policy = codexAppServerPolicy(this.turn.mode, this.turn.approval, process.platform, this.turn.reviewer, this.userAgent)
    const setup = { cwd: this.turn.cwd, ...policy, ...(this.turn.model ? { model: this.turn.model } : {}) }
    // Never silently replace a missing thread: the caller must decide whether to start fresh.
    const result = await this.request(this.turn.resume ? 'thread/resume' : 'thread/start', { ...setup, ...(this.turn.resume ? { threadId: this.turn.resume } : {}) }, 120000)
    if (!result.thread?.id) throw new Error('Codex returned no thread identity. Update Codex or select exec for a new conversation.')
    if (this.turn.approval === 'on-request' && (result.approvalPolicy !== 'on-request' || result.approvalsReviewer !== (this.turn.reviewer ?? 'user') || result.sandbox?.type !== (this.turn.mode === 'build' ? 'workspaceWrite' : 'readOnly'))) {
      throw new Error('Codex did not confirm the requested sandbox and approval reviewer. No prompt was sent and access was not widened.')
    }
    this.threadId = result.thread.id
    this.turn.onSession(this.threadId)
    if (this.cancelled) throw new Error('Codex was stopped before starting its turn.')
    if (this.turn.review) {
      const status = await this.startTurn('review/start', { threadId: this.threadId, delivery: 'inline', target: { type: 'uncommittedChanges' } })
      if (status !== 'completed') return { stopReason: status, resumed: !!this.turn.resume }
    }
    const text = this.turn.prompt + (this.turn.review ? `\n\nCodex's native review has finished. Use the following review as evidence, claim this Ambio request and return the review through Ambio's normal reply workflow. Do not change files.\n\n${this.reviewText || 'The reviewer returned no written findings.'}` : '')
    const status = await this.startTurn('turn/start', { threadId: this.threadId, input: [{ type: 'text', text }], summary: 'auto', ...(this.turn.effort ? { effort: this.turn.effort } : {}) })
    return { stopReason: status, resumed: !!this.turn.resume }
  }

  private async startTurn(method: string, params: unknown): Promise<string> {
    if (this.closed || this.cancelled) throw new Error('The Codex session is closed.')
    this.turnId = ''; this.accepting = true
    const completed = new Promise<string>((resolve, reject) => { this.completion = { resolve, reject } })
    // A server can finish before the start response arrives. Install the waiter first.
    void completed.catch(() => {})
    try {
      const result = await this.request(method, params, 120000)
      if (!result.turn?.id) throw new Error(`Codex returned no turn for ${method}.`)
      this.turnId = result.turn.id
      this.turn.onReady?.(this.accepting && !this.cancelled)
      return await completed
    } finally { this.accepting = false; this.turn.onReady?.(false); this.flush(); this.completion = undefined; this.abortApprovals() }
  }

  async steer(text: string): Promise<void> {
    if (!this.accepting || !this.turnId || this.cancelled) throw new Error('Codex is not accepting corrections. Your draft is kept; send it as the next message.')
    const result = await this.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text }] })
    if (result.turnId !== this.turnId) throw new Error('Codex did not confirm the active turn. Check its output before retrying.')
  }

  cancel(): void {
    if (this.closed || this.cancelled) return
    this.turn.onReady?.(false)
    this.abortApprovals()
    if (this.threadId && this.turnId && this.accepting) void this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
    this.cancelled = true
  }

  close(reason = 'Codex exited before completing its turn.'): void {
    if (this.closed) return
    this.closed = true; this.turn.onReady?.(false); this.flush(); this.abortApprovals()
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(reason)) }
    this.pending.clear()
    this.completion?.reject(new Error(reason))
  }

  private abortApprovals(): void { for (const controller of this.approvals.values()) controller.abort(); this.approvals.clear() }

  receive(line: string): void {
    if (this.closed) return
    let message: any
    try { message = JSON.parse(line) } catch { return }
    if (!message || typeof message !== 'object') return
    if (!message.method && message.id !== undefined) {
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      clearTimeout(waiting.timer); this.pending.delete(message.id)
      if (message.error) waiting.reject(new Error(String(message.error.message ?? 'Codex refused the request.')))
      else waiting.resolve(message.result ?? {})
      return
    }
    const params = message.params ?? {}
    if (message.id !== undefined) { void this.serverRequest(message.id, message.method, params); return }
    if (message.method === 'serverRequest/resolved') { this.approvals.get(params.requestId)?.abort('resolved'); this.approvals.delete(params.requestId); return }
    if (message.method === 'thread/started' && (params.thread?.parentThreadId === this.threadId || this.agents.has(params.thread?.parentThreadId))) {
      const thread = params.thread
      this.agents.set(thread.id, [thread.agentNickname, thread.agentRole].filter(Boolean).join(' · ') || thread.id)
      return
    }
    if (this.accepting && this.agents.has(params.threadId) && (message.method === 'item/started' || message.method === 'item/completed')) {
      this.item(params.item, message.method === 'item/completed', { threadId: params.threadId, label: this.agents.get(params.threadId)! })
      return
    }
    const eventTurn = params.turnId ?? params.turn?.id
    if (!this.accepting || params.threadId !== this.threadId || this.turnId && eventTurn && eventTurn !== this.turnId) return
    if (message.method === 'turn/started' && params.turn?.id) this.turnId = params.turn.id
    if (message.method === 'turn/completed') {
      this.accepting = false; this.turn.onReady?.(false)
      for (const id of this.items.keys()) this.completedItems.add(id)
      this.flush(); this.abortApprovals()
      if (params.turn?.error?.message) this.turn.onEvent({ kind: 'error', text: params.turn.error.message })
      this.completion?.resolve(params.turn?.status ?? 'failed')
    } else if (message.method === 'error') {
      this.turn.onEvent({ kind: 'error', text: String(params.error?.message ?? 'Codex reported an error.') })
    } else if (message.method === 'thread/tokenUsage/updated') {
      // `last` is the last inference, not the whole turn (which can make many calls).
      const usage = params.tokenUsage?.total ?? params.tokenUsage?.last
      if (usage) this.turn.onUsage?.({ ...(params.tokenUsage?.total ? { scope: 'thread' as const } : {}), inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens, reasoningOutputTokens: usage.reasoningOutputTokens, totalTokens: usage.totalTokens })
    } else if (message.method === 'turn/diff/updated') {
      this.update(`diff:${this.turnId}`, { kind: 'tool', text: 'Changes in this turn', diff: String(params.diff ?? '').slice(0, 64000) })
    } else if (message.method === 'item/autoApprovalReview/started' || message.method === 'item/autoApprovalReview/completed') {
      const review = params.review ?? {}
      this.update(`review:${params.reviewId}`, { kind: 'tool', text: `Auto review · ${review.status ?? (message.method.endsWith('/started') ? 'reviewing' : 'completed')}${review.rationale ? ` · ${review.rationale}` : ''}`, status: review.status }, message.method.endsWith('/completed'))
    } else if (message.method === 'item/agentMessage/delta' || message.method === 'item/reasoning/summaryTextDelta' || message.method === 'item/commandExecution/outputDelta') {
      const id = String(params.itemId)
      const old = this.items.get(id)
      const delta = String(params.delta ?? '')
      if (message.method.endsWith('outputDelta')) this.update(id, { kind: 'tool', text: old?.text ?? 'Shell', ...old, output: ((old?.output ?? '') + delta).slice(-16000) })
      else this.update(id, { kind: message.method.includes('reasoning') ? 'thinking' : 'text', text: ((old?.text ?? '') + delta).slice(0, 64000) })
    } else if (message.method === 'item/started' || message.method === 'item/completed') this.item(params.item, message.method === 'item/completed')
  }

  private update(id: string, activity: Activity, done = false): void {
    this.items.set(id, { ...activity, id: `codex:${id}` }); this.dirty.add(id)
    if (done) this.completedItems.add(id)
    else this.completedItems.delete(id)
    this.flushTimer ??= setTimeout(() => this.flush(), 100)
  }

  private flush(): void {
    clearTimeout(this.flushTimer); this.flushTimer = undefined
    for (const id of this.dirty) this.turn.onEvent(this.items.get(id)!)
    this.dirty.clear()
    this.evictItems()
  }

  private evictItems(): void {
    for (const id of this.completedItems) {
      if (this.items.size <= ITEM_CACHE_LIMIT) break
      if (this.dirty.has(id)) continue
      this.items.delete(id); this.completedItems.delete(id)
    }
  }

  private item(item: any, done: boolean, actor?: { threadId: string; label: string }): void {
    if (!item?.id) return
    // Child tool evidence belongs in the parent run; its text/thought transcript does not.
    if (actor && ['userMessage', 'agentMessage', 'reasoning', 'plan', 'enteredReviewMode', 'exitedReviewMode'].includes(item.type)) return
    const update = (id: string, activity: Activity) => this.update(actor ? `${actor.threadId}:${id}` : id, actor && !activity.text.startsWith('Subagent ·') ? { ...activity, text: `Subagent · ${actor.label} · ${activity.text}` } : activity, done)
    const old = this.items.get(actor ? `${actor.threadId}:${item.id}` : item.id)
    if (item.type === 'agentMessage' && (done || !old)) update(item.id, { kind: 'text', text: String(item.text ?? '').slice(0, 64000) })
    if (item.type === 'reasoning' && done) update(item.id, { kind: 'thinking', text: (item.summary ?? []).join('\n').slice(0, 64000) })
    if (item.type === 'commandExecution') update(item.id, { kind: 'tool', text: `Shell · ${item.command ?? ''}`, status: item.status, output: String(item.aggregatedOutput ?? old?.output ?? '').slice(-16000), exitCode: item.exitCode })
    if (item.type === 'fileChange') update(item.id, { kind: 'tool', text: `Edit · ${(item.changes ?? []).map((change: any) => change.path).join(', ')}`, status: item.status, diff: (item.changes ?? []).map((change: any) => `${change.path}\n${change.diff ?? ''}`).join('\n').slice(0, 64000) })
    if (item.type === 'mcpToolCall') update(item.id, { kind: 'tool', text: `${item.server === 'ambio' ? 'Ambio' : item.server} · ${item.tool}`, status: item.status })
    if (item.type === 'dynamicToolCall') update(item.id, { kind: 'tool', text: String(item.tool ?? item.type), status: item.status })
    if (item.type === 'collabAgentToolCall') {
      const receivers = [...new Set<string>([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])]
      const targets = receivers.map((id: string) => `${this.agents.get(id) ?? id}${item.agentsStates?.[id]?.status ? ` (${item.agentsStates[id].status})` : ''}`).join(', ')
      const source = item.senderThreadId && item.senderThreadId !== this.threadId ? this.agents.get(item.senderThreadId) ?? item.senderThreadId : 'Main agent'
      update(item.id, { kind: 'tool', text: `Subagent · ${source} · ${item.tool}${targets ? ` → ${targets}` : ''}${item.prompt ? ` · ${String(item.prompt).slice(0, 1000)}` : ''}`, status: item.status })
    }
    if (item.type === 'subAgentActivity') {
      const name = this.agents.get(item.agentThreadId) ?? item.agentPath ?? item.agentThreadId
      if (item.agentThreadId) this.agents.set(item.agentThreadId, name)
      update(item.id, { kind: 'tool', text: `Subagent · ${name} · ${item.kind}${item.model ? ` · ${item.model}` : ''}`, status: item.kind })
    }
    if (item.type === 'functionCallOutput' && done) update(item.id, { kind: 'tool', text: `Tool · ${item.name}`, output: typeof item.output === 'string' ? item.output.slice(-16000) : JSON.stringify(item.output ?? '').slice(-16000) })
    if (item.type === 'plan') update(item.id, { kind: 'thinking', text: String(item.text ?? '').slice(0, 64000) })
    if (item.type === 'enteredReviewMode') update(item.id, { kind: 'tool', text: `Review · ${item.review}` })
    if (item.type === 'exitedReviewMode' && done) { this.reviewText = String(item.review ?? '').slice(0, 64000); update(item.id, { kind: 'text', text: this.reviewText }) }
  }

  private async serverRequest(id: string | number, method: string, params: any): Promise<void> {
    const reply = (result: unknown) => { if (!this.closed) this.turn.send(JSON.stringify({ id, result })) }
    const owns = this.accepting && !this.cancelled && params.threadId === this.threadId && params.turnId === this.turnId
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      if (!owns) { reply({ decision: 'decline' }); return }
      const file = method.includes('fileChange')
      if (file && this.turn.mode !== 'build') { reply({ decision: 'decline' }); return }
      const controller = new AbortController()
      if (this.approvals.has(id)) return
      this.approvals.set(id, controller)
      const question = { title: file ? 'Codex wants to edit files' : 'Codex wants to run a command', kind: file ? 'edit' : 'command', detail: [params.command, params.cwd, params.reason, params.grantRoot, params.networkApprovalContext ? JSON.stringify(params.networkApprovalContext) : '', file ? this.items.get(params.itemId)?.diff : ''].filter(Boolean).join('\n').slice(0, 8000) }
      let allowed = false
      try { allowed = await this.turn.approve?.(question, controller.signal) === true } catch { /* no answer is a refusal */ }
      if (this.approvals.get(id) !== controller) return
      this.approvals.delete(id)
      reply({ decision: allowed && !controller.signal.aborted && this.accepting && !this.cancelled ? 'accept' : 'decline' })
      return
    }
    if (method === 'item/tool/requestUserInput') {
      // This protocol has no decline enum: refuse with a request error, never
      // invent an answer or submit an empty successful form.
      const decline = () => { if (!this.closed) this.turn.send(JSON.stringify({ id, error: { code: -32000, message: 'The user declined to answer Codex\u2019s question.' } })) }
      const questions = params.questions
      if (!owns || !Array.isArray(questions) || !questions.length || questions.length > 8 ||
        questions.some(q => !q || typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question.trim() || q.isSecret) ||
        new Set(questions.map(q => q.id)).size !== questions.length || new Set(questions.map(q => q.question)).size !== questions.length) { decline(); return }
      if (this.approvals.has(id)) return
      const controller = new AbortController()
      this.approvals.set(id, controller)
      let answer: boolean | { answers: Record<string, string> } | undefined
      try {
        answer = await Promise.race([
          this.turn.approve?.({ title: 'Codex is asking', kind: 'question', detail: '', questions: questions.map(q => ({ question: q.question, header: q.header, options: q.options ?? [] })) }, controller.signal),
          new Promise<false>(resolve => controller.signal.addEventListener('abort', () => resolve(false), { once: true })),
        ])
      } catch { /* denial, timeout and cancellation all refuse */ }
      const live = this.approvals.get(id) === controller && !controller.signal.aborted && this.accepting && !this.cancelled
      if (this.approvals.get(id) === controller) this.approvals.delete(id)
      if (controller.signal.reason === 'resolved') return
      const answers = answer && typeof answer === 'object' ? answer.answers : undefined
      if (!live || !answers || questions.some(q => typeof answers[q.question] !== 'string' || !answers[q.question].trim())) { decline(); return }
      reply({ answers: Object.fromEntries(questions.map(q => [q.id, { answers: [answers[q.question]] }])) })
      return
    }
    // Never grant permission profiles or accept an MCP URL flow.
    if (method === 'item/permissions/requestApproval') { reply({ permissions: {}, scope: 'turn' }); return }
    if (method === 'mcpServer/elicitation/request') { reply({ action: 'decline', content: null }); return }
    this.turn.send(JSON.stringify({ id, error: { code: -32601, message: `Ambio does not support ${method}` } }))
  }
}
