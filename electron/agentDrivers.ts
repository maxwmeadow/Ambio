import { randomUUID } from 'node:crypto'
import type { DeliveryEvent } from '../src/shared/agentDelivery.ts'

/**
 * How Ambio drives each agent CLI for one turn of a conversation.
 *
 * Every host has the same three needs and its own flags for them: start a
 * turn with Ambio's tools attached, continue the session an earlier turn of
 * the same conversation left behind, and say what it is doing while it works.
 * A driver is the whole of one host's answer, so the runner never branches on
 * a host name.
 *
 * Continuing a session is an optimisation. The conversation itself is kept by
 * Ambio and handed to whichever agent claims the turn (get_inbox), so a host
 * that cannot resume, or a resume that fails, loses nothing but the agent's
 * own working memory.
 */

export type TurnMode = 'ask' | 'propose' | 'build'

export interface DriverLauncher { command: string; args: string[] }

export interface DriverTurn {
  hostId: string
  /** The turn's request ID, so the run's questions land on that turn. */
  messageId?: string
  /** The project folder the run starts in. */
  cwd?: string
  mode: TurnMode
  mcp: DriverLauncher
  workspaceId: string
  prompt: string
  /** The host session an earlier turn of this conversation ran in. */
  resume?: string
  /** The model the user chose for this turn; unset keeps the host's default. */
  model?: string
}

/** The usual flag for choosing a model, for hosts that take one. */
const modelFlag = (turn: DriverTurn): string[] => turn.model ? ['--model', turn.model] : []

export interface DriverPlan {
  args: string[]
  /** Written to the process's stdin, for hosts that read the prompt there. */
  stdin?: string
  /** A session ID Ambio chose, for hosts that let the caller name the session. */
  sessionId?: string
}

/** What one line of a host's output means. */
export interface DriverOutput {
  sessionId?: string
  events: Array<Omit<DeliveryEvent, 'at'>>
}

export interface AgentDriver {
  /** True when a later turn can continue this host's session. */
  resumable: boolean
  /**
   * How to start the host as an ACP agent when it can also run in print
   * mode. The session is tried first; print mode is the fallback when the
   * agent cannot start one.
   */
  acpArgs?: (turn: DriverTurn) => string[]
  /**
   * The host is driven as an Agent Client Protocol session (acpClient.ts)
   * instead of a print-mode run: plan() only starts it in that mode, and the
   * prompt, the session and its MCP servers go over the protocol.
   */
  acp?: boolean
  plan(turn: DriverTurn): DriverPlan
  read(line: string): DriverOutput
  /** What a line of the host's error output means, for hosts that explain a failed turn there. */
  readError?(line: string): DriverOutput
}

const NOTHING: DriverOutput = { events: [] }

function clip(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function parse(line: string): Record<string, any> | null {
  if (!line.startsWith('{')) return null
  try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null } catch { return null }
}

function mcpServer(turn: DriverTurn) {
  return {
    command: turn.mcp.command, args: [...turn.mcp.args, `--ambio-host=${turn.hostId}`],
    env: { AMBIO_WORKSPACE_ID: turn.workspaceId, ...(turn.messageId ? { AMBIO_RUN_MESSAGE_ID: turn.messageId } : {}) },
  }
}

/** What a tool call was for, in a few words: the file, command or pattern. */
function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const args = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'messageId', 'sheet', 'name']) {
    if (typeof args[key] === 'string' && args[key]) return clip(args[key] as string, 120)
  }
  return ''
}

// Agents Ambio runs are given as much access as each one allows: nobody is at
// their keyboard to approve a step, and a refused step ends the turn. A build
// runs unrestricted. Ask and Propose may run any command (searching, listing,
// tests) but have their file-editing tools switched off where the agent can
// do that; the turn's contract tells them not to change anything. Each
// destination's guide says what this means for it.

