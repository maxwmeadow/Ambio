export type DeliveryRoute = 'run' | 'open' | 'copy'

/** Launch capability is static; discovery only decides whether it is installed. */
export const DRIVEN_CLI_NAMES: Record<string, string[]> = {
  'claude-code': ['claude'],
  codex: ['codex'],
  grok: ['grok'],
  muse: ['muse'],
  'copilot-cli': ['copilot'],
  'cursor-cli': ['cursor-agent'],
  'devin-cli': ['devin'],
  'antigravity-acp': ['agy_acp_server', 'agy_acp_server.par'],
  'antigravity-cli': ['agy'],
}

export const canStartAgent = (hostId: string): boolean => Object.hasOwn(DRIVEN_CLI_NAMES, hostId)

export interface DeliveryHost {
  id: string
  label: string
  route: DeliveryRoute
  available: boolean
  detail: string
}

export interface DeliveryRun {
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
  /** The conversation and the kind of turn this run answers. */
  threadId?: string
  mode?: 'ask' | 'propose' | 'build'
  /** The host's own session, kept so the conversation's next turn can continue it. */
  sessionId?: string
  /** This run continued the session an earlier turn left behind. */
  resumed?: boolean
}

/** One thing a running agent said or did, as the host reported it. */
export interface DeliveryEvent {
  at: number
  /** thinking: the agent's own summary of its reasoning, where the host reports one. */
  kind: 'text' | 'tool' | 'error' | 'thinking'
  text: string
}

export interface DeliveryRequest {
  workspaceId: string
  messageId: string
  hostId: string
  /** The model to run the agent with; unset uses the agent's own default. */
  model?: string
  /** Where an agent Ambio starts works: the project's own checkout (the
   *  default), or a new worktree of its own on an ambio/ branch, so several
   *  can work at once (docs/GIT_AND_PROJECT_SHAPES.md stage 4). A follow-up
   *  turn keeps the worktree its conversation started in. */
  where?: 'here' | 'worktree'
}

/** A model an agent can be asked to use. */
export interface ModelOption { id: string; label: string }

export interface DeliveryResult {
  detail: string
  run?: DeliveryRun
}

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
    can: ['Ask and Propose: is instructed to read and draw plans without changing project files; this is a prompt constraint.', 'Build: full access to files and commands, with its reply returned for review.', FULL_ACCESS],
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
      'Build: full access. It edits files and runs any command without asking, then hands the result back for review.',
      FULL_ACCESS,
    ],
  },
  codex: {
    need: ['Codex installed on this computer and signed in. Nothing needs to be open.'],
    how: STARTED('Codex'),
    can: [
      'Ask and Propose: can read and run anything to answer, and is told not to change files.',
      'Build: full access with no sandbox. It edits files and runs any command without asking, then hands the result back for review.',
      FULL_ACCESS,
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
    need: ['Antigravity installed and signed in.', 'Ambio added to Antigravity once, from Settings \u2192 Agents. That is what lets its CLI use Ambio\u2019s tools.'],
    how: STARTED('Antigravity CLI'),
    can: [
      'Ask and Propose: answers questions and draws plans on your map. It is told not to change files, but Antigravity has no setting that stops it.',
      'Build: full access. It edits files and runs any command without asking, then hands the result back for review.',
      FULL_ACCESS,
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
  'antigravity-acp': {
    need: ['Antigravity installed on this computer and signed in. Nothing needs to be open.'],
    how: STARTED('the Antigravity agent'),
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
