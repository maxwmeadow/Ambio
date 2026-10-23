import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { resolve } from 'node:path'
import type { AcpTurn, AcpOutcome } from './acpClient.ts'

/** Muse Session Protocol v1, as published by meta-models/muse-code-sdk.
 * The runner owns the process; this class owns its line-delimited JSON-RPC.
 * Session construction binds Ambio directly, without changing Muse settings.
 */
export interface MuseTurn extends AcpTurn {
  model?: string
  /** Explicit policy experiments use this; normal delivery retains allowAll. */
  approvalMode?: 'allowAll' | 'denyUnmatched'
}

// MSP command identities must be UUIDv7, including turn/start and interrupt.
export function museCommandId(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6] & 15) | 0x70
  bytes[8] = (bytes[8] & 63) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class MuseClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private sessionId = ''
  private turnId = ''
  private closed = false
  private awaitingTurnAck = false
  private earlyNotifications: string[] = []
  private completed?: { resolve: (value: AcpOutcome) => void; reject: (error: Error) => void }
  private resumed = false
  private items = new Map<string, { kind: string; text: string }>()
  private turn: MuseTurn
  constructor(turn: MuseTurn) { this.turn = turn }

  private send(message: object): void { this.turn.send(JSON.stringify({ jsonrpc: '2.0', ...message })) }
  private request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Muse exited before answering.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Muse did not answer ${method}. Update Muse and check its terminal sign-in.`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }

  async initialize(): Promise<void> {
    const result = await this.request('initialize', { clientInfo: { name: 'ambio', version: '1' } })
    if (result.schema?.version !== 1) throw new Error('This Muse version does not support Session Protocol v1. Update Muse, then send again.')
    this.send({ method: 'initialized' })
  }

  async models(): Promise<any[]> {
    await this.initialize()
    const result = await this.request('model/list', {})
    return Array.isArray(result.models) ? result.models : []
  }

  receive(line: string): void {
    let message: any
    try { message = JSON.parse(line) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(String(message.error.message ?? 'Muse refused the request.')))
      else pending.resolve(message.result ?? {})
      return
    }
    // Muse may make a request that needs a UI. Never leave the run waiting on
    // a response Ambio cannot provide; the error is shown below the message.
    if (message.id !== undefined) {
      this.send({ id: message.id, error: { code: -32601, message: 'Ambio cannot answer interactive Muse requests. Resolve them in a Muse terminal session.' } })
    }
    const params = message.params
    if (!this.sessionId || params?.sessionId !== this.sessionId) return
    // The ack's turnId is authoritative. A fast server may send events first.
    if (this.awaitingTurnAck && message.id === undefined) {
      if (this.earlyNotifications.length >= 1000) this.completed?.reject(new Error('Muse sent too many events before acknowledging the turn.'))
      else this.earlyNotifications.push(line)
      return
    }
    if (message.method === 'approval/requested' || message.method === 'userInput/requested' || message.method === 'approval/request' || message.method === 'userInput/request') {
      this.completed?.reject(new Error('Muse needs an interactive approval or answer. Open its session in a terminal to resolve it, then send again.'))
      this.cancel()
    }
    if (message.method === 'view/gap') {
      this.completed?.reject(new Error('Muse lost part of the live event stream. Check its session before sending again.'))
      this.cancel()
    }
    const item = params?.item
    if (item?.turnId && item.turnId !== this.turnId) return
    if (message.method === 'item/started' && item) {
      this.items.set(item.itemId, { kind: item.kind, text: item.text ?? '' })
      if (item.kind === 'toolCall') this.turn.onEvent({ kind: 'tool', text: String(item.toolName ?? item.name ?? 'Muse tool').slice(0, 400) })
    }
    if (message.method === 'item/delta') {
      const current = this.items.get(params.itemId)
      if (current && (params.field ?? 'text') === 'text') current.text = (current.text + String(params.delta ?? '')).slice(-12000)
    }
    if (message.method === 'item/completed' && item) {
      const current = this.items.get(item.itemId)
      const text = item.text ?? (Array.isArray(item.summary) ? item.summary.join(' ') : item.summary) ?? current?.text
      if (text && ['agentMessage', 'reasoning'].includes(item.kind)) this.turn.onEvent({ kind: item.kind === 'reasoning' ? 'thinking' : 'text', text: String(text).slice(0, 1200) })
      if (item.kind === 'toolCall' && !current) this.turn.onEvent({ kind: 'tool', text: String(item.toolName ?? item.name ?? 'Muse tool').slice(0, 400) })
      if (item.kind === 'toolCall' && item.status === 'failed') this.turn.onEvent({ kind: 'error', text: String(item.error?.message ?? 'Muse tool failed.').slice(0, 1200) })
      this.items.delete(item.itemId)
    }
    if (message.method === 'turn/completed' && params.turnId === this.turnId) {
      if (params.error) this.completed?.reject(new Error(String(params.error.message ?? 'Muse turn failed.')))
      else this.completed?.resolve({ stopReason: params.terminal === 'completed' ? 'end_turn' : String(params.terminal), resumed: this.resumed })
    }
  }

  async run(): Promise<AcpOutcome> {
    await this.initialize()
    const approvalMode = this.turn.approvalMode ?? 'allowAll'
    const config = { mcpServers: Object.fromEntries(this.turn.mcpServers.map(server => [server.name, {
      transport: 'stdio', command: server.command, args: server.args, env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])), mode: 'required',
    }])) }
    let result: any
    if (this.turn.resume) {
      try {
        result = await this.request('session/resume', { commandId: museCommandId(), sessionId: this.turn.resume, excludeItems: true, config })
        this.resumed = true
      } catch { /* missing/older session: Ambio still supplies the conversation */ }
    }
    if (!this.resumed) result = await this.request('session/start', {
      commandId: museCommandId(), workspaceRoot: this.turn.cwd, config, approvalMode,
      ...(this.turn.model ? { modelId: this.turn.model } : {}),
    })
    const session = result.session
    // A stale or externally reassigned session must not edit another project.
    const canonical = (folder: string) => { try { return fs.realpathSync(folder) } catch { return resolve(folder) } }
    if (!session?.sessionId || !session.workspaceRoot || canonical(session.workspaceRoot) !== canonical(this.turn.cwd)) throw new Error('Muse returned a session for a different project. Start a new conversation.')
    this.sessionId = session.sessionId
    this.turn.onSession(this.sessionId)
    if (result.pendingRequests?.length) throw new Error('Muse has an interactive request pending. Resolve it in a Muse terminal session, then send again.')
    if (session.activeTurnId) throw new Error('Muse is already running a turn in this session. Stop it in Muse before sending again.')
    if (this.resumed) {
      await this.request('session/setApprovalMode', { commandId: museCommandId(), sessionId: this.sessionId, mode: approvalMode })
      if (this.turn.model) await this.request('session/setModel', { commandId: museCommandId(), sessionId: this.sessionId, model: { modelId: this.turn.model } })
    }
    const commandId = museCommandId()
    this.awaitingTurnAck = true
    // Register before sending: a short run can finish before its ack arrives.
    const completion = new Promise<AcpOutcome>((resolve, reject) => { this.completed = { resolve, reject } })
    // Attach the rejection handler immediately while turn/start is pending.
    const acknowledged = this.request('turn/start', { commandId, sessionId: this.sessionId, input: [{ type: 'text', text: this.turn.prompt }], ifBusy: 'queue' }).then(ack => {
      if (typeof ack.turnId !== 'string' || !ack.turnId) throw new Error('Muse did not acknowledge a turn identity.')
      this.turnId = ack.turnId
      this.awaitingTurnAck = false
      const early = this.earlyNotifications; this.earlyNotifications = []
      for (const line of early) this.receive(line)
    })
    const [outcome] = await Promise.all([completion, acknowledged])
    return outcome
  }

  cancel(): void {
    if (!this.sessionId || this.closed) return
    void this.request('turn/interrupt', { commandId: museCommandId(), sessionId: this.sessionId, ...(this.turnId ? { turnId: this.turnId } : {}) }).catch(() => {})
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('Muse exited before the turn finished. Check its terminal sign-in and the run output.')
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.completed?.reject(error)
  }
}