const claudeCode: AgentDriver = {
  resumable: true,
  plan(turn) {
    // The session is named up front, so a turn that is stopped before it
    // prints anything can still be continued.
    const sessionId = turn.resume ? undefined : randomUUID()
    const building = turn.mode === 'build'
    return {
      sessionId,
      stdin: turn.prompt,
      args: [
        '-p', '--output-format', 'stream-json', '--verbose',
        ...(turn.resume ? ['--resume', turn.resume] : ['--session-id', sessionId!]),
        ...modelFlag(turn),
        // Every permission is granted; a question or a proposal loses only the
        // tools that write files (deny rules hold even when bypassing).
        '--permission-mode', 'bypassPermissions',
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { ambio: mcpServer(turn) } }),
        ...(building ? [] : ['--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit']),
      ],
    }
  },
  read(line) {
    const message = parse(line)
    if (!message) return NOTHING
    const sessionId = typeof message.session_id === 'string' ? message.session_id : undefined
    if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
      // Subagent chatter belongs to its own run, not this conversation.
      if (message.parent_tool_use_id) return { sessionId, events: [] }
      return {
        sessionId,
        events: message.message.content.flatMap((block: any) => {
          if (block?.type === 'text' && block.text?.trim()) return [{ kind: 'text' as const, text: clip(block.text, 1200) }]
          // A thinking block carries its text when the model shows it; some leave it empty.
          if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) return [{ kind: 'thinking' as const, text: thought(block.thinking) }]
          if (block?.type === 'tool_use') return [{ kind: 'tool' as const, text: [String(block.name ?? 'tool').replace(/^mcp__ambio__/, 'Ambio · '), toolTarget(block.input)].filter(Boolean).join(' · ') }]
          return []
        }),
      }
    }
    if (message.type === 'result' && message.is_error) return { sessionId, events: [{ kind: 'error', text: clip(String(message.result ?? message.subtype ?? 'The run ended with an error.')) }] }
    return { sessionId, events: [] }
  },
}

/** An agent's reasoning as one quiet line: markdown emphasis and line breaks dropped. */
export function thought(text: unknown): string {
  return clip(String(text).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(), 400)
}

/** Cursor streams thinking in pieces; each session's is said whole when it completes. */
const cursorThinking = new Map<string, string>()

const codex: AgentDriver = {
  resumable: true,
  plan(turn) {
    const server = mcpServer(turn)
    return {
      stdin: turn.prompt,
      args: [
        'exec', ...(turn.resume ? ['resume', turn.resume] : []), '--json',
        // Codex's sandbox is the permission (see codexSandbox). `codex exec
        // resume` has no --sandbox (codex-cli 0.162), so a continued session is
        // given the same sandbox as a config override.
        ...(turn.resume
          ? ['-c', `sandbox_mode=${JSON.stringify(codexSandbox(turn.mode))}`]
          : ['--sandbox', codexSandbox(turn.mode)]),
        '--skip-git-repo-check',
        ...(turn.model ? ['-c', `model=${JSON.stringify(turn.model)}`] : []),
        '-c', 'approval_policy="never"',
        // Codex keeps its reasoning to itself unless asked for a summary;
        // the summaries show in the turn's activity as it works.
        '-c', 'model_reasoning_summary="auto"',
        '-c', `mcp_servers.ambio.command=${JSON.stringify(server.command)}`,
        '-c', `mcp_servers.ambio.args=${JSON.stringify(server.args)}`,
        '-c', `mcp_servers.ambio.env.AMBIO_WORKSPACE_ID=${JSON.stringify(turn.workspaceId)}`,
        '-c', 'mcp_servers.ambio.enabled=true',
        // With approval_policy "never", Codex refuses every MCP call that needs
        // approval, including Ambio's own (codex-cli 0.162). Ambio's server, and
        // only it, is approved; shell and edits stay under the sandbox.
        '-c', 'mcp_servers.ambio.default_tools_approval_mode="approve"', '-',
      ],
    }
  },
  read(line) {
    const message = parse(line)
    if (!message) return NOTHING
    if (message.type === 'thread.started' && typeof message.thread_id === 'string') return { sessionId: message.thread_id, events: [] }
    if (message.type === 'turn.failed' || message.type === 'error') return { events: [{ kind: 'error', text: clip(String(message.error?.message ?? message.message ?? 'The turn failed.')) }] }
    const item = message.type === 'item.completed' || message.type === 'item.started' ? message.item : undefined
    if (!item) return NOTHING
    const finished = message.type === 'item.completed'
    if (item.type === 'agent_message' && finished && item.text?.trim()) return { events: [{ kind: 'text', text: clip(item.text, 1200) }] }
    if (item.type === 'reasoning' && finished && item.text?.trim()) return { events: [{ kind: 'thinking', text: thought(item.text) }] }
    if (item.type === 'command_execution' && !finished) return { events: [{ kind: 'tool', text: `Shell · ${clip(String(item.command ?? ''), 120)}` }] }
    if (item.type === 'mcp_tool_call' && !finished) return { events: [{ kind: 'tool', text: `${item.server === 'ambio' ? 'Ambio' : item.server ?? 'MCP'} · ${item.tool ?? 'tool'}` }] }
    if (item.type === 'file_change' && finished && Array.isArray(item.changes)) return { events: [{ kind: 'tool', text: `Edit · ${clip(item.changes.map((change: any) => change?.path).filter(Boolean).join(', '), 160)}` }] }
    return NOTHING
  },
}

