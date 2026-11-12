/**
 * Slash commands in the message box. Ambio's own act at once (switch the turn's
 * mode, start a conversation, attach context). The chosen agent's own (Claude
 * Code commands and skills, Codex skills, an ACP agent's advertised commands,
 * found by electron/agentCommands.ts) go with the message: the agent runs the
 * command first, then takes Ambio's request in the same session.
 */

export interface AgentCommand {
  name: string
  description: string
  /** A Codex skill's SKILL.md, sent with the turn so Codex loads it. */
  path?: string
}

/** A command a message starts with, and what follows it on that line. */
export interface CommandCall { name: string; args: string; path?: string }

/** Ambio's own commands; each acts in the message box and is never sent. */
export const AMBIO_COMMANDS = [
  { name: 'ask', description: 'Ask a question; the agent changes nothing' },
  { name: 'propose', description: 'Ask for a plan on a sheet to review' },
  { name: 'build', description: 'Ask for a change to the code' },
  { name: 'new', description: 'Start a new conversation' },
  { name: 'attach', description: 'Attach a sheet, system, file or function' },
] as const satisfies readonly AgentCommand[]

export type AmbioCommandName = typeof AMBIO_COMMANDS[number]['name']

/** The command name being typed at the start of the box ("/pla" gives "pla"), or null when none is. */
export function typedCommand(text: string): string | null {
  const found = /^\/([\w:.-]*)$/.exec(text)
  return found ? found[1] : null
}

/**
 * Commands matching what is typed, by name (starting with it first); by
 * description only when `by` asks, which the menu does when no name matches
 * in any group, so "/pl" finds /plan rather than a command about plans.
 */
export function matchCommands<T extends AgentCommand>(query: string, commands: readonly T[], by: 'name' | 'description' = 'name'): T[] {
  const needle = query.toLowerCase()
  if (by === 'description') return commands.filter(command => command.description.toLowerCase().includes(needle))
  const starts = commands.filter(command => command.name.toLowerCase().startsWith(needle))
  const contains = commands.filter(command => !starts.includes(command) && command.name.toLowerCase().includes(needle))
  return [...starts, ...contains]
}

/** The agent command a message starts with ("/plan the cache" gives plan and "the cache"), if it is one of the agent's. */
export function commandCall(text: string, commands: readonly AgentCommand[]): CommandCall | null {
  const found = /^\/([\w:.-]+)(?:[ \t]+([^\n]*))?/.exec(text.trimStart())
  if (!found) return null
  const command = commands.find(item => item.name === found[1])
  if (!command) return null
  return { name: command.name, args: (found[2] ?? '').trim(), ...(command.path ? { path: command.path } : {}) }
}

/** The line that runs a command in an agent that reads slash commands. */
export const commandLine = (call: CommandCall) => `/${call.name}${call.args ? ` ${call.args}` : ''}`

/** A valid command call from the renderer, or undefined. */
export function validCommandCall(value: unknown): CommandCall | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { name, args, path } = value as Record<string, unknown>
  if (typeof name !== 'string' || !/^[\w:.-]{1,120}$/.test(name)) return undefined
  if (typeof args !== 'string' || args.length > 4000 || args.includes('\n')) return undefined
  if (path !== undefined && (typeof path !== 'string' || path.length > 1024)) return undefined
  return { name, args, ...(typeof path === 'string' ? { path } : {}) }
}
