export type DeliveryRoute = 'run' | 'open' | 'copy'
export type CodexTransport = 'app-server' | 'exec'
export interface DeliveryUsage { scope?: 'thread'; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number }

/** Supported terminal routes, independent of what happens to be installed. */
export const CLI_CLIENTS = [
  { id: 'claude-code', label: 'Claude Code CLI' },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'grok', label: 'Grok Build CLI' },
  { id: 'muse', label: 'Muse Code CLI' },
  { id: 'cursor-cli', label: 'Cursor CLI' },
  { id: 'devin-cli', label: 'Devin CLI' },
  { id: 'antigravity-cli', label: 'Antigravity CLI' },
] as const

/**
 * Clients merged into another. Saved choices, runs, sessions and CLI locations
 * that name one are read as the client that remains.
 */
const RETIRED_CLIENTS: Record<string, string> = {
  // agy 1.5 serves ACP itself; Antigravity CLI uses it for the models it offers.
  'antigravity-acp': 'antigravity-cli',
}

export function currentClientId(id: string): string {
  return RETIRED_CLIENTS[id] ?? id
}

/** External clients sharing an existing installer's connection files. */
export const SHARED_APP_CLIENTS = [
  { id: 'claude-code-vscode', installer: 'claude-code', label: 'Claude Code in VS Code', modality: 'vscode' },
  { id: 'claude-code-jetbrains', installer: 'claude-code', label: 'Claude Code in JetBrains', modality: 'editor' },
  { id: 'codex-ide', installer: 'codex', label: 'Codex IDE extension', modality: 'vscode' },
  { id: 'codex-app', installer: 'codex', label: 'Codex desktop app', modality: 'desktop' },
] as const

export function installerHostId(id: string): string {
  return SHARED_APP_CLIENTS.find(client => client.id === id)?.installer ?? id
}

export const APP_CLIENTS = [
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'copilot', label: 'GitHub Copilot in VS Code' },
  { id: 'antigravity', label: 'Antigravity (App & IDE)' },
  { id: 'cursor', label: 'Cursor IDE' },
  { id: 'windsurf', label: 'Windsurf IDE' },
  { id: 'jetbrains', label: 'JetBrains AI Assistant' },
  { id: 'zed', label: 'Zed Editor' },
  ...SHARED_APP_CLIENTS,
] as const

export interface DeliveryHost {
  id: string
  label: string
  route: DeliveryRoute
  available: boolean
  detail: string
  /** The CLI entry file (the script when using bundled Node), never credentials. */
  executablePath?: string
  executableOverride?: string
  discoveryError?: string
  /** The access levels this agent can be run at; unset runs it with full access only. */
  access?: AgentAccess[]
  /** The levels are still being found out (Codex's server is asked once); read the list again shortly. */
  accessPending?: boolean
}

/**
 * How much an agent Ambio runs may do without asking, chosen per agent.
 * Questions go to the conversation's permission card; no answer is a no.
 */
export type AgentAccess = 'ask' | 'edits' | 'auto' | 'full'

export const AGENT_ACCESS: { id: AgentAccess; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask me', hint: 'Reading runs freely; it asks you before it edits a file or runs a command.' },
  { id: 'edits', label: 'Allow edits', hint: 'It edits files in the project freely and asks before it runs a command.' },
  { id: 'auto', label: 'Auto', hint: 'The agent’s own safety check runs ordinary steps and refuses risky ones.' },
  { id: 'full', label: 'Full access', hint: 'Everything runs without asking. Use it on projects and computers you trust.' },
]

export const isAgentAccess = (value: unknown): value is AgentAccess => AGENT_ACCESS.some(level => level.id === value)

/**
 * The level suggested when an agent is first chosen, never preselected: the
 * agent's own safety check where it has one, else full access (DECISIONS
 * 2026-11-05).
 */
export function recommendedAgentAccess(levels: AgentAccess[]): AgentAccess | undefined {
  return levels.includes('auto') ? 'auto' : levels.includes('full') ? 'full' : levels[0]
}

