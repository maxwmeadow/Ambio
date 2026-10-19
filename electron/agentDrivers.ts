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

// Checks a build may run without asking. Anything else still needs the host's
// own permission, which a run with nobody at the keyboard does not get.
const CHECK_COMMANDS = ['npm run', 'npm test', 'npx tsc', 'go test', 'go vet', 'git status', 'git diff']

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
        // A question or a proposal reads the code and talks to Ambio; only a
        // build may change files. dontAsk refuses whatever is not listed.
        '--permission-mode', building ? 'acceptEdits' : 'dontAsk',
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { ambio: mcpServer(turn) } }),
        '--allowedTools', building
          // On Windows Claude Code runs commands through its PowerShell tool,
          // so the checks are listed for both shells.
          ? ['mcp__ambio', 'Read', 'Glob', 'Grep', 'Edit', 'Write', ...CHECK_COMMANDS.flatMap(command => [`Bash(${command}:*)`, `PowerShell(${command}:*)`])].join(',')
          : 'mcp__ambio,Read,Glob,Grep',
        // A build that wants something beyond its edits and the listed checks
        // asks the user in the conversation instead of being refused unseen.
        ...(building ? (turn.messageId ? ['--permission-prompt-tool', 'mcp__ambio__approve_action'] : []) : ['--disallowedTools', 'Edit,Write,NotebookEdit']),
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
          if (block?.type === 'tool_use') return [{ kind: 'tool' as const, text: [String(block.name ?? 'tool').replace(/^mcp__ambio__/, 'Ambio · '), toolTarget(block.input)].filter(Boolean).join(' · ') }]
          return []
        }),
      }
    }
    if (message.type === 'result' && message.is_error) return { sessionId, events: [{ kind: 'error', text: clip(String(message.result ?? message.subtype ?? 'The run ended with an error.')) }] }
    return { sessionId, events: [] }
  },
}

const codex: AgentDriver = {
  resumable: true,
  plan(turn) {
    const server = mcpServer(turn)
    return {
      stdin: turn.prompt,
      args: [
        'exec', ...(turn.resume ? ['resume', turn.resume] : []), '--json',
        // Codex's sandbox is the permission: read-only for a question or a
        // proposal, the workspace for a build. MCP calls are not shell.
        // `codex exec resume` has no --sandbox (codex-cli 0.162), so a continued
        // session is given the same sandbox as a config override.
        ...(turn.resume
          ? ['-c', `sandbox_mode=${JSON.stringify(turn.mode === 'build' ? 'workspace-write' : 'read-only')}`]
          : ['--sandbox', turn.mode === 'build' ? 'workspace-write' : 'read-only']),
        '--skip-git-repo-check',
        ...(turn.model ? ['-c', `model=${JSON.stringify(turn.model)}`] : []),
        '-c', 'approval_policy="never"',
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
    if (item.type === 'command_execution' && !finished) return { events: [{ kind: 'tool', text: `Shell · ${clip(String(item.command ?? ''), 120)}` }] }
    if (item.type === 'mcp_tool_call' && !finished) return { events: [{ kind: 'tool', text: `${item.server === 'ambio' ? 'Ambio' : item.server ?? 'MCP'} · ${item.tool ?? 'tool'}` }] }
    if (item.type === 'file_change' && finished && Array.isArray(item.changes)) return { events: [{ kind: 'tool', text: `Edit · ${clip(item.changes.map((change: any) => change?.path).filter(Boolean).join(', '), 160)}` }] }
    return NOTHING
  },
}

const copilotCli: AgentDriver = {
  // Copilot's print mode does not report the session it ran in. Its ACP
  // server (a public preview) keeps sessions, so that is tried first and
  // print mode is what a turn falls back to.
  resumable: true,
  // Copilot's ACP server does not load MCP servers a client names in
  // session/new (copilot 1.0.98: the session had none of Ambio's tools), so
  // Ambio's is given on its command line, as print mode does.
  acpArgs: turn => ['--acp', ...modelFlag(turn), '--additional-mcp-config', JSON.stringify({ mcpServers: { ambio: { ...mcpServer(turn), tools: ['*'] } } })],
  plan(turn) {
    const building = turn.mode === 'build'
    return {
      args: [
        '--prompt', turn.prompt,
        ...modelFlag(turn),
        '--additional-mcp-config', JSON.stringify({ mcpServers: { ambio: { ...mcpServer(turn), tools: ['*'] } } }),
        '--allow-tool', 'ambio',
        ...(building ? ['--allow-tool', 'write', ...CHECK_COMMANDS.flatMap(command => ['--allow-tool', `shell(${command}:*)`])] : []),
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
const antigravityCli: AgentDriver = {
  // Plain print mode does not say which conversation it was, so there is no
  // session to continue; the conversation reaches it through get_inbox.
  resumable: false,
  plan(turn) {
    return {
      // Plain print mode: the released CLI (1.0.x) has no --output-format, and
      // a flag it does not know ends the run before it starts.
      // The folder is named as the workspace: print mode otherwise has none,
      // and the project's .agents/mcp_config.json is never loaded.
      args: ['-p', turn.prompt, ...(turn.cwd ? ['--add-dir', turn.cwd] : []), ...(turn.resume ? ['--conversation', turn.resume] : []), ...modelFlag(turn)],
      // Closed at once: agy reads stdin even when the prompt is an argument.
      stdin: undefined,
    }
  },
  read(line) {
    const message = parse(line)
    // Print mode writes the agent's answer as text; a build that can emit
    // JSON events is read as those.
    if (!message) {
      if (/required the "[a-z_]+" permission/i.test(line)) return antigravityRefusal(line)
      return line.trim() ? { events: [{ kind: 'text', text: clip(line, 600) }] } : NOTHING
    }
    const sessionId = typeof message.conversation_id === 'string' ? message.conversation_id
      : typeof message.conversationId === 'string' ? message.conversationId : undefined
    if (message.type === 'result') {
      const failed = typeof message.status === 'string' && !['SUCCESS', 'RUNNING', 'WAITING'].includes(message.status)
      return { sessionId, events: failed ? [{ kind: 'error', text: clip(String(message.error ?? `The run ended ${message.status}.`)) }] : [] }
    }
    if (message.type !== 'step_update') return { sessionId, events: [] }
    const step = message.step ?? message
    const kind = String(step.type ?? step.step_type ?? '')
    if (kind === 'tool') {
      const name = step.tool?.name ?? step.name ?? step.tool_name ?? 'tool'
      // Reported once, when the step begins.
      if (step.status && !/start|pending|running/i.test(String(step.status))) return { sessionId, events: [] }
      return { sessionId, events: [{ kind: 'tool', text: [String(name), toolTarget(step.tool?.args ?? step.args ?? step.input)].filter(Boolean).join(' · ') }] }
    }
    // Whole responses only; the deltas that build one up are not events.
    const text = kind === 'agent_response' && !step.delta ? step.text ?? step.content ?? '' : ''
    return { sessionId, events: typeof text === 'string' && text.trim() ? [{ kind: 'text', text: clip(text, 1200) }] : [] }
  },
  readError(line) {
    return antigravityRefusal(line)
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

export function turnMode(value: unknown): TurnMode {
  return value === 'ask' || value === 'propose' ? value : 'build'
}
