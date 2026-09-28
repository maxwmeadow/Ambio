import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export function daemonTokenPath(): string {
  return process.env.AXIOM_API_TOKEN_FILE ?? join(
    process.env.AXIOM_ACTIVE_PROJECT ? dirname(process.env.AXIOM_ACTIVE_PROJECT) : join(homedir(), '.axiom', 'data'),
    'api-token',
  )
}
export function readDaemonToken(): string {
  const token = (process.env.AXIOM_API_TOKEN ?? fs.readFileSync(daemonTokenPath(), 'utf8')).trim()
  if (token.length < 32) throw new Error('Axiom local API token is missing or invalid. Start the Axiom desktop application.')
  return token
}
export async function daemonFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Axiom daemon must use a loopback HTTP address')
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${readDaemonToken()}`)
  return globalThis.fetch(input, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15000) })
}