/** Copilot CLI: everything for a build; every tool but writing files otherwise. */
const copilotAccess = (turn: DriverTurn): string[] => turn.mode === 'build'
  ? ['--yolo']
  : ['--allow-all-tools', '--allow-all-paths', '--allow-all-urls', '--deny-tool', 'write']

const copilotCli: AgentDriver = {
  // Copilot's print mode does not report the session it ran in. Its ACP
  // server (a public preview) keeps sessions, so that is tried first and
  // print mode is what a turn falls back to.
  resumable: true,
  // Copilot's ACP server does not load MCP servers a client names in
  // session/new (copilot 1.0.98: the session had none of Ambio's tools), so
  // Ambio's is given on its command line, as print mode does.
  acpArgs: turn => ['--acp', ...modelFlag(turn), ...copilotAccess(turn), '--additional-mcp-config', JSON.stringify({ mcpServers: { ambio: { ...mcpServer(turn), tools: ['*'] } } })],
  plan(turn) {
    return {
      args: [
        '--prompt', turn.prompt,
        ...modelFlag(turn),
        '--additional-mcp-config', JSON.stringify({ mcpServers: { ambio: { ...mcpServer(turn), tools: ['*'] } } }),
        ...copilotAccess(turn),
        '--no-ask-user',
      ],
    }
  },
  read(line) {
    return line.trim() ? { events: [{ kind: 'text', text: clip(line, 600) }] } : NOTHING
  },
}

// Cursor's terminal agent. It reads MCP servers from the project's or the
// user's .cursor/mcp.json, which is where Ambio's Cursor install writes its
// own, so no per-run MCP config is passed.
const cursorCli: AgentDriver = {
  resumable: true,
  plan(turn) {
    return {
      args: [
        // Nobody is there to approve the workspace or the MCP servers Ambio's
        // Cursor install wrote, so both are accepted for the run.
        '-p', '--output-format', 'stream-json', '--trust', '--approve-mcps',
        ...(turn.resume ? [`--resume=${turn.resume}`] : []),
        // Without --force Cursor only proposes changes; ask and plan are its
        // read-only modes. The mode is given on every turn: a resumed chat
        // otherwise keeps the one it was last in.
        ...(turn.mode === 'build' ? ['--force'] : ['--mode', turn.mode === 'ask' ? 'ask' : 'plan']),
        ...modelFlag(turn),
        turn.prompt,
      ],
    }
  },
  read(line) {
    const message = parse(line)
    if (!message) return NOTHING
    const sessionId = typeof message.session_id === 'string' ? message.session_id : typeof message.chat_id === 'string' ? message.chat_id : undefined
    if (message.type === 'assistant') {
      const content = message.message?.content
      const text = Array.isArray(content) ? content.map((block: any) => block?.text ?? '').join('') : typeof content === 'string' ? content : ''
      return { sessionId, events: text.trim() ? [{ kind: 'text', text: clip(text, 1200) }] : [] }
    }
    if (message.type === 'thinking') {
      const key = sessionId ?? ''
      if (typeof message.text === 'string') cursorThinking.set(key, (cursorThinking.get(key) ?? '') + message.text)
      if (message.subtype !== 'completed') return { sessionId, events: [] }
      const text = cursorThinking.get(key) ?? ''
      cursorThinking.delete(key)
      return { sessionId, events: text.trim() ? [{ kind: 'thinking', text: thought(text) }] : [] }
    }
    if (message.type === 'tool_call' && message.subtype === 'started') {
      const call = message.tool_call ?? {}
      const name = Object.keys(call)[0] ?? 'tool'
      return { sessionId, events: [{ kind: 'tool', text: [name.replace(/ToolCall$/, ''), toolTarget(call[name]?.args)].filter(Boolean).join(' · ') }] }
    }
    if (message.type === 'result' && message.is_error) return { sessionId, events: [{ kind: 'error', text: clip(String(message.result ?? 'The run ended with an error.')) }] }
    return { sessionId, events: [] }
  },
}

