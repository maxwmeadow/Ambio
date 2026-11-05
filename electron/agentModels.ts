import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ModelOption } from '../src/shared/agentDelivery.ts'
import type { DriverLauncher } from './agentDrivers.ts'
import { MuseClient } from './museClient.ts'
import { antigravityOptions, inspectAntigravity } from './antigravityTransport.ts'
import { CodexAppServer, codexAccessLevels } from './codexAppServer.ts'

/**
 * The models each agent Ambio runs can be asked to use, read the way that
 * agent itself publishes them. An agent with no list here is run with its own
 * default; the picker is not offered for it.
 *
 * Claude Code: its documented aliases (the latest of each family).
 * Codex: the model list it caches for its own picker (~/.codex/models_cache.json).
 * Copilot CLI: the choices `copilot help config` lists for its model setting.
 * Antigravity CLI: `agy models`.
 */

const CLAUDE_ALIASES: ModelOption[] = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]

/** A model name a flag can carry safely. */
export function validModel(model: unknown): model is string {
  return typeof model === 'string' && /^[\w.:@/-]{1,100}$/.test(model)
}

export function codexModels(cache: string): ModelOption[] {
  try {
    const body = JSON.parse(cache) as { models?: Array<{ slug?: string; display_name?: string; visibility?: string; priority?: number }> }
    return (body.models ?? [])
      .filter(model => validModel(model.slug) && model.visibility !== 'hide')
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map(model => ({ id: model.slug!, label: model.display_name || model.slug! }))
  } catch { return [] }
}

/** The quoted choices listed under `model` in `copilot help config`. */
export function copilotModels(help: string): ModelOption[] {
  const lines = help.split(/\r?\n/)
  const start = lines.findIndex(line => /^\s*`model`:/.test(line))
  if (start < 0) return []
  const models: ModelOption[] = []
  for (const line of lines.slice(start + 1)) {
    const choice = /^\s+-\s+"([^"]+)"\s*$/.exec(line)
    if (choice) { if (validModel(choice[1])) models.push({ id: choice[1], label: choice[1] }); continue }
    if (models.length && !line.trim()) break
    if (/^\s*`[a-zA-Z]+`:/.test(line)) break
  }
  return models
}

/** `agy models`: one model per line, its ID then a tab and its name. */
export function antigravityModels(output: string): ModelOption[] {
  return output.split(/\r?\n/).flatMap(line => {
    const [id, label] = line.split('\t')
    return validModel(id?.trim()) && label ? [{ id: id.trim(), label: label.trim() }] : []
  })
}

/** Native `grok models` catalog, excluding headings and sign-in messages. */
export function grokModels(output: string): ModelOption[] {
  return output.split(/\r?\n/).flatMap(line => {
    const match = /^\s*[-*]\s+(\S+)(?:\s+\(default\))?\s*$/.exec(line)
    return match && validModel(match[1]) ? [{ id: match[1], label: match[1] }] : []
  })
}