/** Where an agent words a level its own way. */
export function agentAccessDescriptions(hostId: string): Partial<Record<AgentAccess, string>> | undefined {
  return hostId === 'codex' ? {
    ask: 'Codex works inside the project sandbox and asks here when an action needs more access. Ask and Propose stay read-only.',
    auto: 'Codex keeps the same sandbox; its native safety reviewer decides requests for more access. Routine actions inside the sandbox run without review.',
  } : undefined
}

export interface DeliveryRun {
  codexTransport?: CodexTransport
  /** The approval policy a native Codex turn ran with, derived from its access level. */
  codexApproval?: 'never' | 'on-request'
  serverVersion?: string
  usage?: DeliveryUsage
  key: string
  workspaceId: string
  messageId: string
  revision: string
  hostId: string
  rootPath: string
  state: 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'launch-failed' | 'stopped' | 'interrupted'
  detail: string
  logPath: string
  startedAt: number
  pid?: number
  processIdentity?: string | null
  /** The conversation and the kind of turn this run answers. */
  threadId?: string
  mode?: 'ask' | 'propose' | 'build'
  /** The host's own session, kept so the conversation's next turn can continue it. */
  sessionId?: string
  /** Chosen once for an Antigravity conversation; older CLI receipts mean print. */
  transport?: 'acp' | 'print'
  model?: string
  thinking?: string
  /** The run takes messages while it works (DeliveryRunner.steer). */
  canSteer?: boolean
  /** This run continued the session an earlier turn left behind. */
  resumed?: boolean
  /** Finite setup mapping; never resumed as ordinary work. */
  mappingAttemptId?: string
}

/** One thing a running agent said or did, as the host reported it. */
export interface DeliveryEvent {
  /** Stable provider item identity; later snapshots replace the earlier activity. */
  id?: string
  status?: string
  output?: string
  diff?: string
  exitCode?: number | null
  at: number
  /** thinking: the agent's own summary of its reasoning, where the host reports one.
   *  sent: a message the user sent into the running turn, once the agent took it in. */
  kind: 'text' | 'tool' | 'error' | 'thinking' | 'sent'
  text: string
  /** Text the agent is still writing; replaced as it grows and dropped when the message is complete. */
  live?: boolean
}

export interface DeliveryRequest {
  codexTransport?: CodexTransport
  codexReview?: boolean
  workspaceId: string
  messageId: string
  hostId: string
  mappingAttemptId?: string
  /** The model to run the agent with; unset uses the agent's own default. */
  model?: string
  thinking?: string
  /** Where an agent Ambio starts works: the project's own checkout (the
   *  default), or a new worktree of its own on an ambio/ branch, so several
   *  can work at once (docs/GIT_AND_PROJECT_SHAPES.md stage 4). A follow-up
   *  turn keeps the worktree its conversation started in. */
  where?: 'here' | 'worktree'
  /** How much the agent may do without asking, for an agent that offers levels (DeliveryHost.access). */
  access?: AgentAccess
}

/** A model an agent can be asked to use. */
export interface ModelOption {
  id: string
  label: string
  transport?: 'acp' | 'print'
  aliases?: string[]
  printIds?: string[]
  thinkingLevels?: Array<{ id: string; label: string }>
  defaultThinking?: string
}

export interface DeliveryResult {
  detail: string
  run?: DeliveryRun
}

export interface MappingAttempt {
  id: string
  workspaceId: string
  rootId: string
  messageId?: string
  state: 'mapping' | 'submitted' | 'cancelled'
  proposalId?: string
  notes: string[]
  systemCount?: number
  startedAt: number
  submittedAt?: number
  endedAt?: number
}

/** Launcher memory only; never stored in browser state or launch receipts. */
export interface MappingBinding { attempt: MappingAttempt; token: string }

/** The dropdown value for "save the request and copy the handoff myself". */
export const MANUAL_DELIVERY = ''

/**
 * The dropdown value for "a session that is watching Ambio": the request is
 * left open for the session the user told to watch, which picks it up with
 * its own conversation intact.
 */
export const WATCHING_DELIVERY = '@watching'

/**
 * Where a new request goes before the user says otherwise: where they sent
 * the last one in this project, else an agent that is connected to Ambio
 * right now, else one Ambio is installed in, else by hand.
 *
 * remembered is null when the user has never chosen here, and MANUAL_DELIVERY
 * when by hand was their choice.
 */
