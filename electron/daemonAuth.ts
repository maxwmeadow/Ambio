import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export function daemonDataDir(): string {
  return process.env.AXIOM_ACTIVE_PROJECT ? dirname(process.env.AXIOM_ACTIVE_PROJECT) : join(homedir(), '.axiom', 'data')
}

export function daemonTokenPath(): string {
  return process.env.AXIOM_API_TOKEN_FILE ?? join(daemonDataDir(), 'api-token')
}

const DEFAULT_API_PORT = '7743'

/** The API port archd published in daemon.json, if it is running. */
function publishedApiPort(): string | null {
  try {
    const info = JSON.parse(fs.readFileSync(join(daemonDataDir(), 'daemon.json'), 'utf8')) as { apiPort?: unknown }
    return typeof info.apiPort === 'number' && info.apiPort > 0 ? String(info.apiPort) : null
  } catch { return null }
}

/**
 * archd falls back to another port when a different program holds 7743. A
 * request aimed at the default port follows it there; an explicitly
 * configured address (AXIOM_API_URL, test harnesses) is left alone.
 */
export function resolveDaemonUrl(input: string | URL): URL {
  const url = new URL(input)
  if (url.port !== DEFAULT_API_PORT) return url
  const published = publishedApiPort()
  if (published && published !== url.port) url.port = published
  return url
}

const NOT_RUNNING = 'Axiom is not running. Open the Axiom app, then try again.'

export function readDaemonToken(): string {
  let raw: string
  try {
    raw = process.env.AXIOM_API_TOKEN ?? fs.readFileSync(daemonTokenPath(), 'utf8')
  } catch {
    throw new DaemonUnavailableError(NOT_RUNNING)
  }
  const token = raw.trim()
  if (token.length < 32) throw new DaemonUnavailableError('Axiom local API token is missing or invalid. Start the Axiom desktop application.')
  return token
}

/** archd could not be reached: not running, still starting, or never started. */
export class DaemonUnavailableError extends Error {}

function isUnreachable(error: unknown): boolean {
  if (error instanceof DaemonUnavailableError) return true
  // Node's fetch reports a refused or dropped connection as TypeError with the
  // socket error as its cause; a timeout is an AbortError and is not retried.
  if (!(error instanceof TypeError) || error.message !== 'fetch failed') return false
  const code = (error as { cause?: { code?: string } }).cause?.code
  return code === undefined || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET'
}

let starting: Promise<void> | null = null

/**
 * Start archd headless for an agent while the Axiom app is closed. Only the
 * packaged launcher (`archd mcp-run`) says where archd is; anywhere else the
 * agent is told to open Axiom. One start is shared by concurrent requests, and
 * a second MCP server racing this one simply finds the first daemon answering.
 */
export function ensureDaemon(origin: string, timeoutMs = 10_000): Promise<void> {
  const archd = process.env.AXIOM_ARCHD_PATH
  if (!archd || !fs.existsSync(archd)) return Promise.reject(new DaemonUnavailableError(NOT_RUNNING))
  starting ??= (async () => {
    try {
      const child = spawn(archd, ['-data', daemonDataDir(), '-headless', '-auto-ports'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200))
        try {
          const token = readDaemonToken()
          await globalThis.fetch(resolveDaemonUrl(`${origin}/api/daemon/info`), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(1000),
          })
          return
        } catch { /* still starting */ }
      }
      throw new DaemonUnavailableError(`Axiom's background service did not start. ${NOT_RUNNING}`)
    } finally {
      starting = null
    }
  })()
  return starting
}

export async function daemonFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Axiom daemon must use a loopback HTTP address')
  const attempt = () => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${readDaemonToken()}`)
    return globalThis.fetch(resolveDaemonUrl(url), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15000) })
  }
  try {
    return await attempt()
  } catch (error) {
    if (!isUnreachable(error)) throw error
    await ensureDaemon(url.origin)
    return attempt()
  }
}