// Antigravity's own terminal agent. It has no per-run MCP flag: it loads the
// servers in ~/.gemini/config/mcp_config.json and the project's
// .agents/mcp_config.json, which is where Ambio's Antigravity install writes.
// Print mode cannot ask for approval, so an MCP tool call is denied unless
// the user has allowed it in Antigravity CLI's settings, and the run still
// exits cleanly with nothing said. That is reported as what it is (observed
// with agy 1.0.16). Ambio never passes its skip-permissions flag.
/** What Antigravity CLI's refusal means for this turn, by the permission it needed. */
function antigravityRefusal(line: string): DriverOutput {
  const needed = /required the "([a-z_]+)" permission/i.exec(line)?.[1]
  if (!needed) return NOTHING
  return { events: [{ kind: 'error', text: needed === 'mcp'
    ? 'Antigravity CLI did not let the agent use Ambio’s tools: its print mode cannot ask you for permission. Add Ambio to Antigravity again in Settings → Agents (that allows them), or add "mcp(ambio/*)" to permissions.allow in ~/.gemini/antigravity-cli/settings.json, then send again.'
    : `Antigravity CLI stopped the turn: the agent needed the "${needed}" permission, which its print mode cannot ask you for, and it ends the run on a refusal. Send this turn to Antigravity's own chat instead, or allow that action in ~/.gemini/antigravity-cli/settings.json.` }] }
}
// Antigravity streams a response as text deltas; each step's text is gathered
// here and reported whole when the step is done. Keyed by conversation and step.
const antigravityText = new Map<string, string>()

