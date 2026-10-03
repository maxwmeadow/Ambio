import fs from 'fs'
import { dirname } from 'path'
import {
  inboxSkillPath,
  inspectHostConfiguration,
  readJson,
  writeJson,
  type HostDescriptor,
  type InstallResult,
} from './agentInstallers.ts'

// Undo what the installers wrote: the `ambio` MCP entry in each place a host
// reads, and the ambio-map / ambio-inbox workflow files. Nothing else in a
// host's configuration is touched, and a file Ambio cannot parse is left
// alone and reported rather than rewritten.

const TOML_TABLE = /^\s*\[[^\]]+\]\s*(?:#.*)?$/
const tomlServerTable = (name: string) =>
  new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${name}|"${name}"|'${name}')(?:\\s*\\.[^\\]]*)?\\s*\\]\\s*(?:#.*)?$`)

/** The server name agents knew before the rename (DECISIONS §3). */
export const LEGACY_SERVER_NAME = 'axiom'

/** A TOML document without Ambio's `[mcp_servers.ambio]` table (and subtables). */
export function removeTomlAmbioTable(source: string, name = 'ambio'): string {
  const serverTable = tomlServerTable(name)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (TOML_TABLE.test(line)) skipping = serverTable.test(line)
    if (!skipping) kept.push(line)
  }
  return kept.join(newline).replace(/(\r?\n){3,}/g, `${newline}${newline}`)
}

/** A JetBrains MCP server XML document without the `ambio` entry. */
export function removeXmlAmbioEntry(source: string, name = 'ambio'): string {
  return source.replace(new RegExp(`[ \\t]*<entry key="${name}">[\\s\\S]*?<\\/entry>\\r?\\n?`), '')
}

function removeJsonEntry(path: string, keyPath: string[], name = 'ambio'): 'removed' | 'absent' | 'unreadable' {
  const config = readJson(path)
  if (config === null) return 'unreadable'
  let servers: unknown = config
  for (const key of keyPath) {
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'absent'
    servers = (servers as Record<string, unknown>)[key]
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'absent'
  if (!Object.prototype.hasOwnProperty.call(servers, name)) return 'absent'
  delete (servers as Record<string, unknown>)[name]
  writeJson(path, config)
  return 'removed'
}

function removeWorkflowFile(path: string, name = 'ambio'): boolean {
  // Only files in our own skill folders, and only if they still look like
  // ours - a user who rewrote the file keeps it.
  if (!new RegExp(`${name}-(map|inbox)`).test(path) || !fs.existsSync(path)) return false
  try {
    if (!new RegExp(name, 'i').test(fs.readFileSync(path, 'utf8'))) return false
    fs.rmSync(path)
    const folder = dirname(path)
    if (new RegExp(`${name}-(map|inbox)$`).test(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder)
    return true
  } catch {
    return false
  }
}

/**
 * Remove Ambio from one agent. `others` are the remaining hosts: a workflow
 * folder shared with a host that is still configured (Copilot's VS Code and
 * CLI surfaces share one) is kept.
 */
export function uninstallHost(host: HostDescriptor, projectRoot: string | undefined, others: HostDescriptor[] = []): InstallResult {
  const removed: string[] = []
  const unreadable: string[] = []

  // A file another remaining agent also reads (VS Code Copilot reads the
  // Copilot CLI's config) is left for that agent.
  const sharedPaths = new Set(others
    .filter(other => other.id !== host.id)
    .flatMap(other => other.serverLocations(projectRoot).map(location => location.path)))

  for (const location of host.serverLocations(projectRoot)) {
    if (!fs.existsSync(location.path) || sharedPaths.has(location.path)) continue
    try {
      if (location.format === 'json') {
        const outcome = removeJsonEntry(location.path, location.keyPath)
        if (outcome === 'removed') removed.push(location.path)
        if (outcome === 'unreadable') unreadable.push(location.path)
      } else {
        const source = fs.readFileSync(location.path, 'utf8')
        const next = location.format === 'toml' ? removeTomlAmbioTable(source) : removeXmlAmbioEntry(source)
        if (next !== source) {
          fs.writeFileSync(location.path, next, 'utf8')
          removed.push(location.path)
        }
      }
    } catch {
      unreadable.push(location.path)
    }
  }

  const workflow = host.commandPath?.(projectRoot)
  if (workflow) {
    const stillShared = others.some(other =>
      other.id !== host.id &&
      other.commandPath?.(projectRoot) === workflow &&
      inspectHostConfiguration(other, projectRoot).configured)
    if (!stillShared) {
      for (const file of [workflow, inboxSkillPath(workflow)]) {
        if (removeWorkflowFile(file)) removed.push(file)
      }
    }
  }

  removed.push(...removeLegacyServer(host, projectRoot))

  if (unreadable.length > 0) {
    return {
      ok: false,
      detail: `Removed Ambio where it could, but could not read ${unreadable.join(', ')}; remove the "ambio" entry there by hand.`,
      paths: [...removed, ...unreadable],
    }
  }
  return {
    ok: true,
    detail: removed.length > 0 ? `Removed Ambio from ${host.modalityLabel || host.label}.` : `Ambio was not installed in ${host.modalityLabel || host.label}.`,
    paths: removed,
  }
}

/** Remove Ambio from every agent it knows about. */
export function uninstallAll(hosts: HostDescriptor[], projectRoot?: string): InstallResult {
  const results = hosts.map((host, index) => ({ host, result: uninstallHost(host, projectRoot, hosts.slice(index + 1)) }))
  const failed = results.filter(entry => !entry.result.ok)
  const touched = results.filter(entry => entry.result.paths.length > 0 && entry.result.ok)
  return {
    ok: failed.length === 0,
    detail: failed.length > 0
      ? failed.map(entry => entry.result.detail).join(' ')
      : touched.length > 0
        ? `Removed Ambio from ${touched.map(entry => entry.host.modalityLabel || entry.host.label).join(', ')}.`
        : 'Ambio was not installed in any agent.',
    paths: results.flatMap(entry => entry.result.paths),
  }
}

/**
 * Remove what installers wrote under the name from before the rename (the
 * `axiom` MCP entry and axiom-map / axiom-inbox skills), so an agent that is
 * set up again does not end up with two servers. Runs on install and
 * uninstall; returns the files it changed.
 */
export function removeLegacyServer(host: HostDescriptor, projectRoot: string | undefined): string[] {
  const changed: string[] = []
  for (const location of host.serverLocations(projectRoot)) {
    if (!fs.existsSync(location.path)) continue
    try {
      if (location.format === 'json') {
        if (removeJsonEntry(location.path, location.keyPath, LEGACY_SERVER_NAME) === 'removed') changed.push(location.path)
      } else {
        const source = fs.readFileSync(location.path, 'utf8')
        const next = location.format === 'toml'
          ? removeTomlAmbioTable(source, LEGACY_SERVER_NAME)
          : removeXmlAmbioEntry(source, LEGACY_SERVER_NAME)
        if (next !== source) {
          fs.writeFileSync(location.path, next, 'utf8')
          changed.push(location.path)
        }
      }
    } catch { /* unreadable: leave it */ }
  }
  const workflow = host.commandPath?.(projectRoot)
  if (workflow) {
    const legacy = (file: string) => file.replace(/ambio-(map|inbox)/g, `${LEGACY_SERVER_NAME}-$1`)
    for (const file of [legacy(workflow), legacy(inboxSkillPath(workflow))]) {
      if (removeWorkflowFile(file, LEGACY_SERVER_NAME)) changed.push(file)
    }
  }
  return changed
}
