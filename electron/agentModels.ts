import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import type { ModelOption } from '../src/shared/agentDelivery.ts'
import type { DriverLauncher } from './agentDrivers.ts'
import { hiddenConsoleStdio } from './hiddenConsole.ts'

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
  { id: 'fable', label: 'Fable (latest)' },
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'haiku', label: 'Haiku (latest)' },
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

function run(launcher: DriverLauncher, args: string[]): Promise<string> {
  return new Promise(resolve => {
    // Nothing is written to it: some CLIs (agy) read stdin even when told what to do.
    const child = spawn(launcher.command, [...launcher.args, ...args], { cwd: tmpdir(), windowsHide: true, stdio: hiddenConsoleStdio(['ignore', 'pipe', 'ignore']), shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(launcher.command) })
    let output = ''
    const timer = setTimeout(() => child.kill(), 30000)
    child.stdout?.on('data', chunk => { if (output.length < 1 << 20) output += chunk })
    child.on('error', () => { clearTimeout(timer); resolve(output) })
    child.on('close', () => { clearTimeout(timer); resolve(output) })
  })
}

const cache = new Map<string, Promise<ModelOption[]>>()

/** The models for one host, looked up once per app session. */
export function listModels(hostId: string, launcher: DriverLauncher | undefined, home: string): Promise<ModelOption[]> {
  const known = cache.get(hostId)
  if (known) return known
  const lookup = (async (): Promise<ModelOption[]> => {
    if (hostId === 'claude-code') return CLAUDE_ALIASES
    if (hostId === 'codex') {
      try { return codexModels(fs.readFileSync(join(home, '.codex', 'models_cache.json'), 'utf8')) } catch { return [] }
    }
    if (!launcher) return []
    if (hostId === 'copilot-cli') return copilotModels(await run(launcher, ['help', 'config']))
    if (hostId === 'antigravity-cli') return antigravityModels(await run(launcher, ['models']))
    return []
  })()
  cache.set(hostId, lookup)
  // A lookup that found nothing is tried again next time.
  void lookup.then(models => { if (!models.length) cache.delete(hostId) })
  return lookup
}
