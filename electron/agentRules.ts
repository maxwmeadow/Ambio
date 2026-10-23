import fs from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { DRAW_FIRST_WORKFLOW } from '../src/shared/agentWorkflow.ts'

export interface AgentRuleFile { path: string; prefix: string; shared: boolean }
const END = '<!-- /ambio:draw-first -->'
const START = /<!-- ambio:draw-first:v1 sha256=([a-f0-9]{64}) -->\r?\n([\s\S]*?)<!-- \/ambio:draw-first -->/g
const hash = (text: string) => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')
const candidates = ['AGENTS.md', 'CLAUDE.md', '.agents/AGENTS.md', '.claude/CLAUDE.md']
const sharedAgentHosts = ['codex', 'grok', 'copilot-cli', 'muse']
function ruleBlock(_file: AgentRuleFile): string {
  const payload = DRAW_FIRST_WORKFLOW + '\n'
  return `<!-- ambio:draw-first:v1 sha256=${hash(payload)} -->\n${payload}${END}`
}

// Kept outside the shared workflow checksum. Only Muse setup creates this
// instruction; other clients neither follow it nor depend on CLAUDE.md.
const MUSE_START = '<!-- ambio:muse-context:'
const MUSE_END = '<!-- /ambio:muse-context -->'
const MUSE_CONTEXT = /<!-- ambio:muse-context:v1 sha256=([a-f0-9]{64}) -->\r?\n([\s\S]*?)<!-- \/ambio:muse-context -->/g
function museContextBlock(source: string) {
  const matches = [...source.matchAll(MUSE_CONTEXT)]
  return matches.length === 1 && source.split(MUSE_START).length === 2 && source.split(MUSE_END).length === 2 && hash(matches[0][2]) === matches[0][1] ? matches[0] : null
}

export function installMuseContext(projectRoot?: string): void {
  if (!projectRoot) return
  const agents = join(projectRoot, 'AGENTS.md')
  const source = fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : ''
  if (source.includes(MUSE_START)) {
    if (!museContextBlock(source)) throw new Error(`Ambio's Muse context in ${agents} was edited. Keep your edits and repair it manually.`)
    return // Choose once, never during inspection.
  }
  const include = !authoredText(agents) ? candidates.slice(1).find(candidate => authoredText(join(projectRoot, candidate))) : undefined
  const pointer = include ? `For Muse Code only: Read and follow the project's existing instructions in ${include} before working.\n` : ''
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.writeFileSync(agents, source + (source && !source.endsWith('\n') ? '\n' : '') + `<!-- ambio:muse-context:v1 sha256=${hash(pointer)} -->\n` + pointer + MUSE_END + '\n', 'utf8')
}

export function removeMuseContext(projectRoot?: string): void {
  if (!projectRoot) return
  const agents = join(projectRoot, 'AGENTS.md')
  if (!fs.existsSync(agents)) return
  const source = fs.readFileSync(agents, 'utf8')
  const block = museContextBlock(source)
  if (!block) return // Authored changes are theirs to keep.
  const remaining = source.slice(0, block.index) + source.slice(block.index! + block[0].length)
  if (!remaining.trim()) fs.rmSync(agents)
  else fs.writeFileSync(agents, remaining, 'utf8')
}

function authoredText(path: string): string {
  if (!fs.existsSync(path)) return ''
  try {
    const source = fs.readFileSync(path, 'utf8')
    const managed = managedBlock(source)
    return (managed ? source.slice(0, managed.index) + source.slice(managed.index! + managed[0].length) : source).replace(MUSE_CONTEXT, '').trim()
  } catch { return 'unreadable' } // Never treat inaccessible instructions as empty.
}

/** Project-scoped rules; no global changes to unrelated coding sessions. */
export function agentRuleFiles(hostId: string, projectRoot?: string): AgentRuleFile[] {
  if (!projectRoot) return []
  const file = (path: string, prefix = '', shared = false): AgentRuleFile[] => [{ path: join(projectRoot, path), prefix, shared }]
  switch (hostId) {
    case 'claude-code': return file('.claude/rules/ambio-draw-first.md')
    case 'codex':
    case 'grok':
    case 'copilot-cli': return file('AGENTS.md', '', true)
    // Muse's durable, scoped context pointer preserves its lower-priority file.
    case 'muse': return file('AGENTS.md', '', true)
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
    const managed = managedBlock(source)
    // Accept the previous release's checksum-valid optional pointer too. Its
    // presence is unrelated to whether CLAUDE.md happens to exist today.
    const payload = managed?.[2] ?? ''
    const legacy = /^Read and follow the project's existing instructions in (?:CLAUDE\.md|\.agents\/AGENTS\.md|\.claude\/CLAUDE\.md) before working\. Ambio's setup created this file; it does not replace those instructions\.\n\n/.test(payload)
    return !!managed && (payload === DRAW_FIRST_WORKFLOW + '\n' || (legacy && payload.slice(payload.indexOf('\n\n') + 2) === DRAW_FIRST_WORKFLOW + '\n')) && source.startsWith(file.prefix)
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
