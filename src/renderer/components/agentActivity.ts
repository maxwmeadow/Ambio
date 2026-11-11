/**
 * How an agent's activity row reads, the same for every agent and every place
 * that shows one (a conversation's turn, setup's mapping log). Agents name
 * their tools differently (Claude Code's `Bash`, Codex's `Shell`, an ACP
 * agent's own titles), and drivers label a row `Tool · target`, with
 * `Ambio · tool · target` for Ambio's own tools and a `Subagent · …` prefix for
 * work a subagent did (Codex adds the subagent's name after it).
 */

export type ActivityBadge = 'Ambio' | 'Read' | 'List' | 'Search' | 'Run' | 'Edit' | 'Web' | 'Agent' | 'Tool'

export interface ToolRow {
  badge: ActivityBadge
  /** The tool as the agent named it. */
  tool: string
  /** What it acted on, with the project's own paths shortened. */
  target: string
  /** The subagent that did it: its name, or '' when the agent gave none. */
  subagent?: string
}

/** Each agent's tool names, by what the tool does. */
const BADGES: Array<[ActivityBadge, RegExp]> = [
  ['Run', /^(bash|powershell|shell|run|exec|execute|terminal|command|cmd|killshell|bashoutput)\b/i],
  ['Edit', /^(edit|multiedit|write|notebookedit|apply_patch|patch|create|delete|move)\b/i],
  // Antigravity titles a file it reads "File <path>".
  ['Read', /^(read|view|notebookread|open|cat|file)\b/i],
  ['Search', /^(grep|glob|search|find|websearch|toolsearch)\b/i],
  ['List', /^(ls|list|dir)\b/i],
  ['Web', /^(webfetch|fetch|browse)\b/i],
  // Claude Code's Task/Agent; Codex's collaboration tools (spawn_agent, send_input, wait…).
  ['Agent', /^(task|[a-z_]*agent|send_input|wait)\b/i],
]

function badgeFor(tool: string): ActivityBadge {
  for (const [badge, pattern] of BADGES) if (pattern.test(tool.trim())) return badge
  // ACP agents title a call in words ("Reading src/app.ts", "Run tests").
  const lower = tool.toLowerCase()
  if (/\b(read|view)/.test(lower)) return 'Read'
  if (/\b(search|grep|find)/.test(lower)) return 'Search'
  if (/\b(list|director)/.test(lower)) return 'List'
  if (/\b(run|command|shell|exec)\b/.test(lower)) return 'Run'
  if (/\b(edit|writ|patch)/.test(lower)) return 'Edit'
  return 'Tool'
}

const KNOWN_TOOL = (part: string) => BADGES.some(([, pattern]) => pattern.test(part.trim()))

/** Whether a tool's own name only says its kind (Bash, Shell, Read, Grep…), so its target says the rest. */
export function isGenericTool(tool: string): boolean {
  return /^\S+$/.test(tool.trim()) && KNOWN_TOOL(tool)
}

/** The word a step leads with, by what its tool does. */
export const STEP_VERBS: Record<ActivityBadge, string> = {
  Ambio: 'Ambio', Read: 'Read', List: 'List', Search: 'Search', Run: 'Run', Edit: 'Edit', Web: 'Fetch', Agent: 'Agent', Tool: 'Tool',
}

/**
 * What an Ambio call was about, from its arguments, when its row names no
 * target: `{"op":"overview"}` reads "overview".
 */
