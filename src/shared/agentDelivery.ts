export type DeliveryRoute = 'run' | 'open' | 'copy'

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
  kind: 'text' | 'tool' | 'error'
  text: string
}

export interface DeliveryRequest {
  workspaceId: string
  messageId: string
  hostId: string
}

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
  how: string[]
  can: string[]
}

const STARTED = (name: string, extra = 'It remembers the conversation from one message to the next.'): string[] => [
  `Choose ${name} and send. Ambio starts it in this project for you; nothing else needs to be open.`,
  'You can watch what it is doing under your message, and its reply arrives in the conversation.',
  `Keep replying in the same conversation. ${extra}`,
]

const PASTED = (name: string): DestinationGuide => ({
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
  [CHAT_DELIVERY]: {
    how: [
      'Add a model service once, with your own API key, in Settings → Model services.',
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
    how: STARTED('Claude Code'),
    can: [
      'Ask and Propose: reads your code and map, never changes files.',
      'Build: changes your code and hands the result back for review.',
      'If it wants to run a command you did not expect, it asks you here first.',
    ],
  },
  codex: {
    how: STARTED('Codex'),
    can: [
      'Ask and Propose: reads your code and map, never changes files.',
      'Build: changes files inside this project only, and hands the result back for review.',
      'It runs commands without asking, but cannot reach outside this project.',
    ],
  },
  'copilot-cli': {
    how: STARTED('Copilot CLI'),
    can: [
      'Ask and Propose: reads your code and map, never changes files.',
      'Build: changes your code and hands the result back for review.',
      'Before it runs a command, it asks you here.',
    ],
  },
  'antigravity-cli': {
    how: STARTED('Antigravity CLI', 'Ambio passes along what was said earlier.'),
    can: [
      'Ask and Propose: answers questions and draws plans on your map.',
      'Build: can change files, but cannot run commands such as tests or installs. Choose another agent for builds that need them.',
    ],
  },
  'cursor-cli': {
    how: STARTED('Cursor CLI'),
    can: [
      'Ask and Propose: reads your code and map, never changes files.',
      'Build: changes your code and hands the result back for review.',
    ],
  },
  'devin-cli': {
    how: STARTED('Windsurf CLI'),
    can: [
      'Ask and Propose: reads your code and map, never changes files.',
      'Build: changes your code and hands the result back for review.',
      'Before it runs a command, it asks you here.',
    ],
  },
  'antigravity-acp': {
    how: STARTED('Antigravity'),
    can: [
      'Ask and Propose: reads your code and map, never changes files.',
      'Build: changes your code and hands the result back for review.',
      'Before it runs a command, it asks you here.',
    ],
  },
  copilot: {
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
    how: [
      'Send saves your message to this conversation.',
      'Press Copy handoff on it and paste that into any agent chat that has Ambio.',
      'The reply comes back here.',
    ],
    can: ['Works with any agent that has Ambio installed, including ones not listed here.'],
  },
}

