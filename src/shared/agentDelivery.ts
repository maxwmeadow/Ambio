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
  /** Account registration for a provider whose sessions must remain separate. */
  sessionScope?: string
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
  if (remembered && usable(remembered)) return remembered
  const live = liveIds.find(usable)
  if (live) return live
  return hosts.find(host => host.available && installedIds.includes(host.id))?.id ?? MANUAL_DELIVERY
}

/**
 * What each destination can do in a conversation, said plainly beside the
 * picker. "tested" means a real conversation passed (mcp/e2e/conversation.live.mjs);
 * "limited" means it was tested and has a known gap; "untested" means built
 * from the vendor's documentation and tested against stand-in agents only;
 * "paste" means a chat nothing outside it can start.
 */
export type DeliverySupportLevel = 'tested' | 'limited' | 'untested' | 'paste'

export const DELIVERY_SUPPORT: Record<string, { level: DeliverySupportLevel; summary: string }> = {
  chatgpt: { level: 'untested', summary: 'Experimental. Uses your connected ChatGPT plan through Codex CLI. Ask and Propose run read-only; Build can edit this project. Manage plan limits in Settings → Agents.' },
  'claude-code': { level: 'tested', summary: 'Tested end to end. Continues its session between turns, Ask and Propose cannot change files, and a build asks you before commands it was not given.' },
  'antigravity-cli': { level: 'limited', summary: 'Tested. Answers questions and plans with Ambio\u2019s tools, but a build cannot run shell commands (its print mode refuses them) and it does not keep a session between turns.' },
  codex: { level: 'tested', summary: 'Tested end to end. Continues its session between turns, and Ask and Propose run read-only. It does not ask you before commands; its sandbox limits what a build can touch.' },
  'copilot-cli': { level: 'tested', summary: 'Tested end to end. Runs as an agent session that continues between turns, Ask and Propose cannot change files, and a build asks you before running commands.' },
  'cursor-cli': { level: 'untested', summary: 'Experimental. Continues its chat between turns. Not yet tested on a real install.' },
  'devin-cli': { level: 'untested', summary: 'Experimental. Runs as a session with Ambio\u2019s tools attached. Not yet tested on a real install.' },
  'antigravity-acp': { level: 'untested', summary: 'Experimental. Google\u2019s agent server for Antigravity. Not yet tested on a real install.' },
  copilot: { level: 'tested', summary: 'Tested. Opens VS Code\u2019s chat with the request filled in for you to send; the first time, VS Code asks to allow the link. That chat then stays attached for the rest of the conversation.' },
  cursor: { level: 'paste', summary: 'Opens Cursor\u2019s chat with the request filled in; press send. That chat stays attached for the rest of the conversation.' },
  'claude-desktop': { level: 'paste', summary: 'Paste the handoff once. That chat stays attached for the rest of the conversation.' },
  windsurf: { level: 'paste', summary: 'Paste the handoff once. That chat stays attached for the rest of the conversation.' },
  antigravity: { level: 'paste', summary: 'Paste the handoff once. That chat stays attached for the rest of the conversation.' },
  jetbrains: { level: 'paste', summary: 'Paste the handoff once. That chat stays attached for the rest of the conversation.' },
  zed: { level: 'paste', summary: 'Paste the handoff once. That chat stays attached for the rest of the conversation.' },
  [WATCHING_DELIVERY]: { level: 'tested', summary: 'Your own chat, already told to watch Ambio. It answers there, with everything already said in it.' },
  [MANUAL_DELIVERY]: { level: 'paste', summary: 'Saves the request. Copy its handoff into any agent chat yourself.' },
}

export const DELIVERY_SUPPORT_LABEL: Record<DeliverySupportLevel, string> = {
  tested: 'Tested',
  limited: 'Works, with limits',
  untested: 'Not yet tested',
  paste: 'Paste once',
}