const antigravityCli: AgentDriver = {
  // stream-json (agy 1.4) names the conversation, so a later turn continues it.
  resumable: true,
  plan(turn) {
    return {
      // stream-json reports each step as it happens; plain print mode said
      // nothing until the whole turn was over.
      // The folder is named as the workspace: print mode otherwise has none,
      // and the project's .agents/mcp_config.json is never loaded.
      // Its print mode cannot ask, so without this any command ends the turn.
      // Nothing narrower exists: Ask and Propose rely on the turn's contract.
      args: ['-p', turn.prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions', ...(turn.cwd ? ['--add-dir', turn.cwd] : []), ...(turn.resume ? ['--conversation', turn.resume] : []), ...modelFlag(turn)],
      // Closed at once: agy reads stdin even when the prompt is an argument.
      stdin: undefined,
    }
  },
  read(line) {
    const message = parse(line)
    // Anything not JSON is said as it is (an older agy's plain answer, or a warning).
    if (!message) {
      if (/required the "[a-z_]+" permission/i.test(line)) return antigravityRefusal(line)
      if (/flag provided but not defined: -output-format/i.test(line)) return { events: [{ kind: 'error', text: 'This Antigravity CLI is too old to report its progress. Update it (agy update) and send again.' }] }
      return line.trim() ? { events: [{ kind: 'text', text: clip(line, 600) }] } : NOTHING
    }
    // agy 1.4: {"event": name, [name]: payload}; earlier builds put the payload at the top.
    const event = String(message.event ?? message.type ?? '')
    const payload = (event && typeof message[event] === 'object' ? message[event] : null) ?? message.step ?? message
    const sessionId = typeof payload.conversation_id === 'string' ? payload.conversation_id
      : typeof message.conversation_id === 'string' ? message.conversation_id
        : typeof payload.conversationId === 'string' ? payload.conversationId : undefined
    if (event === 'init') return { sessionId, events: [] }
    if (event === 'result') {
      const failed = typeof payload.status === 'string' && !['SUCCESS', 'RUNNING', 'WAITING'].includes(payload.status)
      return { sessionId, events: failed ? [{ kind: 'error', text: clip(String(payload.error ?? `The run ended ${payload.status}.`)) }] : [] }
    }
    if (event !== 'step_update') return { sessionId, events: [] }
    const kind = String(payload.step_type ?? payload.type ?? '')
    const state = String(payload.state ?? payload.status ?? '')
    // A step is reported once, when it begins (or when nothing says it has a state).
    const beginning = !state || /^active$|start|pending|running/i.test(state)
    if (kind === 'tool') {
      if (!beginning) return { sessionId, events: [] }
      const name = payload.tool_name ?? payload.tool_info?.name ?? payload.tool?.name ?? payload.name ?? 'tool'
      const parameters = payload.tool_info?.parameters ?? payload.tool?.args ?? payload.args ?? payload.input
      const command = typeof parameters?.CommandLine === 'string' ? clip(parameters.CommandLine, 120) : ''
      return { sessionId, events: [{ kind: 'tool', text: [String(name), command || toolTarget(parameters)].filter(Boolean).join(' · ') }] }
    }
    // agy 1.4 reports only how many thinking tokens a step used; a build that
    // sends the thinking itself is shown like the other agents'.
    const thinking = typeof payload.thinking === 'string' ? payload.thinking : typeof payload.thinking_text === 'string' ? payload.thinking_text : ''
    if (thinking.trim()) return { sessionId, events: [{ kind: 'thinking', text: thought(thinking) }] }
    if (kind === 'agent_response') {
      const key = `${sessionId}:${payload.step_index}`
      if (typeof payload.text_delta === 'string') antigravityText.set(key, (antigravityText.get(key) ?? '') + payload.text_delta)
      // Earlier builds sent the whole text at once; their deltas are not events.
      const whole = typeof payload.text === 'string' && !payload.delta ? payload.text : ''
      if (!/^done$/i.test(state) && !whole) return { sessionId, events: [] }
      const text = whole || antigravityText.get(key) || ''
      antigravityText.delete(key)
      return { sessionId, events: text.trim() ? [{ kind: 'text', text: clip(text, 1200) }] : [] }
    }
    // Other steps (waiting on a background task, a subagent, a search) are said by their kind.
    if (kind && kind !== 'user_input' && beginning && state) return { sessionId, events: [{ kind: 'tool', text: kind.replace(/_/g, ' ') }] }
    return { sessionId, events: [] }
  },
  readError(line) {
    const refusal = antigravityRefusal(line)
    if (refusal.events.length) return refusal
    // Its own word on a long wait ("waiting up to 30m0s for 1 background task"), a retry or a limit.
    return /waiting|idle|retry|rate.?limit|quota|timed? ?out/i.test(line) ? { events: [{ kind: 'tool', text: clip(line, 300) }] } : NOTHING
  },
}

/** A host started as an ACP agent; everything else is said over the protocol. */
function acpDriver(args: string[]): AgentDriver {
  return { resumable: true, acp: true, plan: () => ({ args }), read: () => NOTHING }
}

const DRIVERS: Record<string, AgentDriver> = {
  'claude-code': claudeCode,
  codex,
  'copilot-cli': copilotCli,
  'cursor-cli': cursorCli,
  // Windsurf's local agent speaks ACP, which lets Ambio hand it its MCP
  // server for the session. (Gemini CLI did too; Google replaced it with
  // Antigravity and refuses it for personal accounts.)
  'devin-cli': acpDriver(['acp']),
  // Antigravity's own CLI has no ACP mode; Google ships a separate ACP server.
  'antigravity-acp': acpDriver([]),
  'antigravity-cli': antigravityCli,
}

export function agentDriver(hostId: string): AgentDriver | undefined {
  return DRIVERS[hostId]
}

/** The executable each driven host installs. */
export const DRIVER_CLI_NAMES: Record<string, string[]> = {
  'claude-code': ['claude'],
  codex: ['codex'],
  'copilot-cli': ['copilot'],
  // Cursor also installs it as `agent`, a name too common to trust on a PATH.
  'cursor-cli': ['cursor-agent'],
  'devin-cli': ['devin'],
  'antigravity-acp': ['agy_acp_server', 'agy_acp_server.par'],
  'antigravity-cli': ['agy'],
}

/**
 * Codex's sandbox for a turn. A question or a proposal runs any command but
 * cannot write (read-only); a build has full access. On Windows Codex's
 * read-only sandbox cannot start a shell at all ("helper_unknown_error: setup
 * refresh had errors"), which left a question or a proposal unable to read a
 * single source file, so there every mode runs with full access and the turn's
 * instructions - not the sandbox - keep a question or proposal from editing.
 */
export function codexSandbox(mode: string | undefined, platform: NodeJS.Platform = process.platform): 'read-only' | 'danger-full-access' {
  return mode === 'build' || platform === 'win32' ? 'danger-full-access' : 'read-only'
}

export function turnMode(value: unknown): TurnMode {
  return value === 'ask' || value === 'propose' ? value : 'build'
}
