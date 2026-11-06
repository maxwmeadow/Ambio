import fs from 'node:fs'
import os from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { detectEditors } from './fileAccess.ts'
import { processStartIdentity, resolveNodeCommand } from './platformPaths.ts'
import { CLI_CLIENTS, currentClientId, type AgentAccess, type DeliveryEvent, type DeliveryHost, type DeliveryRun } from '../src/shared/agentDelivery.ts'
import { DRIVER_CLI_NAMES, agentDriver, type AgentDriver, type DriverPlan, type TurnMode } from './agentDrivers.ts'
import { AcpClient, type AcpTurn } from './acpClient.ts'
import { MuseClient, type MuseTurn } from './museClient.ts'
import { CodexAppServer, type CodexAppServerTurn } from './codexAppServer.ts'
import { daemonFetch, mappingAttemptState } from './daemonAuth.ts'
import type { MappingBinding } from '../src/shared/agentDelivery.ts'

export interface DeliveryLauncher { command: string; args: string[]; bundledNode?: boolean }
export interface DeliveryTarget extends DeliveryHost { launcher?: DeliveryLauncher }
const CLI_NAMES = DRIVER_CLI_NAMES
// Where each CLI's npm package lives, and the entry script it had when Ambio
// first knew it. The package's own "bin" wins: Copilot CLI moved its entry
// from index.js to npm-loader.js (seen in 1.0.98).
const NPM_PACKAGES: Record<string, { name: string; bin: string; entry: string }> = {
  'claude-code': { name: '@anthropic-ai/claude-code', bin: 'claude', entry: 'cli.js' },
  codex: { name: '@openai/codex', bin: 'codex', entry: 'bin/codex.js' },
  'copilot-cli': { name: '@github/copilot', bin: 'copilot', entry: 'index.js' },
  grok: { name: '@xai-official/grok', bin: 'grok', entry: 'bin/grok-bootstrap.js' },
}

/**
 * The native program an npm-installed CLI's JS launcher would start, when its
 * platform package is installed. Ambio starts it directly: the launchers
 * (npm-loader.js, codex.js) start it with their own stdio inherited, and on
 * Windows that gives it a console of its own, which Windows Terminal shows as
 * an empty window.
 */
const NATIVE_TRIPLES: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
}
function npmNative(hostId: string, packageDir: string, platform: NodeJS.Platform, arch = process.arch): string | undefined {
  const exe = (name: string) => platform === 'win32' ? `${name}.exe` : name
  const target = `${platform}-${arch}`
  // Installed inside the package, or hoisted beside it.
  const scopes = [join(packageDir, 'node_modules'), join(packageDir, '..', '..')]
  const candidates = hostId === 'grok' ? [join(packageDir, 'bin', exe('grok-native'))] : hostId === 'copilot-cli'
    ? scopes.map(scope => join(scope, '@github', `copilot-${target}`, exe('copilot')))
    : hostId === 'codex' && NATIVE_TRIPLES[target]
      ? [...scopes.map(scope => join(scope, '@openai', `codex-${target}`, 'vendor', NATIVE_TRIPLES[target], 'bin', exe('codex'))),
        join(packageDir, 'vendor', NATIVE_TRIPLES[target], 'bin', exe('codex'))]
      : []
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile() } catch { return false } })
}

/** The script an installed npm package runs for its command, if it is there. */
function npmEntry(packageDir: string, pkg: { bin: string; entry: string }, unreadable: string[] = []): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(join(packageDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
    const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[pkg.bin]
    if (declared) {
      const script = join(packageDir, declared)
      if (fs.existsSync(script) && fs.statSync(script).isFile()) return script
    }
  } catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable.push(packageDir)
  }
  const legacy = join(packageDir, pkg.entry)
  try { return fs.statSync(legacy).isFile() ? legacy : undefined }
  catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable.push(packageDir)
    return undefined
  }
}

function environmentPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path')
  return key ? env[key] ?? '' : ''
}

function executable(file: string, unreadable: string[] = []): boolean {
  try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(file).isFile() }
  catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable.push(file)
    return false
  }
}

/** Resolve known CLIs, including native installs and npm's Windows JS entrypoints.
 * Never invoke a .cmd shim through a shell with a human-authored prompt. */
export function findDeliveryCli(hostId: string, env = process.env, platform = process.platform, home = os.homedir(), node = process.execPath, unreadable: string[] = []): DeliveryLauncher | undefined {
  const names = CLI_NAMES[hostId]
  if (!names) return undefined
  const dirs = [...environmentPath(env).split(delimiter).filter(Boolean), join(home, '.local', 'bin'), join(home, '.volta', 'bin'), join(home, '.asdf', 'shims'), '/opt/homebrew/bin', '/usr/local/bin']
  if (hostId === 'grok') dirs.push(join(env.GROK_HOME ?? join(home, '.grok'), 'bin'))
  for (const versions of [join(home, '.nvm', 'versions', 'node'), join(home, '.asdf', 'installs', 'nodejs')]) {
    try { dirs.push(...fs.readdirSync(versions).sort().reverse().map(version => join(versions, version, 'bin'))) } catch { /* manager not installed */ }
  }
  if (platform === 'win32') dirs.push(join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'))
  if (hostId === 'antigravity-cli') dirs.push(join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'agy', 'bin'))
  for (const dir of dirs) {
    // Editor/desktop apps inject their private Codex into agent sessions' PATH.
    // Its presence does not establish a standalone CLI installation.
    if (hostId === 'codex' && /(?:[\\/]\.vscode(?:-insiders)?[\\/]extensions[\\/]openai\.chatgpt-|[\\/]OpenAI[\\/]Codex[\\/]bin[\\/])/i.test(`${dir}/`)) continue
    for (const name of names) {
      // A name that carries its own extension is that file on every platform.
      const command = join(dir, platform === 'win32' && !name.includes('.') ? `${name}.exe` : name)
      if (executable(command, unreadable)) return { command, args: [] }
    }
  }
  const pkg = NPM_PACKAGES[hostId]
  if (!pkg) return undefined
  const npmDirs = [...dirs.map(dir => join(dir, 'node_modules')), join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'node_modules'), '/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules']
  for (const dir of npmDirs) {
    const script = npmEntry(join(dir, pkg.name), pkg, unreadable)
    if (!script) continue
    const native = npmNative(hostId, join(dir, pkg.name), platform as NodeJS.Platform)
    if (native) return { command: native, args: [] }
    // Grok's declared bin is a shell wrapper; its JS bootstrap is the Node entry.
    const entry = hostId === 'grok' ? join(dir, pkg.name, 'bin', 'grok-bootstrap.js') : script
    if (!fs.existsSync(entry)) continue
    return { command: node, args: [entry], bundledNode: true }
  }
  return undefined
}

