import fs from 'fs'
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import type { HostConfigurationStatus } from './agentInstallers.ts'

/**
 * Testing an agent connection, from Ambio's side.
 *
 * Ambio cannot ask an agent to call a tool: every host starts the MCP server
 * itself and nothing lets another program drive its chat. What can be checked
 * is everything the agent depends on: that its configuration names this
 * install, that the workflow files are in place, and that the tool server it
 * would launch starts and lists its tools. Whether the agent is talking to
 * Ambio right now is a separate fact, read from presence by the renderer.
 */

export interface ConnectionCheck {
  id: 'configured' | 'current' | 'workflow' | 'server'
  label: string
  state: 'pass' | 'fail'
  detail: string
}

export interface ConnectionTestResult {
  ok: boolean
  checks: ConnectionCheck[]
  testedAt: number
}

export interface ProbeResult {
  ok: boolean
  tools: number
  detail: string
}

/** Whether a configuration file's text names this install's MCP server. */
export function configNamesServer(text: string, serverPath: string): boolean {
  const forward = serverPath.replaceAll('\\', '/')
  const back = serverPath.replaceAll('/', '\\')
  // JSON and TOML write a Windows path with doubled backslashes.
  const variants = new Set([serverPath, forward, back, back.replaceAll('\\', '\\\\')])
  const haystack = text.toLowerCase()
  return [...variants].some(variant => haystack.includes(variant.toLowerCase()))
}

type Spawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean }) => ChildProcess

/**
 * Start the MCP server the way an agent does and ask it for its tools.
 * AMBIO_SELF_TEST keeps the probe out of presence, so a test never shows up
 * as a connected agent.
 */
export function probeMcpServer(command: string, args: string[], timeoutMs = 15_000, spawn: Spawn = nodeSpawn as Spawn): Promise<ProbeResult> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(command, args, { env: { ...process.env, AMBIO_SELF_TEST: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ ok: false, tools: 0, detail: `Could not start the tool server: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let settled = false
    let buffer = ''
    let errors = ''
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already gone */ }
      resolve(result)
    }
    const lastError = () => errors.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    const timer = setTimeout(() => finish({
      ok: false, tools: 0,
      detail: `The tool server did not answer within ${Math.round(timeoutMs / 1000)} seconds.${lastError() ? ` ${lastError()}` : ''}`,
    }), timeoutMs)
    const send = (message: unknown) => { child.stdin?.write(JSON.stringify(message) + '\n') }

    child.on('error', error => finish({ ok: false, tools: 0, detail: `Could not start the tool server: ${error.message}` }))
    child.on('close', code => finish({
      ok: false, tools: 0,
      detail: `The tool server stopped before answering (exit ${code ?? 'unknown'}).${lastError() ? ` ${lastError()}` : ''}`,
    }))
    child.stdin?.on('error', () => { /* reported by exit */ })
    child.stderr?.on('data', chunk => { errors = (errors + String(chunk)).slice(-2000) })
    child.stdout?.on('data', chunk => {
      buffer += String(chunk)
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let message: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } }
        try { message = JSON.parse(line) } catch { continue }
        if (message.error) {
          finish({ ok: false, tools: 0, detail: `The tool server answered with an error: ${message.error.message ?? 'unknown'}` })
        } else if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 2) {
          const tools = message.result?.tools?.length ?? 0
          finish(tools > 0
            ? { ok: true, tools, detail: `Started and listed ${tools} tools.` }
            : { ok: false, tools: 0, detail: 'The tool server started but listed no tools.' })
        }
      }
    })
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ambio-connection-test', version: '1' } },
    })
  })
}

/** The checks that read files: is Ambio installed for this agent, and is the install current. */
export function configurationChecks(
  label: string,
  status: HostConfigurationStatus,
  serverPath: string,
  readText: (path: string) => string = path => fs.readFileSync(path, 'utf8'),
): ConnectionCheck[] {
  const checks: ConnectionCheck[] = []
  if (status.unreadablePaths.length > 0) {
    checks.push({ id: 'configured', label: 'Configuration', state: 'fail', detail: `Could not read ${status.unreadablePaths.join(', ')}. Fix or remove the file, then repair.` })
  } else if (!status.configured) {
    checks.push({ id: 'configured', label: 'Configuration', state: 'fail', detail: `Ambio is not in ${label}'s configuration. Install it first.` })
  } else {
    checks.push({ id: 'configured', label: 'Configuration', state: 'pass', detail: `Ambio is in ${status.configuredPaths.join(', ')}.` })
    const stale = status.configuredPaths.filter(path => {
      try { return !configNamesServer(readText(path), serverPath) } catch { return true }
    })
    checks.push(stale.length === 0
      ? { id: 'current', label: 'Points at this Ambio', state: 'pass', detail: 'The configuration starts this install.' }
      : { id: 'current', label: 'Points at this Ambio', state: 'fail', detail: `${stale.join(', ')} starts a different or moved Ambio. Repair rewrites it.` })
  }
  if (status.configured) {
    checks.push(status.workflowInstalled
      ? { id: 'workflow', label: 'Workflows and rules', state: 'pass', detail: 'Ambio\'s workflow and rule files are in place.' }
      : { id: 'workflow', label: 'Workflows and rules', state: 'fail', detail: 'Some of Ambio\'s workflow or rule files are missing. Repair writes them again.' })
  }
  return checks
}
