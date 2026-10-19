import type { DeliveryEvent } from '../src/shared/agentDelivery.ts'
import type { DriverTurn } from './agentDrivers.ts'

/** Only the environment variable name appears in arguments, never its value. */
export function chatGPTAppServerArguments(turn: DriverTurn): string[] {
  const settings: Record<string, unknown> = {
    model_provider: 'openai_chatgpt_plan',
    'model_providers.openai_chatgpt_plan.name': 'ChatGPT plan',
    'model_providers.openai_chatgpt_plan.base_url': 'https://api.openai.com/v1',
    'model_providers.openai_chatgpt_plan.env_key': 'AMBIO_CHATGPT_ACCESS_TOKEN',
    'model_providers.openai_chatgpt_plan.wire_api': 'responses',
    'model_providers.openai_chatgpt_plan.requires_openai_auth': false,
    'model_providers.openai_chatgpt_plan.supports_websockets': false,
    'features.tool_search': false,
    'shell_environment_policy.exclude': ['AMBIO_CHATGPT_ACCESS_TOKEN'],
    'mcp_servers.ambio.command': turn.mcp.command,
    'mcp_servers.ambio.args': [...turn.mcp.args, '--ambio-host=chatgpt'],
    'mcp_servers.ambio.env.AMBIO_WORKSPACE_ID': turn.workspaceId,
    'mcp_servers.ambio.env.AMBIO_RUN_MESSAGE_ID': turn.messageId ?? '',
    'mcp_servers.ambio.env.AMBIO_CHATGPT_ACCESS_TOKEN': '',
    'mcp_servers.ambio.enabled': true,
    'mcp_servers.ambio.default_tools_approval_mode': 'approve',
  }
  return ['app-server', '--listen', 'stdio://', ...Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])]
}

export interface CodexAppServerTurn {
  cwd: string; prompt: string; model: string; version: string
  mode: 'ask' | 'propose' | 'build'; resume?: string
  send(line: string): void
  onSession(id: string): void
  onEvent(event: Omit<DeliveryEvent, 'at'>): void
}

/** One stdio app-server process per turn, with freshly renewed credentials. */
export class CodexAppServerClient {
  private turn: CodexAppServerTurn
  private sequence = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private threadId?: string
  private turnId?: string
  private closed = false
  private completed?: { resolve(status: string): void; reject(error: Error): void }
  private text = new Map<string, string>()
  constructor(turn: CodexAppServerTurn) { this.turn = turn }
  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('The Codex harness has stopped.')); return }
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The Codex harness did not answer ${method}. Update Codex CLI and try again.`)) }, 60000)
      this.pending.set(id, { resolve, reject, timer })
      this.turn.send(JSON.stringify({ id, method, params }))
    })
  }
  receive(line: string): void {
    let message: any
    try { message = JSON.parse(line) } catch { return }
    if (!message || this.closed) return
    if (!message.method && message.id !== undefined) {
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      clearTimeout(waiting.timer); this.pending.delete(message.id)
      if (message.error) waiting.reject(new Error('The Codex harness rejected a request. Update Codex CLI or reconnect ChatGPT and try again.'))
      else waiting.resolve(message.result ?? {})
      return
    }
    // Sandbox limits are the permission boundary, as with Ambio's Codex CLI
    // driver. Unexpected server requests cannot grant additional privileges.
    if (message.id !== undefined) {
      const result = message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval'
        ? { decision: 'decline' }
        : message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' }
          : undefined
      this.turn.send(JSON.stringify({ id: message.id, ...(result ? { result } : { error: { code: -32601, message: 'This interaction is not supported by Ambio.' } }) }))
      return
    }
    const params = message.params ?? {}
    if (params.threadId && params.threadId !== this.threadId) return
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const id = String(params.itemId ?? 'message')
      const text = (this.text.get(id) ?? '') + params.delta
      // Keep a whole message together so the runner can redact a credential
      // even when its bytes arrived across multiple protocol deltas.
      this.text.set(id, text)
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') this.flush(String(params.item.id ?? 'message'))
    if (message.method === 'item/started') {
      const item = params.item ?? {}
      if (item.type === 'commandExecution') this.turn.onEvent({ kind: 'tool', text: `Shell · ${String(item.command ?? '').slice(0, 200)}` })
      if (item.type === 'mcpToolCall') this.turn.onEvent({ kind: 'tool', text: `${item.server ?? 'MCP'} · ${item.tool ?? 'tool'}` })
      if (item.type === 'fileChange') this.turn.onEvent({ kind: 'tool', text: 'Editing project files' })
    }
    if (message.method === 'turn/completed') {
      if (this.turnId && params.turn?.id !== this.turnId) return
      for (const id of this.text.keys()) this.flush(id)
      const status = params.turn?.status
      if (status !== 'completed') {
        this.turn.onEvent({ kind: 'error', text: 'ChatGPT did not complete this turn. Check your connection and ChatGPT Settings → Usage, or reconnect the account. No API-key billing fallback is used.' })
      }
      this.completed?.resolve(status === 'completed' ? 'end_turn' : status ?? 'failed')
    }
  }
  private flush(id: string): void {
    const text = this.text.get(id)
    if (text?.trim()) this.turn.onEvent({ kind: 'text', text })
    this.text.delete(id)
  }
  cancel(): void {
    if (this.threadId && this.turnId && !this.closed) void this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('The Codex harness exited before completing the ChatGPT turn.')
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error) }
    this.pending.clear()
    this.completed?.reject(error)
  }
  async run(): Promise<{ stopReason: string; resumed: boolean }> {
    const turn = this.turn
    await this.request('initialize', { clientInfo: { name: 'Ambio', title: 'Ambio', version: turn.version } })
    turn.send(JSON.stringify({ method: 'initialized' }))
    const sandbox = turn.mode === 'build' ? 'workspace-write' : 'read-only'
    const setup = { cwd: turn.cwd, model: turn.model, modelProvider: 'openai_chatgpt_plan', approvalPolicy: 'never', sandbox }
    let thread: any, resumed = false
    if (turn.resume) {
      try { thread = await this.request('thread/resume', { ...setup, threadId: turn.resume }); resumed = true } catch { /* no model request has run; start with Ambio's conversation */ }
    }
    if (!thread) thread = await this.request('thread/start', setup)
    this.threadId = thread.thread?.id
    if (!this.threadId) throw new Error('The Codex harness did not create a conversation.')
    turn.onSession(this.threadId)
    const result = new Promise<string>((resolve, reject) => { this.completed = { resolve, reject } })
    void result.catch(() => {})
    const started = await this.request('turn/start', {
      threadId: this.threadId, model: turn.model, cwd: turn.cwd, approvalPolicy: 'never',
      sandboxPolicy: turn.mode === 'build'
        ? { type: 'workspaceWrite', writableRoots: [turn.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: 'readOnly' },
      input: [{ type: 'text', text: turn.prompt, text_elements: [] }],
    })
    this.turnId = started.turn?.id
    return { stopReason: await result, resumed }
  }
}
