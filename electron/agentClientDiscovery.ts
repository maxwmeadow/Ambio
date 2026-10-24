import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentHostInfo } from './preload'
import { SHARED_APP_CLIENTS } from '../src/shared/agentDelivery.ts'

/** Expose shared app routes without confusing their installation with the CLI. */
export function discoverAppClients(hosts: AgentHostInfo[], env = process.env, platform = process.platform, home = os.homedir()): AgentHostInfo[] {
  const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const directoryErrors: string[] = []
  const inspect = (candidates: string[]) => {
    const evidence: string[] = []
    const errors: string[] = []
    for (const file of new Set(candidates)) {
      try { fs.statSync(file); evidence.push(file) }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) errors.push(file) }
    }
    return { evidence, errors }
  }
  const children = (directory: string, matches: (name: string) => boolean, suffix: string[] = []) => {
    try { return fs.readdirSync(directory).filter(matches).map(name => join(directory, name, ...suffix)) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) directoryErrors.push(directory)
      return []
    }
  }
  const extension = (prefix: string) => [join(home, '.vscode', 'extensions'), join(home, '.vscode-insiders', 'extensions')]
    .flatMap(dir => children(dir, name => name.toLowerCase().startsWith(`${prefix}-`), ['package.json']))
  const surfacePaths = (id: string): string[] => {
    if (id === 'codex-ide') return extension('openai.chatgpt')
    if (id === 'claude-code-vscode') return extension('anthropic.claude-code')
    if (id === 'codex-app') return platform === 'win32'
      ? children(join(local, 'OpenAI', 'Codex', 'bin'), () => true, ['codex.exe'])
      : platform === 'darwin' ? ['/Applications/Codex.app', join(home, 'Applications', 'Codex.app')] : []
    if (id === 'claude-code-jetbrains') {
      const root = platform === 'win32' ? join(roaming, 'JetBrains') : platform === 'darwin' ? join(home, 'Library', 'Application Support', 'JetBrains') : join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'JetBrains')
      return children(root, () => true).flatMap(dir => children(join(dir, 'plugins'), name => /claude/i.test(name)))
    }
    return []
  }
  const base = hosts.map(host => {
    const found = inspect([host.configPath, ...(host.detected ? [dirname(host.configPath)] : [])])
    return { ...host, detectionEvidence: found.evidence, ...(found.errors.length ? { detectionError: `Could not inspect: ${found.errors.join(', ')}` } : {}) }
  })
  return [...base, ...SHARED_APP_CLIENTS.flatMap(client => {
    const host = hosts.find(host => host.id === client.installer)
    if (!host) return []
    const found = inspect(surfacePaths(client.id))
    found.errors.push(...directoryErrors.splice(0))
    return [{ ...host, id: client.id, connectionHostId: client.installer, label: client.label, modalityLabel: client.label,
      modality: client.modality, sharedSurfaces: [], detected: found.evidence.length > 0,
      detectionEvidence: found.evidence,
      ...(found.errors.length ? { detectionError: `Could not inspect: ${found.errors.join(', ')}` } : {}),
      restartAction: `Restart ${client.label}`, restartDetail: `Close and reopen ${client.label} to load Ambio's tools.`,
    }]
  })]
}
