import fs from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { AgentCommand } from '../src/shared/agentCommands.ts'
import type { DriverLauncher } from './agentDrivers.ts'
import { AcpClient } from './acpClient.ts'
import { CodexAppServer } from './codexAppServer.ts'

/**
 * The chosen agent's own slash commands, for the message box's / menu
 * (src/shared/agentCommands.ts). Checked against the agents on a real machine
 * (2026-11-11): Claude Code lists them only once it is sent a message, so they
 * are read from where it keeps them; Codex lists its skills over App Server
 * (skills/list); Antigravity sends available_commands_update as soon as a
 * session opens, so an empty session in a scratch folder is opened and closed.
 */

/** A markdown file's frontmatter field, or undefined. */
function frontmatter(text: string, field: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const found = block && new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(block[1])
  return found ? found[1].trim().replace(/^["']|["']$/g, '') : undefined
}

/** The first line of a file's body, as a description when it declares none. */
function firstLine(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/^#+\s*/, '').slice(0, 160) ?? ''
}

function markdownFiles(directory: string, depth = 0): string[] {
  if (depth > 3) return []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return [] }
  return entries.flatMap(entry => entry.isDirectory() ? markdownFiles(join(directory, entry.name), depth + 1)
    : entry.isFile() && entry.name.endsWith('.md') ? [join(directory, entry.name)] : [])
}

/** Claude Code's custom commands and skills, the project's before the user's. */
export function claudeCommands(root: string, home: string): AgentCommand[] {
  const found = new Map<string, AgentCommand>()
  for (const base of [join(root, '.claude'), join(home, '.claude')]) {
    for (const file of markdownFiles(join(base, 'commands'))) {
      // A command in a subfolder is named folder:name.
      const name = relative(join(base, 'commands'), file).replace(/\.md$/, '').split(/[\\/]/).join(':')
      if (found.has(name)) continue
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { continue }
      found.set(name, { name, description: frontmatter(text, 'description') ?? firstLine(text) })
    }
    let skills: fs.Dirent[] = []
    try { skills = fs.readdirSync(join(base, 'skills'), { withFileTypes: true }) } catch { /* none */ }
    for (const entry of skills) {
      if (!entry.isDirectory()) continue
      let text = ''
      try { text = fs.readFileSync(join(base, 'skills', entry.name, 'SKILL.md'), 'utf8') } catch { continue }
      const name = frontmatter(text, 'name') ?? entry.name
      if (!found.has(name)) found.set(name, { name, description: frontmatter(text, 'description') ?? firstLine(text) })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const childEnv = (launcher: DriverLauncher & { bundledNode?: boolean }) => {
  const env = { ...process.env }
  if (launcher.bundledNode) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** Lines from a child's stdout, handed to a protocol client. */
function feed(child: ReturnType<typeof spawn>, receive: (line: string) => void, fail: () => void): void {
  let buffer = ''
  const decoder = new StringDecoder('utf8')
  child.stdout?.on('data', chunk => {
    buffer += decoder.write(chunk)
    if (buffer.length > 1 << 20) { fail(); return }
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
    for (const line of lines) receive(line)
  })
}

/** Codex's skills for this project, with the SKILL.md each is sent with. */
export function codexSkills(launcher: DriverLauncher & { bundledNode?: boolean }, root: string): Promise<AgentCommand[]> {
  return new Promise(resolve => {
    const child = spawn(launcher.command, [...launcher.args, 'app-server'], { cwd: tmpdir(), env: childEnv(launcher), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
    const client = new CodexAppServer({ cwd: tmpdir(), prompt: '', mode: 'ask', send: line => child.stdin?.write(`${line}\n`), onSession: () => {}, onEvent: () => {} })
    let finished = false
    const finish = (commands: AgentCommand[]) => {
      if (finished) return
      finished = true; clearTimeout(timer); client.close(); child.stdin?.end(); child.kill(); resolve(commands)
    }
    const timer = setTimeout(() => finish([]), 15000)
    child.stdin?.on('error', () => {})
    child.once('error', () => finish([])); child.once('close', () => finish([]))
    feed(child, line => client.receive(line), () => finish([]))
    child.once('spawn', () => { void client.skills(root).then(finish, () => finish([])) })
  })
}

/** An ACP agent's advertised commands, from an empty session in a scratch folder (no prompt, no tools). */
export function acpCommands(launcher: DriverLauncher & { bundledNode?: boolean }, args: string[]): Promise<AgentCommand[]> {
  return new Promise(resolve => {
    const cwd = fs.mkdtempSync(join(tmpdir(), 'ambio-agent-commands-'))
    const child = spawn(launcher.command, [...launcher.args, ...args], { cwd, env: childEnv(launcher), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
    let finished = false, commands: AgentCommand[] = []
    const client = new AcpClient({ cwd, prompt: '', mode: 'ask', mcpServers: [], send: line => child.stdin?.write(`${line}\n`), onSession: () => {}, onEvent: () => {}, onCommands: list => { commands = list } })
    const finish = () => {
      if (finished) return
      finished = true; clearTimeout(timer); client.close(); child.stdin?.end(); child.kill(); resolve(commands)
    }
    const timer = setTimeout(finish, 20000)
    child.stdin?.on('error', () => {})
    child.on('error', finish)
    child.on('close', () => { finish(); fs.rm(cwd, { recursive: true, force: true }, () => {}) })
    feed(child, line => client.receive(line), finish)
    child.once('spawn', () => {
      void client.open().then(async () => {
        // The list follows session/new; give it a moment if it has not come yet.
        for (let waited = 0; !commands.length && waited < 3000; waited += 100) await new Promise(done => setTimeout(done, 100))
        // Close the scratch session, but do not hold the list for an agent slow to confirm it.
        await Promise.race([client.disposeSession().catch(() => {}), new Promise(done => setTimeout(done, 1000))])
        finish()
      }, finish)
    })
  })
}

const cache = new Map<string, { expires: number; lookup: Promise<AgentCommand[]> }>()
const CACHE_MS = 10 * 60_000

/** The commands a host offers in a project, cached for a while: each look starts the agent. */
export function listAgentCommands(hostId: string, launcher: (DriverLauncher & { bundledNode?: boolean }) | undefined, root: string, home: string): Promise<AgentCommand[]> {
  if (hostId === 'claude-code') return Promise.resolve(claudeCommands(root, home))
  if (!launcher || (hostId !== 'codex' && hostId !== 'antigravity-cli')) return Promise.resolve([])
  const key = JSON.stringify([hostId, root, launcher.command, launcher.args])
  const known = cache.get(key)
  if (known && known.expires > Date.now()) return known.lookup
  const lookup = hostId === 'codex' ? codexSkills(launcher, root) : acpCommands(launcher, ['acp'])
  cache.set(key, { expires: Date.now() + CACHE_MS, lookup })
  // An agent that would not answer is asked again soon, not kept as having none.
  void lookup.then(list => { if (!list.length) { const entry = cache.get(key); if (entry?.lookup === lookup) entry.expires = Date.now() + 30_000 } })
  return lookup
}