export function chooseDeliveryHost({ hosts, remembered, liveIds, installedIds }: {
  hosts: DeliveryHost[]
  remembered: string | null
  liveIds: string[]
  installedIds: string[]
}): string {
  const usable = (id: string) => hosts.some(host => host.id === id && host.available)
  if (remembered === MANUAL_DELIVERY) return MANUAL_DELIVERY
  if (remembered?.startsWith(`${CHAT_DELIVERY}:`)) return remembered
  if (remembered && usable(remembered)) return remembered
  const live = liveIds.find(usable)
  if (live) return live
  return hosts.find(host => host.available && installedIds.includes(host.id))?.id ?? MANUAL_DELIVERY
}

/** The picker value for a conversation with Ambio's own chat agent. */
export const CHAT_DELIVERY = '@chat'

/**
 * How to use the panel with each destination, and what the agent can do from
 * it, written for the person choosing. Behind the info button beside the
 * picker; which ones have been tested is recorded in docs/INBOX_PROTOCOL.md.
 */
export interface DestinationGuide {
  /** What has to be true on this computer before it works. */
  need: string[]
  how: string[]
  can: string[]
}

/**
 * Agents Ambio runs are given every permission they offer, so a turn never
 * stops on a step nobody is there to approve. Said in each of their guides.
 */
const FULL_ACCESS = 'Ambio runs it with your account\u2019s full permissions so it never stops to ask. Use it on projects and computers you trust.'

const STARTED = (name: string, extra = 'It remembers the conversation from one message to the next.'): string[] => [
  `Choose ${name} and send. Ambio starts it in this project for you; nothing else needs to be open.`,
  'You can watch what it is doing under your message, and its reply arrives in the conversation.',
  `Keep replying in the same conversation. ${extra}`,
]

const PASTED = (name: string): DestinationGuide => ({
  need: [`Ambio added to ${name} once, from Settings \u2192 Agents.`, `${name} open while you work.`],
  how: [
    `Send, then paste the copied handoff into a chat in ${name}.`,
    'That chat stays connected: your next messages here go to it without pasting again.',
    'Keep that chat open while you work.',
  ],
  can: [
    `Whatever ${name}’s agent can do, with your architecture map as context.`,
    'Its replies come back to this conversation.',
    `Anything it needs permission for is asked in ${name}.`,
  ],
})