/** All installed modalities remain visible, even when a host has no public chat API. */
export function deliveryTargets(hosts: { id: string; label: string }[], env = process.env, platform = process.platform, home = os.homedir(), overrides: Record<string, string> = {}): DeliveryTarget[] {
  const editors = detectEditors(env, platform, home)
  const editorId: Record<string, string[]> = { copilot: ['vscode'], cursor: ['cursor'], windsurf: ['windsurf'], jetbrains: ['intellij', 'webstorm', 'pycharm', 'goland'], zed: ['zed'] }
  // An editor's own terminal agent is a second way to reach the same host: it
  // can be started for a turn, where the editor's chat can only be pasted into.
  const catalog = [...hosts, ...CLI_CLIENTS.filter(client => !hosts.some(host => host.id === client.id))]
  return catalog.map(({ id, label }) => {
    const host = { id, label }
    if (CLI_NAMES[host.id]) {
      const selected = overrides[id]
      let launcher: DeliveryLauncher | undefined
      let discoveryError: string | undefined
      if (selected) {
        try { launcher = selectedDeliveryCli(id, selected, platform) }
        catch (error) { discoveryError = error instanceof Error ? error.message : String(error) }
      } else {
        const unreadable: string[] = []
        launcher = findDeliveryCli(host.id, env, platform, home, process.execPath, unreadable)
        if (!launcher && unreadable.length) discoveryError = `Some CLI locations could not be checked: ${[...new Set(unreadable)].slice(0, 3).join(', ')}. Locate the executable or correct access and rescan.`
      }
      return { ...host, route: 'run', available: !!launcher, launcher,
        ...(selected ? { executableOverride: selected } : {}),
        ...(launcher ? { executablePath: launcher.args[0] ?? launcher.command } : {}),
        ...(discoveryError ? { discoveryError } : {}),
        detail: discoveryError ?? (launcher ? 'CLI found, started by Ambio for each request. Sign in to this CLI before starting a run.' : 'CLI not found. Install it or locate its executable.'),
      } as DeliveryTarget
    }
    let launcher: DeliveryLauncher | undefined
    const editor = editors.find(item => editorId[host.id]?.includes(item.id))
    if (editor) launcher = { command: editor.command, args: [] }
    if (host.id === 'antigravity' && platform !== 'win32') {
      const command = [...(env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/local/bin'].map(dir => join(dir, 'antigravity')).find(file => executable(file))
      if (command) launcher = { command, args: [] }
    }
    if (host.id === 'claude-desktop' && platform === 'darwin') {
      const app = ['/Applications/Claude.app', join(home, 'Applications', 'Claude.app')].find(file => fs.existsSync(file))
      if (app) launcher = { command: '/usr/bin/open', args: ['-a', app] }
    }
    return { ...host, route: launcher ? 'open' : 'copy', available: true, launcher, detail: launcher ? 'Copy the handoff and open this host. Paste it into the chat you choose.' : 'Copy the handoff, then paste it into this host’s chat. No supported launcher was found.' } as DeliveryTarget
  })
}

/** Resolve a human-selected file without passing prompts through a shell. */
export function selectedDeliveryCli(hostId: string, file: string, platform = process.platform, node = process.execPath): DeliveryLauncher {
  if (!CLI_NAMES[hostId]) throw new Error('This client has no runnable CLI.')
  try {
    if (!isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error()
    fs.accessSync(file, /\.(?:[cm]?js|cmd|bat|ps1)$/i.test(file) ? fs.constants.R_OK : process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
  } catch { throw new Error('The selected CLI file is missing, inaccessible, or not executable. Locate it again.') }
  if (/\.(?:cmd|bat|ps1)$/i.test(file)) {
    const pkg = NPM_PACKAGES[hostId]
    const packageDir = pkg && join(dirname(file), 'node_modules', pkg.name)
    const script = pkg && packageDir && npmEntry(packageDir, pkg)
    if (script && packageDir) {
      const native = npmNative(hostId, packageDir, platform)
      return native ? { command: native, args: [] } : { command: node, args: [script], bundledNode: true }
    }
    throw new Error('This is a shell or installer shortcut. Choose the CLI executable or its installed npm entry script instead.')
  }
  if (/\.(?:[cm]?js)$/i.test(file)) return { command: node, args: [file], bundledNode: true }
  if (platform === 'win32' && !/\.exe$/i.test(file) && !CLI_NAMES[hostId].includes(basename(file))) throw new Error('Choose a Windows .exe or an installed npm CLI entry script.')
  return { command: file, args: [] }
}

/**
 * A link that opens an editor's own chat with the handoff already in it, for
 * the editors that document one. Nothing else can put words into an editor's
 * chat from outside; with this the user does not have to paste.
 *
 * VS Code: the Copilot Chat extension's chat link ("Ask in VS Code").
 * Cursor: its prompt deeplink, which fills the chat and waits for the user to
 * send. Cursor rejects links over 8,000 characters, so a longer one is left
 * to the clipboard.
 */
export function chatDeepLink(hostId: string, prompt: string, mode: TurnMode = 'build'): string | undefined {
  const text = encodeURIComponent(prompt)
  const link = hostId === 'copilot' ? `vscode://GitHub.Copilot-Chat/chat?mode=${mode === 'ask' ? 'ask' : 'agent'}&prompt=${text}`
    : hostId === 'cursor' ? `cursor://anysphere.cursor-deeplink/prompt?text=${text}`
      : undefined
  return link && link.length <= 8000 ? link : undefined
}

/** How one turn is started in a host: its arguments, stdin and session. */
export function deliveryPlan(hostId: string, mcp: DeliveryLauncher, workspaceId: string, prompt: string, turn: { mode?: TurnMode; resume?: string; messageId?: string; cwd?: string; model?: string; mapping?: MappingBinding; access?: AgentAccess } = {}): DriverPlan {
  const driver = agentDriver(hostId)
  if (!driver) throw new Error('This host has no direct delivery route.')
  return driver.plan({ hostId, mcp, workspaceId, prompt, mode: turn.mode ?? 'build', resume: turn.resume, messageId: turn.messageId, cwd: turn.cwd, model: turn.model, mapping: turn.mapping, access: turn.access })
}

export function deliveryArguments(hostId: string, mcp: DeliveryLauncher, workspaceId: string, prompt: string, turn: { mode?: TurnMode; resume?: string; messageId?: string; cwd?: string; model?: string; mapping?: MappingBinding; access?: AgentAccess } = {}): string[] {
  return deliveryPlan(hostId, mcp, workspaceId, prompt, turn).args
}

export interface RunInput {
  codex?: Pick<CodexAppServerTurn, 'resume' | 'model' | 'approval' | 'reviewer' | 'review'>
  codexTransport?: DeliveryRun['codexTransport']
  workspaceId: string; messageId: string; hostId: string; rootPath: string; revision: string; launcher: DeliveryLauncher; args: string[]; prompt: string
  /** The conversation and kind of turn, when the request carries them. */
  threadId?: string; mode?: TurnMode
  /** Reads the host's output for its session and what it is doing. */
  driver?: AgentDriver
  /** The session Ambio named for this run, or the one it continues. */
  sessionId?: string; resumed?: boolean
  /** Written to stdin; undefined closes it without a prompt. */
  stdin?: string
  /** Started instead when a continued session will not start: the same turn, fresh. */
  fresh?: () => { args: string[]; stdin?: string; sessionId?: string }
  /** Run the turn as an Agent Client Protocol session with these MCP servers. */
  acp?: Pick<AcpTurn, 'mcpServers' | 'resume' | 'model' | 'thinking' | 'strictResume' | 'steering' | 'onPermission'>
  transport?: 'acp' | 'print'
  model?: string
  thinking?: string
  muse?: Pick<MuseTurn, 'mcpServers' | 'resume' | 'model' | 'approvalMode'>
  mapping?: MappingBinding
}

/** How long a streaming host is given to end its own turn on Stop. */
const STREAM_STOP_GRACE = 5000

/**
 * A turn that has ended takes no more answers: whatever it still has waiting
 * on the permission desk (a permission card, a question) is released as a
 * refusal and its card goes away. Codex and ACP turns also drop their own
 * waits; Claude Code's are held by Ambio's MCP server, which cannot tell that
 * its turn was stopped, so this covers every host.
 */
async function releaseTurnQuestions(run: DeliveryRun): Promise<void> {
  if (!run.messageId) return
  try {
    await daemonFetch(`${process.env.AMBIO_API_URL ?? 'http://127.0.0.1:7743'}/api/agent/permission/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ workspaceId: run.workspaceId, messageId: run.messageId }),
    })
  } catch { /* no daemon, no questions; an unanswered one expires as a refusal anyway */ }
}

export function checkDeliveryMessage(message: { id?: string; workspaceId?: string; deliveryMode?: string; status?: string; leaseExpiresAt?: number }, workspaceId: string, messageId: string, now = Date.now()): void {
  if (message.id !== messageId || message.workspaceId !== workspaceId) throw new Error('This work order belongs to another project.')
  if (message.deliveryMode !== 'addressed' || !['queued', 'delivered'].includes(message.status ?? '')) throw new Error('This work order is closed or is not an addressed request.')
  if ((message.leaseExpiresAt ?? 0) > now) throw new Error('An agent already holds this request. Wait for its reply or stop that agent before handing it off again.')
}

/** Launch receipts are written before spawn. A retry after a crash never silently
 * executes the same request again. MCP claims still fence replies across hosts. */
export class DeliveryRunner {
  private live = new Map<string, { child: ChildProcess; run: DeliveryRun }>()
  private acp = new Map<string, AcpClient | MuseClient>()
  /** Streaming hosts whose turn is still open to messages (AgentDriver.stream). */
  private streams = new Map<string, { send(id: string, text: string): Promise<void>; interrupt(): void; close(): void }>()
  private codex = new Map<string, CodexAppServer>()
  private directory: string
  private spawnProcess: typeof spawn
  private finished = new Map<string, Promise<void>>()
  private terminating = new Map<string, Promise<void>>()
  private recovering = new Map<string, Promise<void>>()
  private releaseQuestions: (run: DeliveryRun) => Promise<void>
  constructor(directory: string, spawnProcess: typeof spawn = spawn, releaseQuestions = releaseTurnQuestions) {
    this.directory = directory
    this.spawnProcess = spawnProcess
    this.releaseQuestions = releaseQuestions
  }

  private file(key: string): string { return join(this.directory, `${key}.json`) }
  private eventsFile(key: string): string { return join(this.directory, `${key}.events.jsonl`) }
  private sessionsFile(): string { return join(this.directory, 'sessions.json') }
  private sessions(): Record<string, string> {
    let value: unknown
    try { value = JSON.parse(fs.readFileSync(this.sessionsFile(), 'utf8')) } catch { return {} }
    if (!value || typeof value !== 'object') return {}
    // A session saved under a retired client continues under the one that replaced it.
    return Object.fromEntries(Object.entries(value).map(([key, session]) => {
      try {
        const [workspaceId, threadId, hostId] = JSON.parse(key) as [string, string, string]
        return [this.sessionKey(workspaceId, threadId, currentClientId(hostId)), session]
      } catch { return [key, session] }
    }))
  }
  private sessionKey(workspaceId: string, threadId: string, hostId: string): string { return JSON.stringify([workspaceId, threadId, hostId]) }
  /** The host session an earlier turn of this conversation ran in, if any. */
  session(workspaceId: string, threadId: string | undefined, hostId: string): string | undefined {
    return threadId ? this.sessions()[this.sessionKey(workspaceId, threadId, hostId)] : undefined
  }
  /** Old Antigravity CLI receipts retain print, including after a restart. */
  conversationTransport(workspaceId: string, threadId: string, hostId: string): 'acp' | 'print' | undefined {
    const run = this.list(workspaceId).filter(run => run.threadId === threadId && run.hostId === hostId).sort((a, b) => a.startedAt - b.startedAt)[0]
    return run ? run.transport ?? 'print' : undefined
  }
  /** Legacy Codex conversations keep exec; new ones prefer native App Server. */
  codexTransport(workspaceId: string, threadId: string): DeliveryRun['codexTransport'] {
    const first = this.list(workspaceId).filter(run => run.threadId === threadId && run.hostId === 'codex').sort((a, b) => a.startedAt - b.startedAt)[0]
    return first ? first.codexTransport ?? 'exec' : undefined
  }
  /**
   * Sends a message into a running turn, for the hosts that take one (a
   * Claude Code stream, Codex App Server, an ACP agent that steers). It resolves once the agent
   * has taken the message in; until then the composer keeps the draft.
   */
  async steer(workspaceId: string, key: string, text: string): Promise<void> {
    const live = this.live.get(key)
    if (!live || live.run.workspaceId !== workspaceId || live.run.state !== 'running' || !live.run.canSteer) throw new Error('This run is not accepting input. Your draft is kept.')
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Enter a message of up to 16,000 characters.')
    text = text.trim()
    const stream = this.streams.get(key)
    if (stream) return stream.send(randomUUID(), text)
    const codex = this.codex.get(key)
    if (codex) {
      await codex.steer(text)
      fs.appendFileSync(this.eventsFile(key), `${JSON.stringify({ at: Date.now(), kind: 'sent', text })}\n`)
      return
    }
    const client = this.acp.get(key)
    if (!(client instanceof AcpClient)) throw new Error('This run is not accepting input. Your draft is kept.')
    await client.steer(text)
  }
  private rememberSession(run: DeliveryRun): void {
    if (!run.threadId || !run.sessionId || run.mappingAttemptId) return
    const sessions = this.sessions()
    sessions[this.sessionKey(run.workspaceId, run.threadId, run.hostId)] = run.sessionId
    fs.writeFileSync(`${this.sessionsFile()}.tmp`, JSON.stringify(sessions), { mode: 0o600 })
    fs.renameSync(`${this.sessionsFile()}.tmp`, this.sessionsFile())
  }
  private forgetSession(run: DeliveryRun): void {
    if (!run.threadId) return
    const sessions = this.sessions()
    delete sessions[this.sessionKey(run.workspaceId, run.threadId, run.hostId)]
    try { fs.writeFileSync(this.sessionsFile(), JSON.stringify(sessions), { mode: 0o600 }) } catch { /* the next turn starts fresh either way */ }
  }
  /** What a run has said and done so far, oldest first. */
  events(workspaceId: string, key: string, after = 0): DeliveryEvent[] {
    if (!/^[a-f0-9]{64}$/.test(key)) return []
    try {
      const receipt = JSON.parse(fs.readFileSync(this.file(key), 'utf8')) as DeliveryRun
      if (receipt.workspaceId !== workspaceId) return []
      const events: DeliveryEvent[] = []
      const indices = new Map<string, number>()
      for (const line of fs.readFileSync(this.eventsFile(key), 'utf8').split('\n').filter(Boolean)) {
        try {
          const event = JSON.parse(line) as DeliveryEvent
          const index = event.id ? indices.get(event.id) : undefined
          if (index !== undefined) events[index] = event
          else { if (event.id) indices.set(event.id, events.length); events.push(event) }
        } catch { /* a partial last write is read next time */ }
      }
      return events.slice(Math.max(0, after))
    } catch { return [] }
  }
  private save(run: DeliveryRun): void {
    fs.writeFileSync(`${this.file(run.key)}.tmp`, JSON.stringify(run), { mode: 0o600 })
    fs.renameSync(`${this.file(run.key)}.tmp`, this.file(run.key))
  }
  list(workspaceId: string): DeliveryRun[] {
    if (!fs.existsSync(this.directory)) return []
    return fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      try {
        const saved = JSON.parse(fs.readFileSync(join(this.directory, name), 'utf8')) as DeliveryRun
        if (saved.workspaceId !== workspaceId) return []
        // The Antigravity ACP agent's runs belong to Antigravity CLI conversations on its ACP connection.
        const run = saved.hostId === 'antigravity-acp' ? { ...saved, hostId: currentClientId(saved.hostId), transport: saved.transport ?? 'acp' as const } : saved
        if (['starting', 'running', 'stopping'].includes(run.state) && !this.live.has(run.key)) return [{ ...run, state: 'interrupted' as const, detail: 'Ambio restarted during this run. Check the agent and its output before handing off again.' }]
        return [run]
      } catch { return [] }
    })
  }
  async recoverMappings(workspaceId: string): Promise<void> {
    await Promise.all(this.list(workspaceId).filter(run => run.mappingAttemptId && run.state === 'interrupted' && !this.live.has(run.key)).map(run => {
      const prior = this.recovering.get(run.key)
      if (prior) return prior
      const recover = (async () => {
        await mappingAttemptState(workspaceId, run.mappingAttemptId!, 'cancel')
        const identity = run.pid ? await processStartIdentity(run.pid) : ''
        if (identity === null || identity && (!run.processIdentity || identity !== run.processIdentity)) {
          // A changed identity proves the old process is gone. An unknown
          // identity cannot justify terminating this PID or opening Review.
          if (identity === null || !run.processIdentity) {
            run.detail = 'The previous mapping process could not be verified. Stop it before reviewing.'
            this.save(run); return
          }
        } else if (identity && run.pid) {
          await this.terminate(run.pid, true)
          for (let i = 0; i < 30; i++) {
            const current = await processStartIdentity(run.pid)
            if (current === '' || current && current !== identity) break
            if (i === 29) throw new Error('The previous mapping process has not stopped yet.')
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }
        const attempt = await mappingAttemptState(workspaceId, run.mappingAttemptId!, 'settle')
        run.state = attempt.state === 'submitted' ? 'completed' : 'stopped'
        run.detail = attempt.state === 'submitted' ? 'Mapping submitted. The previous agent session is closed.' : 'The interrupted mapping session is closed. Retry mapping.'
        this.save(run)
      })().finally(() => this.recovering.delete(run.key))
      this.recovering.set(run.key, recover)
      return recover
    }))
  }
  assertRootAvailable(rootPath: string): void {
    const root = fs.realpathSync(rootPath)
    if ([...this.live.values()].some(({ run }) => fs.realpathSync(run.rootPath) === root)) throw new Error('An external agent is working in this project. Stop it or wait before starting integrated chat.')
    if (!fs.existsSync(this.directory)) return
    for (const file of fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      let run: DeliveryRun
      try { run = JSON.parse(fs.readFileSync(join(this.directory, file), 'utf8')) } catch { continue }
      if (!['starting', 'running', 'stopping'].includes(run.state) || !run.pid || !fs.existsSync(run.rootPath) || fs.realpathSync(run.rootPath) !== root) continue
      try { process.kill(run.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue }
      throw new Error('An earlier external agent may still be running. Check and stop it before starting integrated chat.')
    }
  }
  start(input: RunInput): Promise<DeliveryRun> {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(JSON.stringify([input.workspaceId, input.messageId, input.revision])).digest('hex')
    const prior = this.list(input.workspaceId).find(run => run.key === key)
    if (prior && prior.state !== 'launch-failed') return Promise.resolve(prior)
    const rootPath = fs.realpathSync(input.rootPath)
    if ([...this.live.values()].some(({ run }) => fs.realpathSync(run.rootPath) === rootPath)) throw new Error('An Ambio-launched agent is already running in this project. Stop it or wait for its result first.')
    for (const previous of this.list(input.workspaceId)) {
      if (previous.state !== 'interrupted' || !previous.pid) continue
      try { process.kill(previous.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue }
      throw new Error('An earlier agent process may still be running after Ambio restarted. Stop that agent before launching another in this project.')
    }
    const run: DeliveryRun = {
      ...(input.codexTransport ? { codexTransport: input.codexTransport } : {}),
      ...(input.codex ? { codexApproval: input.codex.approval ?? 'never', canSteer: false } : {}),
      key, workspaceId: input.workspaceId, messageId: input.messageId, revision: input.revision, hostId: input.hostId, rootPath, state: 'starting', detail: 'Starting agent…', logPath: join(this.directory, `${key}.log`), startedAt: Date.now(),
      ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.mode ? { mode: input.mode } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.resumed ? { resumed: true } : {}),
      ...(input.mapping ? { mappingAttemptId: input.mapping.attempt.id } : {}),
      ...(input.transport ? { transport: input.transport } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.acp?.steering ? { canSteer: true } : {}),
    }
    // Exclusive receipt also protects a second Electron process.
    if (!prior) {
      try { fs.writeFileSync(this.file(key), JSON.stringify(run), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This work order already has a launch receipt. Refresh before trying again.'); throw error }
    } else this.save(run)
    fs.writeFileSync(run.logPath, '', { mode: 0o600 })
    fs.writeFileSync(this.eventsFile(key), '', { mode: 0o600 })
    // A session named before the run exists from its first line, so the next
    // turn can continue it even if this one is stopped early.
    if (!input.resumed) this.rememberSession(run)
    return new Promise(resolveRun => {
      let resolved = false
      const settle = () => { if (!resolved) { resolved = true; resolveRun({ ...run }) } }
      const fail = (error: Error) => { run.state = 'launch-failed'; run.detail = `Could not launch the agent: ${error.message}`; this.live.delete(key); this.save(run); settle() }
      // Without a plan from a driver, the prompt goes to stdin as it always has.
      const stdin = 'stdin' in input ? input.stdin : input.hostId === 'copilot-cli' ? undefined : input.prompt
      this.launch(input, run, { args: input.args, stdin, resumed: !!input.resumed, acp: !!input.acp }, settle, fail)
    })
  }

  /** One attempt at a turn. A continued session that will not start is tried once more, fresh. */
  private launch(input: RunInput, run: DeliveryRun, attempt: { args: string[]; stdin?: string; resumed: boolean; acp?: boolean }, settle: () => void, fail: (error: Error) => void): void {
    const key = run.key
    const rootPath = run.rootPath
    {
      let child: ChildProcess
      let childEnv: NodeJS.ProcessEnv = process.env
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, AMBIO_WORKSPACE_ID: input.workspaceId, AMBIO_AGENT_HOST: input.hostId }
        // The run message id is Claude Code's permission hook (mcpEnvironment);
        // a mapping turn carries it as its request binding on every host.
        if (input.hostId !== 'claude-code') delete env.AMBIO_RUN_MESSAGE_ID
        if (input.mapping) Object.assign(env, { AMBIO_MAPPING_ATTEMPT: input.mapping.attempt.id, AMBIO_API_TOKEN: input.mapping.token, AMBIO_RUN_MESSAGE_ID: input.messageId })
        // A GUI app's PATH may omit the directory of its resolved CLI or Node.
        const node = resolveNodeCommand()
        const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH'
        env[pathKey] = [dirname(input.launcher.command), ...(isAbsolute(node) ? [dirname(node)] : []), ...environmentPath(env).split(delimiter)].join(delimiter)
        if (input.launcher.bundledNode) env.ELECTRON_RUN_AS_NODE = '1'
        else delete env.ELECTRON_RUN_AS_NODE
        input.driver?.preflight?.(input.mode ?? 'build', env, process.platform)
        childEnv = env
        child = this.spawnProcess(input.launcher.command, [...input.launcher.args, ...attempt.args], { cwd: rootPath, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        if (input.mapping) void mappingAttemptState(input.workspaceId, input.mapping.attempt.id, 'cancel')
          .then(() => mappingAttemptState(input.workspaceId, input.mapping!.attempt.id, 'settle'))
          .then(() => fail(error as Error), cleanupError => fail(new Error(`${String(error)}; ${String(cleanupError)}`)))
        else fail(error as Error)
        return
      }
      this.live.set(key, { child, run })
      let resolveFinished!: () => void
      const finished = new Promise<void>(resolve => { resolveFinished = resolve })
      this.finished.set(key, finished)
      let mappingPollBusy = false
      const mappingTimer = input.mapping ? setInterval(() => {
        if (mappingPollBusy || !this.live.has(key) || run.state === 'stopping') return
        mappingPollBusy = true
        void mappingAttemptState(run.workspaceId, input.mapping!.attempt.id).then(attempt => {
          if (attempt.state !== 'mapping' && this.live.has(key)) return this.stop(run.workspaceId, key)
        }).catch(() => { /* closed credentials still fence writes; retry shutdown */ }).finally(() => { mappingPollBusy = false })
      }, 250) : undefined
      let logged = 0
      const output = (chunk: Buffer) => {
        const part = chunk.subarray(0, Math.max(0, 1024 * 1024 - logged))
        if (part.length) { fs.appendFileSync(run.logPath, part); logged += part.length }
      }
      // The host's own output, read a line at a time for its session and for
      // what the agent is doing. The raw log above stays the full record.
      let pending = ''
      const decoder = new StringDecoder('utf8')
      let reported = 0
      let eventBytes = 0
      let compactAt = 4 * 1024 * 1024
      // Whether the agent got as far as saying or doing something. A host
      // reports a session it cannot continue as an error, which is not that.
      let spoke = false
      // Set when this attempt is given up for another: what it says after
      // that belongs to no turn.
      let superseded = false
      const report = (event: Omit<DeliveryEvent, 'at'>) => {
        if (superseded) return
        reported++
        if (event.kind !== 'error') spoke = true
        const line = `${JSON.stringify({ at: Date.now(), ...event })}\n`
        fs.appendFileSync(this.eventsFile(key), line)
        eventBytes += Buffer.byteLength(line)
        // Deltas replace activity items; do not retain an ever-growing series of full snapshots.
        if (eventBytes > compactAt) {
          const snapshot = this.events(run.workspaceId, key).map(event => JSON.stringify(event)).join('\n') + '\n'
          fs.writeFileSync(this.eventsFile(key), snapshot, { mode: 0o600 })
          eventBytes = Buffer.byteLength(snapshot); compactAt = Math.max(4 * 1024 * 1024, eventBytes * 2)
        }
      }
      // What the host records outside its output, followed once the session is known.
      const since = Date.now()
      let unfollow: (() => void) | undefined
      const session = (sessionId: string) => {
        if (sessionId && sessionId !== run.sessionId) { run.sessionId = sessionId; this.save(run); this.rememberSession(run) }
        if (sessionId && !unfollow && input.driver?.follow && !input.codex) {
          try {
            unfollow = input.driver.follow({
              sessionId, since, env: childEnv, report,
              note: text => { try { fs.appendFileSync(run.logPath, `\n[Ambio] ${text}\n`) } catch { /* the log is best effort */ } },
            })
          } catch { unfollow = () => {} }
        }
      }
      // A protocol agent is spoken with, not just listened to: the same lines are
      // the protocol, and the turn ends when the agent says it has.
      let acpStopReason: string | undefined
      let acpError: string | undefined
      const protocolTurn = {
        cwd: rootPath, prompt: input.prompt, mode: input.mode ?? 'build',
        send: (line: string) => { try { child.stdin?.write(`${line}\n`) } catch { /* close reports the failure */ } },
        onSession: session, onEvent: report,
      }
      const acp = input.muse ? new MuseClient({ ...protocolTurn, ...input.muse }) : !(attempt.acp && input.acp) ? undefined : new AcpClient({
        ...protocolTurn, ...input.acp, authentication: input.driver?.acpAuthentication,
        onUsage: usage => { run.usage = usage; this.save(run) },
      })
      let released = false
      const releaseQuestions = () => { if (!released) { released = true; void this.releaseQuestions(run).catch(() => {}) } }
      // Messages sent into a streaming host's turn, until it takes each in.
      const waiting = new Map<string, { text: string; resolve(): void; reject(error: Error): void }>()
      const codex = input.codex ? new CodexAppServer({
        ...protocolTurn, ...input.codex,
        onReady: ready => { run.canSteer = ready && run.state === 'running'; this.save(run) },
        onServer: version => { run.serverVersion = version; this.save(run) },
        onUsage: usage => { run.usage = usage; this.save(run) },
        approve: async (question, signal) => {
          if (input.mapping || run.state !== 'running' || signal.aborted) return false
          try {
            const asking = !!question.questions?.length
            const response = await daemonFetch(`${process.env.AMBIO_API_URL ?? 'http://127.0.0.1:7743'}/api/agent/permission`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(asking ? 605000 : 115000)]),
              body: JSON.stringify({ workspaceId: run.workspaceId, messageId: run.messageId, hostId: run.hostId, ...question, ...(asking ? { waitMs: 600000 } : {}) }),
            })
            if (!response.ok) return false
            const result = await response.json()
            if (!asking) return result.decision === 'allow'
            return result.decision === 'answer' && result.answers && typeof result.answers === 'object' ? { answers: result.answers } : false
          } catch { return false }
        },
      }) : undefined
      const protocol = codex ?? acp
      // Text the agent is still writing (DriverOutput.partial) is one activity
      // item, saved a few times a second as it grows and replaced in place by
      // the whole message, the same item identity a native protocol uses.
      let writing = '', writingId = '', writings = 0
      let writingTimer: ReturnType<typeof setTimeout> | undefined
      const flushWriting = () => {
        clearTimeout(writingTimer); writingTimer = undefined
        if (writing.trim()) report({ id: writingId, kind: 'text', text: writing.replace(/\s+/g, ' ').trim().slice(-1200), live: true })
      }
      const understand = (chunk: Buffer) => {
        if (!input.driver && !protocol) return
        pending += decoder.write(chunk)
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        if (pending.length > 1024 * 1024) pending = ''
        for (const line of lines) {
          if (protocol) { protocol.receive(line); continue }
          let read: ReturnType<AgentDriver['read']>
          try { read = input.driver!.read(line) } catch { continue }
          if (read.sessionId) session(read.sessionId)
          if (read.usage) { run.usage = read.usage; this.save(run) }
          if (read.partial && !superseded) {
            writingId ||= `live:${++writings}`
            writing = `${writing}${read.partial}`.slice(-4000)
            writingTimer ??= setTimeout(flushWriting, 250)
          }
          // A whole message replaces the text that was arriving piece by piece.
          let events = read.events
          if (writingId && (events.length || read.ended)) {
            clearTimeout(writingTimer); writingTimer = undefined
            const whole = events.findIndex(event => event.kind === 'text')
            if (whole >= 0) events = events.map((event, index) => index === whole ? { ...event, id: writingId } : event)
            else if (writing.trim()) report({ id: writingId, kind: 'text', text: writing.replace(/\s+/g, ' ').trim().slice(-1200) })
            writing = ''; writingId = ''
          }
          // A streaming host ends a stopped turn as an error; Stop already says what happened.
          for (const event of events) if (!(read.ended && event.kind === 'error' && input.driver!.stream && run.state === 'stopping')) report(event)
          const sent = read.delivered ? waiting.get(read.delivered) : undefined
          if (sent) { waiting.delete(read.delivered!); report({ kind: 'sent', text: sent.text.replace(/\s+/g, ' ').trim().slice(0, 1200) }); sent.resolve() }
          // What was already sent is still answered; nothing more is taken.
          if (read.ended) this.streams.get(key)?.close()
        }
      }
      // Some hosts explain a turn that went nowhere on their error output.
      let pendingError = ''
      const understandError = (chunk: Buffer) => {
        if (!input.driver?.readError) return
        pendingError += chunk.toString('utf8')
        const lines = pendingError.split(/\r?\n/)
        pendingError = (lines.pop() ?? '').slice(-65536)
        for (const line of lines) {
          try { for (const event of input.driver.readError(line).events) report(event) } catch { /* not something this driver reads */ }
        }
      }
      child.stdout?.on('data', chunk => { output(chunk); understand(chunk) }); child.stderr?.on('data', chunk => { output(chunk); understandError(chunk) })
      child.stdin?.on('error', () => { /* An early host exit is reported by close. */ })
      child.once('error', error => {
        if (run.state === 'starting') fail(error)
        else { run.state = 'failed'; run.detail = `Agent process failed: ${error.message}`; this.save(run) }
      })
      child.once('spawn', async () => {
        run.pid = child.pid; run.state = 'running'; run.detail = 'Agent launched. Waiting for its claim and reply.'; this.save(run)
        if (input.mapping && child.pid) {
          run.processIdentity = await processStartIdentity(child.pid)
          if (!this.live.has(key)) { settle(); return }
          this.save(run)
        }
        if (protocol) {
          if (codex) this.codex.set(key, codex)
          else this.acp.set(key, acp!)
          // The agent stays up between turns; its part in this one is over
          // when the prompt returns, so it is then asked to leave.
          const finish = () => { this.acp.delete(key); this.codex.delete(key); try { child.stdin?.end() } catch { /* already gone */ }; setTimeout(() => { if (this.live.has(key)) child.kill() }, 3000).unref() }
          protocol.run().then(outcome => {
            acpStopReason = outcome.stopReason
            if (run.resumed !== outcome.resumed) { run.resumed = outcome.resumed; this.save(run) }
            finish()
          }, error => {
            acpError = error instanceof Error ? error.message : String(error)
            report({ kind: 'error', text: acpError })
            finish()
          })
        } else if (input.driver?.stream) {
          const stream = input.driver.stream
          let open = true
          const write = (line: string) => { try { child.stdin?.write(`${line}\n`) } catch { /* close reports the failure */ } }
          // The turn is over (or stopped): nothing it asked can be answered now.
          const close = () => { if (!open) return; open = false; this.streams.delete(key); if (run.canSteer) { run.canSteer = false; this.save(run) }; releaseQuestions(); try { child.stdin?.end() } catch { /* already gone */ } }
          run.canSteer = true; this.save(run)
          this.streams.set(key, {
            send: (id, text) => new Promise<void>((resolve, reject) => {
              if (!open) { reject(new Error('This turn has finished. Send it as the next turn.')); return }
              waiting.set(id, { text, resolve, reject })
              try { fs.appendFileSync(run.logPath, `\n[Ambio] Sent into this turn: ${text}\n`) } catch { /* the log is best effort */ }
              write(stream.message(text, id))
            }),
            interrupt: () => { if (open) write(stream.interrupt()); close() },
            close,
          })
          child.stdin?.write(attempt.stdin ?? '')
        } else child.stdin?.end(attempt.stdin)
        settle()
      })
      child.once('close', async (code, signal) => {
        try {
        if (mappingTimer) clearInterval(mappingTimer)
        // A last line with no newline is still something the agent said.
        pending += decoder.end()
        if (pending) understand(Buffer.from('\n'))
        if (pendingError) understandError(Buffer.from('\n'))
        unfollow?.()
        acp?.close()
        codex?.close()
        releaseQuestions()
        this.acp.delete(key)
        this.streams.get(key)?.close()
        for (const message of waiting.values()) message.reject(new Error('The agent exited before it took this message in.'))
        waiting.clear()
        clearTimeout(writingTimer)
        this.codex.delete(key)
        this.live.delete(key)
        if (input.mapping) {
          try {
            await this.terminating.get(key)
            const attempt = await mappingAttemptState(run.workspaceId, input.mapping.attempt.id, 'settle')
            run.state = attempt.state === 'submitted' ? 'completed' : 'stopped'
            run.detail = attempt.state === 'submitted' ? 'Mapping submitted. The agent session is closed.' : 'Mapping stopped before submission.'
          } catch { run.state = 'interrupted'; run.detail = 'The agent exited, but its mapping session could not be settled. Reconnect before reviewing.' }
          this.save(run)
          return
        }
        if (run.state === 'launch-failed') return
        if (run.state === 'stopping') {
          run.state = 'stopped'; run.detail = 'Agent process stopped. Edits already made are kept; this does not cancel the work order.'
        } else if (codex) {
          run.canSteer = false
          run.state = acpStopReason === 'completed' ? 'completed' : acpStopReason === 'interrupted' ? 'stopped' : 'failed'
          run.detail = acpStopReason === 'completed' ? 'Codex finished its turn. Its canvas reply determines whether the result is ready for review.'
            : acpError ?? `Codex ${acpStopReason ?? 'exited before completing its turn'}. No turn was retried. Check its output before sending again.`
        } else if (attempt.resumed && code !== 0 && !spoke && input.fresh) {
          // The session could not be continued (expired, removed, or made by
          // another version). Nothing was said, so nothing is lost by starting
          // the same turn fresh: Ambio still hands it the conversation.
          this.forgetSession(run)
          const fresh = input.fresh()
          superseded = true
          run.resumed = false; run.sessionId = fresh.sessionId; run.state = 'starting'; run.detail = 'The earlier session could not be continued. Starting fresh…'
          this.save(run); this.rememberSession(run)
          fs.writeFileSync(this.eventsFile(key), '', { mode: 0o600 })
          fs.appendFileSync(run.logPath, '\n[Ambio] The earlier session could not be continued; starting this turn fresh.\n')
          this.launch(input, run, { args: fresh.args, stdin: fresh.stdin, resumed: false }, settle, fail)
          return
        } else if (acp && acpStopReason === undefined && !spoke && input.fresh) {
          // The agent could not hold an ACP session at all (an older version,
          // a preview turned off). Its print mode still can run the turn.
          const fresh = input.fresh()
          superseded = true
          run.resumed = false; run.sessionId = fresh.sessionId; run.state = 'starting'; run.detail = 'Starting the agent in print mode…'
          this.save(run)
          fs.writeFileSync(this.eventsFile(key), '', { mode: 0o600 })
          fs.appendFileSync(run.logPath, `\n[Ambio] The agent session could not start${acpError ? ` (${acpError})` : ''}; running this turn in print mode.\n`)
          this.launch(input, run, { args: fresh.args, stdin: fresh.stdin, resumed: false }, settle, fail)
          return
        } else if (acp) {
          // An ACP agent is told to leave when its turn is over, so how the
          // process ended says nothing; how the turn ended does.
          const done = acpStopReason === 'end_turn'
          run.state = done ? 'completed' : 'failed'
          run.detail = done ? 'Agent finished its turn. Its canvas reply determines whether the result is ready for review.'
            : acpError ? `The agent could not run this turn: ${acpError}`
              : acpStopReason ? `The agent stopped early (${acpStopReason}). The work order remains in the inbox.`
                : `Agent exited ${signal ?? code} before finishing the turn. Check its output; the work order remains in the inbox.`
        } else {
          // A host can exit cleanly having been stopped from doing anything;
          // when it said so and nothing else, that is a failed turn.
          const blocked = code === 0 && !spoke && reported > 0
          run.state = code === 0 && !blocked ? 'completed' : 'failed'
          run.detail = blocked ? 'The agent could not do this turn. See the message under it; the work order remains in the inbox.'
            : code === 0 ? 'Agent process finished. Its canvas reply determines whether the result is ready for review.' : `Agent exited ${signal ?? code}. Check its output; the work order remains in the inbox.`
        }
        this.save(run)
        } finally {
          resolveFinished()
          if (this.finished.get(key) === finished) this.finished.delete(key)
        }
      })
    }
  }
  async stop(workspaceId: string, key: string): Promise<void> {
    const entry = this.live.get(key)
    if (!entry || entry.run.workspaceId !== workspaceId) throw new Error('This run is no longer controlled by Ambio. Check the agent separately.')
    let revokeError: unknown
    if (entry.run.mappingAttemptId) {
      try { await mappingAttemptState(workspaceId, entry.run.mappingAttemptId, 'cancel') } catch (error) { revokeError = error }
      if (!this.live.has(key)) { await this.finished.get(key); return }
    }
    // An ACP agent is asked to stop the turn before its process is stopped.
    entry.run.state = 'stopping'; entry.run.detail = 'Stop requested. Waiting for the agent process to exit.'; this.save(entry.run)
    this.acp.get(key)?.cancel()
    const codex = this.codex.get(key)
    codex?.cancel()
    if (codex) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([this.finished.get(key), new Promise(resolve => { timer = setTimeout(resolve, 1500) })]) }
      finally { clearTimeout(timer) }
    }
    // A streaming host stops its own turn and leaves, which keeps its session
    // whole; it is ended only if it has not gone within a few seconds.
    const stream = this.streams.get(key)
    const finishing = this.finished.get(key)
    let left = false
    if (stream && finishing && !entry.run.mappingAttemptId) {
      stream.interrupt()
      let timer: ReturnType<typeof setTimeout> | undefined
      left = await Promise.race([finishing.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), STREAM_STOP_GRACE) })])
      if (timer) clearTimeout(timer)
    }
    if (!left && this.live.has(key) && entry.child.pid) {
      const termination = this.terminate(entry.child.pid, !!entry.run.mappingAttemptId)
      this.terminating.set(key, termination)
      try { await termination } finally { this.terminating.delete(key) }
    }
    const finished = this.finished.get(key)
    if (finished) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([finished, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The agent has not stopped yet. Review remains locked.')), 10000) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    if (revokeError) throw revokeError
  }
  private async terminate(pid: number, force: boolean): Promise<void> {
    if (process.platform === 'win32') await new Promise<void>((resolve, reject) => {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true })
      killer.once('close', () => resolve()); killer.once('error', reject)
    })
    else { try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
  }
  async stopAll(): Promise<void> { await Promise.allSettled([...this.live].map(([key, { run }]) => this.stop(run.workspaceId, key))) }
}