/** Muse's published MSP model/list, without creating a session or a turn. */
function museModels(launcher: DriverLauncher): Promise<ModelOption[]> {
  return new Promise(resolve => {
    const child = spawn(launcher.command, [...launcher.args, 'serve'], { cwd: tmpdir(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
    const client = new MuseClient({ cwd: tmpdir(), prompt: '', mode: 'ask', mcpServers: [], send: line => child.stdin?.write(`${line}\n`), onSession: () => {}, onEvent: () => {} })
    let buffer = ''
    let finished = false
    const finish = (models: ModelOption[]) => {
      if (finished) return
      finished = true; clearTimeout(timer); client.close(); child.stdin?.end(); child.kill(); resolve(models)
    }
    const timer = setTimeout(() => finish([]), 30000)
    child.stdin?.on('error', () => {})
    child.on('error', () => finish([])); child.on('close', () => finish([]))
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
      if (buffer.length > 1 << 20) { finish([]); return }
      for (const line of lines) client.receive(line)
    })
    child.once('spawn', () => { void client.models().then(models => finish(models.filter(model => validModel(model.modelId)).map(model => ({ id: model.modelId, label: model.displayLabel || model.modelId }))), () => finish([])) })
  })
}

function run(launcher: DriverLauncher, args: string[]): Promise<string> {
  return new Promise(resolve => {
    // Nothing is written to it: some CLIs (agy) read stdin even when told what to do.
    const child = spawn(launcher.command, [...launcher.args, ...args], { cwd: tmpdir(), windowsHide: true, env: { ...process.env, ...(launcher.bundledNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(launcher.command) })
    let output = ''
    const timer = setTimeout(() => child.kill(), 30000)
    child.stdout?.on('data', chunk => { if (output.length < 1 << 20) output += chunk })
    child.on('error', () => { clearTimeout(timer); resolve(output) })
    child.on('close', () => { clearTimeout(timer); resolve(output) })
  })
}

const cache = new Map<string, { lookup: Promise<ModelOption[]>; expires: number }>()

/** Discovery does not create a thread or send a model prompt. */
const CODEX_RETRY_MS = 60000
const codexCatalogs = new Map<string, { expires: number; userAgent?: string; settled?: boolean; lookup: Promise<{ models: ModelOption[]; userAgent: string }> }>()
export function inspectCodex(launcher: DriverLauncher & { bundledNode?: boolean }): Promise<{ models: ModelOption[]; userAgent: string }> {
  const key = JSON.stringify(launcher)
  const known = codexCatalogs.get(key)
  if (known && known.expires > Date.now()) return known.lookup
  const lookup = new Promise<{ models: ModelOption[]; userAgent: string }>(resolve => {
    const env = { ...process.env }
    if (launcher.bundledNode) env.ELECTRON_RUN_AS_NODE = '1'
    else delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(launcher.command, [...launcher.args, 'app-server'], { cwd: tmpdir(), env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
    let userAgent = ''
    const client = new CodexAppServer({ cwd: tmpdir(), prompt: '', mode: 'ask', send: line => child.stdin?.write(`${line}\n`), onSession: () => {}, onEvent: () => {}, onServer: version => { userAgent = version } })
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    let finished = false
    const finish = (models: ModelOption[]) => {
      if (finished) return
      finished = true; clearTimeout(timer); client.close(); child.stdin?.end(); child.kill(); resolve({ models: models.filter(model => validModel(model.id)), userAgent })
    }
    const timer = setTimeout(() => finish([]), 15000)
    child.stdin?.on('error', () => {})
    child.once('error', () => finish([])); child.once('close', () => finish([]))
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk)
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
      if (buffer.length > 1 << 20) { finish([]); return }
      for (const line of lines) client.receive(line)
    })
    child.once('spawn', () => { void client.models().then(finish, () => finish([])) })
  })
  codexCatalogs.set(key, { expires: Date.now() + 300000, lookup })
  void lookup.then(result => {
    const entry = codexCatalogs.get(key)
    if (entry?.lookup !== lookup) return
    entry.settled = true
    // A server that would not start is tried again after a minute, not on
    // every host-list read (which would start one per poll).
    if (!result.userAgent) entry.expires = Date.now() + CODEX_RETRY_MS
    else entry.userAgent = result.userAgent
  })
  return lookup
}
export async function codexAppServerModels(launcher: DriverLauncher): Promise<ModelOption[]> { return (await inspectCodex(launcher)).models }
/** Whether a host-list read is still waiting on Codex's server for its levels. */
export function codexAccessPending(launcher: DriverLauncher): boolean {
  const entry = codexCatalogs.get(JSON.stringify(launcher))
  return !entry || !entry.settled
}
/** Host-list reads never wait for a process: a cold lookup runs in the background. */
export function codexAvailableAccess(launcher: DriverLauncher) {
  const entry = codexCatalogs.get(JSON.stringify(launcher))
  if (entry && entry.expires > Date.now()) return codexAccessLevels(entry.userAgent ?? '')
  void inspectCodex(launcher)
  return codexAccessLevels('')
}

/** Bounded catalog caching, separated by the actual executable selection. */
export function listModels(hostId: string, launcher: DriverLauncher | undefined, home: string): Promise<ModelOption[]> {
  const key = JSON.stringify([hostId, launcher?.command, launcher?.args, home])
  const known = cache.get(key)
  if (known && known.expires > Date.now()) return known.lookup
  const lookup = (async (): Promise<ModelOption[]> => {
    if (hostId === 'claude-code') return CLAUDE_ALIASES
    if (hostId === 'codex') {
      const live = launcher ? await codexAppServerModels(launcher) : []
      if (live.length) return live
      try { return codexModels(fs.readFileSync(join(process.env.CODEX_HOME ?? join(home, '.codex'), 'models_cache.json'), 'utf8')) } catch { return [] }
    }
    if (!launcher) return []
    if (hostId === 'grok') return grokModels(await run(launcher, ['models']))
    if (hostId === 'muse') return museModels(launcher)
    if (hostId === 'copilot-cli') return copilotModels(await run(launcher, ['help', 'config']))
    if (hostId === 'antigravity-cli' || hostId === 'antigravity-acp') {
      const [print, session] = await Promise.all([run(launcher, ['models']), inspectAntigravity(launcher)])
      const options = antigravityOptions(antigravityModels(print), session)
      return hostId === 'antigravity-acp' ? options.filter(model => model.transport === 'acp') : options
    }
    return []
  })()
  cache.set(key, { lookup, expires: Date.now() + 300000 })
  // A lookup that found nothing is tried again next time.
  void lookup.then(models => { if (!models.length && cache.get(key)?.lookup === lookup) cache.delete(key) }, () => { if (cache.get(key)?.lookup === lookup) cache.delete(key) })
  return lookup
}
