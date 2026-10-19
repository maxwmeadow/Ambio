import fs from 'node:fs'
import os from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { detectEditors } from './fileAccess.ts'
import { resolveNodeCommand } from './platformPaths.ts'
import type { DeliveryEvent, DeliveryHost, DeliveryRun } from '../src/shared/agentDelivery.ts'
import { DRIVER_CLI_NAMES, agentDriver, type AgentDriver, type DriverPlan, type TurnMode } from './agentDrivers.ts'
import { AcpClient, type AcpMcpServer } from './acpClient.ts'
import { hiddenConsoleStdio } from './hiddenConsole.ts'

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
}

/** The script an installed npm package runs for its command, if it is there. */
function npmEntry(packageDir: string, pkg: { bin: string; entry: string }): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(join(packageDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
    const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[pkg.bin]
    if (declared) {
      const script = join(packageDir, declared)
      if (fs.existsSync(script) && fs.statSync(script).isFile()) return script
    }
  } catch { /* no manifest: try the entry it used to have */ }
  const legacy = join(packageDir, pkg.entry)
  return fs.existsSync(legacy) && fs.statSync(legacy).isFile() ? legacy : undefined
}

function environmentPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path')
  return key ? env[key] ?? '' : ''
}

function executable(file: string): boolean {
  try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}

/** Resolve known CLIs, including native installs and npm's Windows JS entrypoints.
 * Never invoke a .cmd shim through a shell with a human-authored prompt. */