export function inputSummary(input: string | undefined): string {
  if (!input) return ''
  let value: unknown
  try { value = JSON.parse(input) } catch { return '' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  const leading = ['op', 'scope', 'action', 'kind', 'name', 'query', 'path', 'target', 'sheet', 'title']
  const said = [...leading.filter(key => key in record), ...Object.keys(record).filter(key => !leading.includes(key))]
    .map(key => record[key]).filter((item): item is string | number => (typeof item === 'string' && !!item.trim() && item.length <= 80) || typeof item === 'number')
  return said.slice(0, 2).map(String).join(', ')
}

/**
 * A path inside the project as it is written in the project (`src/app.ts`),
 * whichever slashes the agent used; anything else is left as it is.
 */
export function projectPath(text: string, rootPath?: string): string {
  if (!rootPath) return text
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return text
  const escaped = root.replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/\//g, '[\\\\/]')
  // Windows paths compare without case; a POSIX root keeps it.
  return text.replace(new RegExp(`${escaped}[\\\\/]([^\\s'"\`]*)`, /^[a-z]:/i.test(root) ? 'gi' : 'g'), (_match, rest: string) => rest.replace(/\\/g, '/') || '.')
}

/**
 * An MCP tool as agents name it outside Ambio's own label: Antigravity's
 * `mcp_ambio_get_inbox` (titled `Run mcp_ambio_get_inbox`), Claude Code's
 * `mcp__ambio__get_inbox`. The server and the tool.
 */
const MCP_NAME = /^(?:run\s+)?mcp__?([a-z0-9-]+?)__?([a-z0-9_]+)$/i

/** A tool's own name as words: `get_architecture` reads "Get architecture". */
export function toolWords(tool: string): string {
  if (!/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(tool)) return tool
  const words = tool.replace(/_/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A tool row's parts: badge, tool name, target and the subagent, if any. */
export function toolRow(text: string, rootPath?: string): ToolRow {
  let parts = projectPath(text, rootPath).split(' · ')
  let subagent: string | undefined
  if (parts[0] === 'Subagent' && parts.length > 1) {
    parts = parts.slice(1)
    // Codex names the subagent before the tool ("nickname · role", so up to
    // the first part that is a tool); Claude Code does not.
    const tool = parts.findIndex(part => KNOWN_TOOL(part) || part === 'Ambio')
    const named = tool >= 0 ? tool : parts.length > 1 ? 1 : 0
    subagent = parts.slice(0, named).join(', ')
    parts = parts.slice(named)
  }
  if (parts[0] === 'Ambio' && parts.length > 1) return { badge: 'Ambio', tool: parts[1], target: parts.slice(2).join(' · '), ...(subagent !== undefined ? { subagent } : {}) }
  const mcp = MCP_NAME.exec((parts[0] ?? '').trim())
  if (mcp) return { badge: mcp[1].toLowerCase() === 'ambio' ? 'Ambio' : 'Tool', tool: mcp[1].toLowerCase() === 'ambio' ? mcp[2] : `${mcp[1]} ${mcp[2]}`, target: parts.slice(1).join(' · '), ...(subagent !== undefined ? { subagent } : {}) }
  // "File <path>" is the path itself, read.
  if (/^file\s+\S/i.test(parts[0] ?? '')) return { badge: 'Read', tool: (parts[0] ?? '').replace(/^file\s+/i, ''), target: parts.slice(1).join(' · '), ...(subagent !== undefined ? { subagent } : {}) }
  const tool = parts[0] ?? ''
  return { badge: badgeFor(tool), tool, target: parts.slice(1).join(' · '), ...(subagent !== undefined ? { subagent } : {}) }
}

/** A tool call's status in words, whichever agent's vocabulary it came in (Codex, ACP, Claude). */
export function statusLabel(status: string): string {
  return ({ inProgress: 'running', in_progress: 'running', pending: 'waiting', completed: 'done', failed: 'failed', declined: 'declined' } as Record<string, string>)[status] ?? status
}

const plural = (count: number, one: string, many: string) => count === 1 ? one : many.replace('#', String(count))

/** A run of steps in a few words, the way a person would sum it up: "Thought, ran 3 commands and read 2 files". */
export function stepsSummary(items: Array<{ kind: string; text: string; status?: string }>): string {
  const counts = new Map<string, number>()
  let thought = false
  for (const item of items) {
    if (item.kind === 'thinking') { thought = true; continue }
    const badge = toolRow(item.text).badge
    counts.set(badge, (counts.get(badge) ?? 0) + 1)
  }
  const parts = [
    thought ? 'thought' : '',
    ...[...counts].map(([badge, count]) => ({
      Run: plural(count, 'ran a command', 'ran # commands'),
      Read: plural(count, 'read a file', 'read # files'),
      Edit: plural(count, 'edited a file', 'edited # files'),
      Search: plural(count, 'searched once', 'searched # times'),
      List: plural(count, 'listed a folder', 'listed # folders'),
      Web: plural(count, 'fetched a page', 'fetched # pages'),
      Agent: plural(count, 'used a subagent', 'used # subagents'),
      Ambio: plural(count, 'used Ambio', 'used Ambio # times'),
      Tool: plural(count, 'used a tool', 'used # tools'),
    } as Record<string, string>)[badge] ?? ''),
  ].filter(Boolean)
    // "used a tool and a subagent", not "used a tool and used a subagent".
    .map((part, index, all) => index > 0 && part.startsWith('used ') && all[index - 1].startsWith('used ') ? part.slice(5) : part)
  const failed = items.filter(item => item.status && /fail|declin|error/i.test(item.status)).length
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? 'Worked'
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}${failed ? `, ${plural(failed, 'one failed', '# failed')}` : ''}`
}

/** Formats a tool activity label without displaying its stored field separator. */
export function toolActivityLabel(text: string): string {
  return text.replaceAll(' \u00b7 ', ', ')
}