export const DESTINATION_GUIDE: Record<string, DestinationGuide> = {
  grok: {
    need: ['Grok Build CLI installed and signed in with grok login. Nothing needs to be open.'],
    how: STARTED('Grok Build CLI'),
    can: ['Ask and Propose: runs in Grok’s read-only sandbox; file-edit requests are refused.', 'Build: full access to files and commands, with its reply returned for review.', FULL_ACCESS],
  },
  muse: {
    need: ['Muse Code CLI installed and signed in. Nothing needs to be open.'],
    how: STARTED('Muse Code CLI'),
    can: ['Ask and Propose: is instructed to read and draw plans without changing project files; Muse’s configured permissions still apply.', 'Build: runs without approval prompts, within Muse’s configured sandbox and project trust settings, then returns its reply for review.'],
  },
  [CHAT_DELIVERY]: {
    need: ['A ChatGPT plan connection or a model service with your own API key, added once in Settings \u2192 Agents. Nothing else to install or open.'],
    how: [
      'Connect ChatGPT or add an API-key model service in Settings → Agents.',
      'Choose Ambio chat and send. The reply streams in here.',
      'A conversation keeps the model it started with; start a new conversation to use another.',
    ],
    can: [
      'Ask: explains your code and map without changing anything.',
      'Propose: draws the change on your map for you to approve.',
      'Build: changes your code, asking you before each action, and hands the result back for review.',
    ],
  },
  'claude-code': {
    need: ['Claude Code installed on this computer and signed in. Nothing needs to be open.'],
    how: STARTED('Claude Code'),
    can: [
      'Ask and Propose: reads your code and map and can run commands, with its file-editing tools switched off.',
      'Build: edits files and runs commands, then hands the result back for review.',
      'You choose how much it may do without asking: Ask me, Allow edits, Auto (Claude’s own safety check) or Full access. Its questions appear in the conversation; no answer within about two minutes is a no.',
      'While it works you can send it more: your message joins the turn under way.',
      'It uses the MCP servers you set up in Claude Code as well as Ambio’s.',
    ],
  },
  codex: {
    need: ['Codex installed on this computer and signed in. Nothing needs to be open.'],
    how: [...STARTED('Codex'), 'Send corrections while it works. Send /review to have Codex review your current changes and report its findings here.'],
    can: [
      'Ask and Propose: can read and run anything to answer, and is told not to change files.',
      'Build: full access with no sandbox. It edits files and runs any command without asking, then hands the result back for review.',
      'You choose how much it may do without asking. At Ask me, Build uses a project sandbox and asks here for extra access; Ask and Propose keep their platform-specific restrictions.',
    ],
  },
  'copilot-cli': {
    need: ['GitHub Copilot CLI installed on this computer and signed in to GitHub. Nothing needs to be open.'],
    how: STARTED('Copilot CLI'),
    can: [
      'Ask and Propose: can use every tool except writing files.',
      'Build: full access to tools, files and the web without asking, then hands the result back for review.',
      FULL_ACCESS,
    ],
  },
  'antigravity-cli': {
    need: ['Antigravity installed and signed in. Version 1.5 or newer enables the interactive connection for its offered models.', 'Ambio added to Antigravity once, from Settings \u2192 Agents. That is what lets its CLI use Ambio\u2019s tools.'],
    how: STARTED('Antigravity CLI'),
    can: [
      'Models offered by the interactive connection use it automatically in a new conversation. It supports thinking controls, approval requests, corrections while working, and tool details. Your Antigravity permission settings still apply.',
      'Other models and existing CLI conversations keep full access without permission prompts. Ask and Propose tell the agent not to change files; that instruction is not a sandbox.',
      'A conversation keeps its connection. To move from the interactive connection to another model, start a new conversation.',
    ],
  },
  'cursor-cli': {
    need: ['Cursor\u2019s CLI installed on this computer and signed in.', 'Ambio added to Cursor once, from Settings \u2192 Agents.'],
    how: STARTED('Cursor CLI'),
    can: [
      'Ask and Propose: works in Cursor\u2019s read-only modes.',
      'Build: edits files and runs commands without asking, then hands the result back for review.',
      FULL_ACCESS,
    ],
  },
  'devin-cli': {
    need: ['Devin CLI installed on this computer and signed in. Nothing needs to be open.'],
    how: STARTED('Devin CLI'),
    can: [
      'Ask and Propose: can run commands; any change to your files is refused.',
      'Build: everything it asks to do is approved without asking you, and the result comes back for review.',
      FULL_ACCESS,
    ],
  },
  copilot: {
    need: ['VS Code with GitHub Copilot, and Ambio added to it once, from Settings \u2192 Agents.', 'VS Code open while you work.'],
    how: [
      'Send. VS Code opens with your message already in Copilot Chat; press send there.',
      'The first time, VS Code asks whether to open Ambio’s link. Allow it.',
      'That chat stays connected: your next messages here go straight to it.',
    ],
    can: [
      'Everything Copilot Chat can do in VS Code, with your architecture map as context.',
      'Its replies come back to this conversation.',
      'Anything it needs permission for is asked in VS Code.',
    ],
  },
  cursor: {
    need: ['Ambio added to Cursor once, from Settings \u2192 Agents.', 'Cursor open while you work.'],
    how: [
      'Send. Cursor opens with your message already in its chat; press send there.',
      'That chat stays connected: your next messages here go straight to it.',
    ],
    can: [
      'Everything Cursor’s agent can do, with your architecture map as context.',
      'Its replies come back to this conversation.',
      'Anything it needs permission for is asked in Cursor.',
    ],
  },
  'claude-desktop': PASTED('Claude Desktop'),
  windsurf: PASTED('Windsurf'),
  antigravity: PASTED('Antigravity'),
  jetbrains: PASTED('your JetBrains IDE'),
  zed: PASTED('Zed'),
  [WATCHING_DELIVERY]: {
    need: ['An agent chat that has Ambio, open and told to watch Ambio.'],
    how: [
      'In any agent chat that has Ambio, say “watch Ambio”.',
      'Choose Session watching Ambio here and send. Your message lands in that chat.',
      'It answers there, and the reply shows here too.',
    ],
    can: [
      'Keeps everything already said in that chat.',
      'Whatever that agent can do; permissions are asked in its own app.',
    ],
  },
  [MANUAL_DELIVERY]: {
    need: ['Any agent chat that has Ambio.'],
    how: [
      'Send saves your message to this conversation.',
      'Press Copy handoff on it and paste that into any agent chat that has Ambio.',
      'The reply comes back here.',
    ],
    can: ['Works with any agent that has Ambio installed, including ones not listed here.'],
  },
}