export function findDeliveryCli(hostId: string, env = process.env, platform = process.platform, home = os.homedir(), node = process.execPath): DeliveryLauncher | undefined {
  const names = CLI_NAMES[hostId]
  if (!names) return undefined
  const dirs = [...environmentPath(env).split(delimiter).filter(Boolean), join(home, '.local', 'bin'), join(home, '.volta', 'bin'), join(home, '.asdf', 'shims'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const versions of [join(home, '.nvm', 'versions', 'node'), join(home, '.asdf', 'installs', 'nodejs')]) {
    try { dirs.push(...fs.readdirSync(versions).sort().reverse().map(version => join(versions, version, 'bin'))) } catch { /* manager not installed */ }
  }
  if (platform === 'win32') dirs.push(join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'))
  for (const dir of dirs) {
    for (const name of names) {
      // A name that carries its own extension is that file on every platform.
      const command = join(dir, platform === 'win32' && !name.includes('.') ? `${name}.exe` : name)
      if (executable(command)) return { command, args: [] }
    }
  }
  const pkg = NPM_PACKAGES[hostId]
  if (!pkg) return undefined
  const npmDirs = [...dirs.map(dir => join(dir, 'node_modules')), join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'node_modules'), '/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules']
  for (const dir of npmDirs) {
    const script = npmEntry(join(dir, pkg.name), pkg)
    if (script) return { command: node, args: [script], bundledNode: true }
  }
  return undefined
}

/** All installed modalities remain visible, even when a host has no public chat API. */
export function deliveryTargets(hosts: { id: string; label: string }[], env = process.env, platform = process.platform, home = os.homedir()): DeliveryTarget[] {
  const editors = detectEditors(env, platform, home)
  const editorId: Record<string, string[]> = { copilot: ['vscode'], cursor: ['cursor'], windsurf: ['windsurf'], jetbrains: ['intellij', 'webstorm', 'pycharm', 'goland'], zed: ['zed'] }
  // An editor's own terminal agent is a second way to reach the same host: it
  // can be started for a turn, where the editor's chat can only be pasted into.
  const companions: DeliveryTarget[] = []
  if (hosts.some(host => host.id === 'cursor')) {
    const launcher = findDeliveryCli('cursor-cli', env, platform, home)
    if (launcher) companions.push({ id: 'cursor-cli', label: 'Cursor CLI', route: 'run', available: true, launcher, detail: 'Cursor\u2019s terminal agent, started by Ambio in this project.' })
  }
  for (const [editor, id, label] of [['windsurf', 'devin-cli', 'Devin CLI'], ['antigravity', 'antigravity-acp', 'Antigravity agent']] as const) {
    if (!hosts.some(host => host.id === editor)) continue
    const launcher = findDeliveryCli(id, env, platform, home)
    if (launcher) companions.push({ id, label, route: 'run', available: true, launcher, detail: `${label}, started by Ambio in this project.` })
  }
  if (hosts.some(host => host.id === 'antigravity')) {
    const launcher = findDeliveryCli('antigravity-cli', env, platform, home)
    if (launcher) companions.push({ id: 'antigravity-cli', label: 'Antigravity CLI', route: 'run', available: true, launcher, detail: 'Antigravity\u2019s terminal agent, started by Ambio in this project.' })
  }
  return [...hosts.map(({ id, label }) => {
    const host = { id, label }
    if (CLI_NAMES[host.id]) {
      const launcher = findDeliveryCli(host.id, env, platform, home)
      return { ...host, route: 'run', available: !!launcher, launcher, detail: launcher ? 'Start a new run in this project. Host permissions still apply.' : 'CLI executable not found. Install it or use copy handoff.' } as DeliveryTarget
    }
    let launcher: DeliveryLauncher | undefined
    const editor = editors.find(item => editorId[host.id]?.includes(item.id))
    if (editor) launcher = { command: editor.command, args: [] }
    if (host.id === 'antigravity' && platform !== 'win32') {
      const command = [...(env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/local/bin'].map(dir => join(dir, 'antigravity')).find(executable)
      if (command) launcher = { command, args: [] }
    }
    if (host.id === 'claude-desktop' && platform === 'darwin') {
      const app = ['/Applications/Claude.app', join(home, 'Applications', 'Claude.app')].find(file => fs.existsSync(file))
      if (app) launcher = { command: '/usr/bin/open', args: ['-a', app] }
    }
    return { ...host, route: launcher ? 'open' : 'copy', available: true, launcher, detail: launcher ? 'Copy the handoff and open this host. Paste it into the chat you choose.' : 'Copy the handoff, then paste it into this host’s chat. No supported launcher was found.' } as DeliveryTarget
  }), ...companions]
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
export function deliveryPlan(hostId: string, mcp: DeliveryLauncher, workspaceId: string, prompt: string, turn: { mode?: TurnMode; resume?: string; messageId?: string; cwd?: string; model?: string } = {}): DriverPlan {
  const driver = agentDriver(hostId)
  if (!driver) throw new Error('This host has no direct delivery route.')
  return driver.plan({ hostId, mcp, workspaceId, prompt, mode: turn.mode ?? 'build', resume: turn.resume, messageId: turn.messageId, cwd: turn.cwd, model: turn.model })
}

export function deliveryArguments(hostId: string, mcp: DeliveryLauncher, workspaceId: string, prompt: string, turn: { mode?: TurnMode; resume?: string; messageId?: string; cwd?: string; model?: string } = {}): string[] {
  return deliveryPlan(hostId, mcp, workspaceId, prompt, turn).args
}

export interface RunInput {
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
  acp?: { mcpServers: AcpMcpServer[]; resume?: string; askUser?: (question: { title: string; detail: string; kind: string }) => Promise<boolean> }
}

/** How many events a run keeps for the inbox to show. */
const EVENT_LIMIT = 400

export function checkDeliveryMessage(message: { id?: string; workspaceId?: string; deliveryMode?: string; status?: string; leaseExpiresAt?: number }, workspaceId: string, messageId: string, now = Date.now()): void {
  if (message.id !== messageId || message.workspaceId !== workspaceId) throw new Error('This work order belongs to another project.')
  if (message.deliveryMode !== 'addressed' || !['queued', 'delivered'].includes(message.status ?? '')) throw new Error('This work order is closed or is not an addressed request.')
  if ((message.leaseExpiresAt ?? 0) > now) throw new Error('An agent already holds this request. Wait for its reply or stop that agent before handing it off again.')
}

/** Launch receipts are written before spawn. A retry after a crash never silently
 * executes the same request again. MCP claims still fence replies across hosts. */
export class DeliveryRunner {
  private live = new Map<string, { child: ChildProcess; run: DeliveryRun }>()
  private acp = new Map<string, AcpClient>()
  private directory: string
  private spawnProcess: typeof spawn
  constructor(directory: string, spawnProcess: typeof spawn = spawn) {
    this.directory = directory
    this.spawnProcess = spawnProcess
  }

  private file(key: string): string { return join(this.directory, `${key}.json`) }
  private eventsFile(key: string): string { return join(this.directory, `${key}.events.jsonl`) }
  private sessionsFile(): string { return join(this.directory, 'sessions.json') }
  private sessions(): Record<string, string> {
    try { const value = JSON.parse(fs.readFileSync(this.sessionsFile(), 'utf8')); return value && typeof value === 'object' ? value : {} } catch { return {} }
  }
  private sessionKey(workspaceId: string, threadId: string, hostId: string): string { return JSON.stringify([workspaceId, threadId, hostId]) }
  /** The host session an earlier turn of this conversation ran in, if any. */
  session(workspaceId: string, threadId: string | undefined, hostId: string): string | undefined {
    return threadId ? this.sessions()[this.sessionKey(workspaceId, threadId, hostId)] : undefined
  }
  private rememberSession(run: DeliveryRun): void {
    if (!run.threadId || !run.sessionId) return
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
      return fs.readFileSync(this.eventsFile(key), 'utf8').split('\n').filter(Boolean).slice(Math.max(0, after))
        .flatMap(line => { try { return [JSON.parse(line) as DeliveryEvent] } catch { return [] } })
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
        const run = JSON.parse(fs.readFileSync(join(this.directory, name), 'utf8')) as DeliveryRun
        if (run.workspaceId !== workspaceId) return []
        if (['starting', 'running', 'stopping'].includes(run.state) && !this.live.has(run.key)) return [{ ...run, state: 'interrupted' as const, detail: 'Ambio restarted during this run. Check the agent and its output before handing off again.' }]
        return [run]
      } catch { return [] }
    })
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
      key, workspaceId: input.workspaceId, messageId: input.messageId, revision: input.revision, hostId: input.hostId, rootPath, state: 'starting', detail: 'Starting agent…', logPath: join(this.directory, `${key}.log`), startedAt: Date.now(),
      ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.mode ? { mode: input.mode } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.resumed ? { resumed: true } : {}),
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
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, AMBIO_WORKSPACE_ID: input.workspaceId, AMBIO_AGENT_HOST: input.hostId }
        // A GUI app's PATH may omit the directory of its resolved CLI or Node.
        const node = resolveNodeCommand()
        const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH'
        env[pathKey] = [dirname(input.launcher.command), ...(isAbsolute(node) ? [dirname(node)] : []), ...environmentPath(env).split(delimiter)].join(delimiter)
        if (input.launcher.bundledNode) env.ELECTRON_RUN_AS_NODE = '1'
        else delete env.ELECTRON_RUN_AS_NODE
        child = this.spawnProcess(input.launcher.command, [...input.launcher.args, ...attempt.args], { cwd: rootPath, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: hiddenConsoleStdio(['pipe', 'pipe', 'pipe']) })
      } catch (error) { fail(error as Error); return }
      this.live.set(key, { child, run })
      let logged = 0
      const output = (chunk: Buffer) => {
        const part = chunk.subarray(0, Math.max(0, 1024 * 1024 - logged))
        if (part.length) { fs.appendFileSync(run.logPath, part); logged += part.length }
      }
      // The host's own output, read a line at a time for its session and for
      // what the agent is doing. The raw log above stays the full record.
      let pending = ''
      let reported = 0
      // Whether the agent got as far as saying or doing something. A host
      // reports a session it cannot continue as an error, which is not that.
      let spoke = false
      // Set when this attempt is given up for another: what it says after
      // that belongs to no turn.
      let superseded = false
      const report = (event: Omit<DeliveryEvent, 'at'>) => {
        if (superseded || reported >= EVENT_LIMIT) return
        reported++
        if (event.kind !== 'error') spoke = true
        fs.appendFileSync(this.eventsFile(key), `${JSON.stringify({ at: Date.now(), ...event })}\n`)
      }
      const session = (sessionId: string) => {
        if (sessionId && sessionId !== run.sessionId) { run.sessionId = sessionId; this.save(run); this.rememberSession(run) }
      }
      // An ACP agent is spoken with, not just listened to: the same lines are
      // the protocol, and the turn ends when the agent says it has.
      let acpStopReason: string | undefined
      let acpError: string | undefined
      const acp = !(attempt.acp && input.acp) ? undefined : new AcpClient({
        cwd: rootPath, prompt: input.prompt, mode: input.mode ?? 'build', mcpServers: input.acp.mcpServers, resume: input.acp.resume, askUser: input.acp.askUser,
        send: line => { try { child.stdin?.write(`${line}\n`) } catch { /* the close handler reports an agent that has gone */ } },
        onSession: session, onEvent: report,
      })
      const understand = (chunk: Buffer) => {
        if (!input.driver && !acp) return
        pending += chunk.toString('utf8')
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        if (pending.length > 1024 * 1024) pending = ''
        for (const line of lines) {
          if (acp) { acp.receive(line); continue }
          let read: ReturnType<AgentDriver['read']>
          try { read = input.driver!.read(line) } catch { continue }
          if (read.sessionId) session(read.sessionId)
          for (const event of read.events) report(event)
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
      child.once('spawn', () => {
        run.pid = child.pid; run.state = 'running'; run.detail = 'Agent launched. Waiting for its claim and reply.'; this.save(run)
        if (acp) {
          this.acp.set(key, acp)
          // The agent stays up between turns; its part in this one is over
          // when the prompt returns, so it is then asked to leave.
          const finish = () => { this.acp.delete(key); try { child.stdin?.end() } catch { /* already gone */ }; setTimeout(() => { if (this.live.has(key)) child.kill() }, 3000).unref() }
          acp.run().then(outcome => {
            acpStopReason = outcome.stopReason
            if (run.resumed !== outcome.resumed) { run.resumed = outcome.resumed; this.save(run) }
            finish()
          }, error => {
            acpError = error instanceof Error ? error.message : String(error)
            report({ kind: 'error', text: acpError })
            finish()
          })
        } else child.stdin?.end(attempt.stdin)
        settle()
      })
      child.once('close', (code, signal) => {
        // A last line with no newline is still something the agent said.
        if (pending) understand(Buffer.from('\n'))
        if (pendingError) understandError(Buffer.from('\n'))
        acp?.close()
        this.acp.delete(key)
        this.live.delete(key)
        if (run.state === 'launch-failed') return
        if (run.state === 'stopping') {
          run.state = 'stopped'; run.detail = 'Agent process stopped. Edits already made are kept; this does not cancel the work order.'
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
      })
    }
  }
  stop(workspaceId: string, key: string): void {
    const entry = this.live.get(key)
    if (!entry || entry.run.workspaceId !== workspaceId) throw new Error('This run is no longer controlled by Ambio. Check the agent separately.')
    // An ACP agent is asked to stop the turn before its process is stopped.
    this.acp.get(key)?.cancel()
    if (entry.child.pid) {
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(entry.child.pid), '/T', '/F'], { shell: false, windowsHide: true })
        killer.on('error', () => entry.child.kill())
      } else process.kill(-entry.child.pid, 'SIGTERM')
    }
    entry.run.state = 'stopping'; entry.run.detail = 'Stop requested. Waiting for the agent process to exit.'; this.save(entry.run)
  }
  stopAll(): void { for (const [key, { run }] of this.live) { try { this.stop(run.workspaceId, key) } catch { /* already exited */ } } }
}
