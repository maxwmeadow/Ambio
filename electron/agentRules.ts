import fs from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { DRAW_FIRST_WORKFLOW } from '../src/shared/agentWorkflow.ts'

export interface AgentRuleFile { path: string; prefix: string; shared: boolean; include?: string }
const END = '<!-- /ambio:draw-first -->'
const START = /<!-- ambio:draw-first:v1 sha256=([a-f0-9]{64}) -->\r?\n([\s\S]*?)<!-- \/ambio:draw-first -->/g
const hash = (text: string) => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')
const candidates = ['AGENTS.md', 'CLAUDE.md', '.agents/AGENTS.md', '.claude/CLAUDE.md']
const sharedAgentHosts = ['codex', 'grok', 'copilot-cli', 'muse']
function ruleBlock(file: AgentRuleFile): string {
  const payload = (file.include ? `Read and follow the project's existing instructions in ${file.include} before working. Ambio's setup created this file; it does not replace those instructions.\n\n` : '') + DRAW_FIRST_WORKFLOW + '\n'
  return `<!-- ambio:draw-first:v1 sha256=${hash(payload)} -->\n${payload}${END}`
}

function authoredText(path: string): string {
  if (!fs.existsSync(path)) return ''
  try {
    const source = fs.readFileSync(path, 'utf8')
    const managed = managedBlock(source)
    return (managed ? source.slice(0, managed.index) + source.slice(managed.index! + managed[0].length) : source).trim()
  } catch { return 'unreadable' } // Never treat inaccessible instructions as empty.
}

/** Project-scoped rules; no global changes to unrelated coding sessions. */
export function agentRuleFiles(hostId: string, projectRoot?: string): AgentRuleFile[] {
  if (!projectRoot) return []
  const file = (path: string, prefix = '', shared = false): AgentRuleFile[] => {
    // A generated AGENTS.md takes precedence over Muse's existing instructions.
    // Refer to the original file rather than copying authored text that can go stale.
    const include = path === 'AGENTS.md' && !authoredText(join(projectRoot, path))
      ? candidates.slice(1).find(candidate => authoredText(join(projectRoot, candidate))) : undefined
    return [{ path: join(projectRoot, path), prefix, shared, ...(include ? { include } : {}) }]
  }
  switch (hostId) {
    case 'claude-code': return file('.claude/rules/ambio-draw-first.md')
    case 'codex':
    case 'grok':
    case 'copilot-cli': return file('AGENTS.md', '', true)
    // Muse loads only the first instruction file at each directory level.
    // Append to its existing choice instead of shadowing authored guidance.
    case 'muse': return file(candidates
      .find(path => fs.existsSync(join(projectRoot, path))) ?? 'AGENTS.md', '', true)
    case 'copilot': return file('.github/copilot-instructions.md', '', true)
    case 'cursor': return file('.cursor/rules/ambio-draw-first.mdc', '---\nalwaysApply: true\n---\n\n')
    case 'windsurf': return [
      ...file('.windsurf/rules/ambio-draw-first.md', '---\ntrigger: always_on\n---\n\n'),
      ...file('.devin/rules/ambio-draw-first.md', '---\ntrigger: always_on\n---\n\n'),
    ]
    case 'antigravity': return file('.agents/rules/ambio-draw-first.md', '---\ntrigger: always_on\n---\n\n')
    case 'jetbrains': return file('.aiassistant/rules/ambio-draw-first.md', '---\ntype: always\n---\n\n')
    case 'zed': return file('.rules', '', true)
    default: return [] // Claude Desktop receives the same contract over MCP.
  }
}

/** Earlier installs may have written a different file before precedence changed. */
export function agentRuleCleanupFiles(hostId: string, projectRoot?: string): AgentRuleFile[] {
  return projectRoot && sharedAgentHosts.includes(hostId)
    ? candidates.map(path => ({ path: join(projectRoot, path), prefix: '', shared: true }))
    : agentRuleFiles(hostId, projectRoot)
}

function managedBlock(source: string) {
  const matches = [...source.matchAll(START)]
  if (matches.length !== 1 || source.split('<!-- ambio:draw-first:').length !== 2 || source.split(END).length !== 2 || hash(matches[0][2]) !== matches[0][1]) return null
  return matches[0]
}

export function ruleInstalled(file: AgentRuleFile): boolean {
  try {
    const source = fs.readFileSync(file.path, 'utf8').replaceAll('\r\n', '\n')
    return !!managedBlock(source) && source.includes(ruleBlock(file)) && source.startsWith(file.prefix)
  } catch { return false }
}

/** Keep authored text verbatim, and refuse to overwrite an edited managed block. */
export function installAgentRule(file: AgentRuleFile): void {
  const block = ruleBlock(file)
  const source = fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : ''
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const managed = managedBlock(source)
  let next: string
  if (source.includes('<!-- ambio:draw-first:') || source.includes(END)) {
    if (!managed || !source.replaceAll('\r\n', '\n').startsWith(file.prefix)) throw new Error(`Ambio's rule in ${file.path} was edited or is incomplete. Keep your edits and repair it manually.`)
    next = source.slice(0, managed.index) + block.replaceAll('\n', newline) + source.slice(managed.index! + managed[0].length)
  } else {
    if (!file.shared && source.trim()) throw new Error(`${file.path} already contains an authored rule. Ambio left it unchanged.`)
    next = source + (source ? (source.endsWith('\n') ? newline : newline + newline) : file.prefix) + block.replaceAll('\n', newline) + newline
  }
  fs.mkdirSync(dirname(file.path), { recursive: true })
  fs.writeFileSync(file.path, next, 'utf8')
}

export function removeAgentRule(file: AgentRuleFile): boolean {
  if (!fs.existsSync(file.path)) return false
  const source = fs.readFileSync(file.path, 'utf8')
  const managed = managedBlock(source)
  if (!managed) return false // User edits are theirs to keep.
  const remaining = source.slice(0, managed.index) + source.slice(managed.index! + managed[0].length)
  if (remaining.replaceAll('\r\n', '\n').trim() === file.prefix.trim()) fs.rmSync(file.path)
  else fs.writeFileSync(file.path, remaining, 'utf8')
  return true
}