export type ReadinessTone = 'ready' | 'attention' | 'blocked' | 'neutral'
export interface DeliveryReadinessResult { tone: ReadinessTone; text: string; fix?: 'agents' }

/**
 * Whether the chosen agent can take a message right now, in that agent's own
 * terms: a model service for Ambio chat, the CLI for one Ambio starts, Ambio
 * added and a chat attached for one in another app. Connection details belong
 * to Settings, not here.
 */
/**
 * Agents Ambio runs whose CLI has no way to be handed Ambio's MCP server for a
 * run: they read it from their app's own settings, so they only have Ambio's
 * tools once Ambio has been added to that app. Without it the agent starts
 * blind (an Antigravity mapping run, 2026-10-20, then went around Ambio and
 * edited its database directly). Claude Code, Codex and Copilot CLI get the
 * server on their command line and need nothing installed.
 */
export const RUN_NEEDS_INSTALL: Record<string, { installer: string; app: string; alsoChanges?: string }> = {
  'antigravity-cli': { installer: 'antigravity', app: 'Antigravity', alsoChanges: 'and allows only Ambio\u2019s tools (mcp(ambio/*)) in Antigravity CLI\u2019s settings' },
  'cursor-cli': { installer: 'cursor', app: 'Cursor' },
}

export function deliveryReadiness({ hostId, hosts, installedIds, watchers, watchingHosts, chat }: {
  hostId: string; hosts: DeliveryHost[]; installedIds: string[]; watchers: number; watchingHosts: string[]
  chat?: { service: string; keyMissing: boolean; auth?: 'chatgpt' }
}): DeliveryReadinessResult {
  if (chat) return chat.keyMissing
    ? { tone: 'blocked', text: chat.auth === 'chatgpt' ? 'Reconnect ChatGPT and approve plan usage in Settings → Agents.' : `The API key for ${chat.service} is missing. Add it again in Settings \u2192 Agents.`, fix: 'agents' }
    : { tone: 'ready', text: `Runs inside Ambio with ${chat.service}. Nothing else needs to be open.` }
  if (hostId === WATCHING_DELIVERY) return watchers > 0
    ? { tone: 'ready', text: `${watchers === 1 ? 'A chat is' : `${watchers} chats are`} watching Ambio and will get your message.` }
    : { tone: 'attention', text: 'No chat is watching Ambio right now. In your agent chat, say \u201cwatch Ambio\u201d.' }
  const host = hosts.find(item => item.id === hostId)
  if (!host) return { tone: 'neutral', text: 'Send saves your message. Copy its handoff into any agent chat that has Ambio.' }
  const needs = RUN_NEEDS_INSTALL[host.id]
  if (host.route === 'run' && host.available && needs && !installedIds.includes(needs.installer)) {
    return { tone: 'blocked', text: `${host.label} can only use Ambio\u2019s tools once Ambio is added to ${needs.app}. Add it in Settings \u2192 Agents, then send.`, fix: 'agents' }
  }
  if (host.route === 'run') return host.available
    ? { tone: 'ready', text: `Ambio starts ${host.label} in this project when you send. Nothing else needs to be open.` }
    : { tone: 'blocked', text: `${host.label} was not found on this computer.`, fix: 'agents' }
  if (watchingHosts.includes(host.id)) return { tone: 'ready', text: `Your ${host.label} chat is attached. Messages go straight to it.` }
  if (!installedIds.includes(host.id)) return { tone: 'blocked', text: `Ambio has not been added to ${host.label} yet.`, fix: 'agents' }
  return { tone: 'attention', text: host.route === 'open'
    ? `Send opens ${host.label} with your message. That chat then stays attached.`
    : `Send copies a handoff to paste into ${host.label}. That chat then stays attached.` }
}
