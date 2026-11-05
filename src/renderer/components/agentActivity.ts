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
  ['Read', /^(read|view|notebookread|open|cat)\b/i],
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
    subagent = parts.slice(0, named).join(' · ')
    parts = parts.slice(named)
  }
  if (parts[0] === 'Ambio' && parts.length > 1) return { badge: 'Ambio', tool: parts[1], target: parts.slice(2).join(' · '), ...(subagent !== undefined ? { subagent } : {}) }
  const tool = parts[0] ?? ''
  return { badge: badgeFor(tool), tool, target: parts.slice(1).join(' · '), ...(subagent !== undefined ? { subagent } : {}) }
}

/** A tool call's status in words, whichever agent's vocabulary it came in (Codex, ACP, Claude). */
export function statusLabel(status: string): string {
  return ({ inProgress: 'running', in_progress: 'running', pending: 'waiting', completed: 'done', failed: 'failed', declined: 'declined' } as Record<string, string>)[status] ?? status
}
