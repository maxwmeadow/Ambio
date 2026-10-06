import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChatProviders } from './chatProviders.ts'

/** The harness gets a short-lived local token. Real service credentials stay
 * in Electron, outside the agent's environment and tools. */
export class ChatProviderProxy {
  token = randomBytes(32).toString('hex')
  private server?: Server
  private origin = ''
  private providers: ChatProviders
  private request: typeof fetch
  constructor(providers: ChatProviders, request: typeof fetch = fetch) { this.providers = providers; this.request = request }
  async start(): Promise<string> {
    if (this.origin) return this.origin
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const presented = req.headers.authorization?.replace(/^Bearer /, '') ?? req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? url.searchParams.get('key') ?? ''
      const candidate = Buffer.from(String(presented))
      if (candidate.length !== this.token.length || !timingSafeEqual(candidate, Buffer.from(this.token))) { res.writeHead(401).end(); return }
      const match = url.pathname.match(/^\/([a-f0-9-]{36})(\/.*)$/)
      if (!match || !['GET', 'POST'].includes(req.method ?? '')) { res.writeHead(404).end(); return }
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      try {
        const profile = this.providers.get(match[1])
        const key = this.providers.key(profile.id)
        if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(profile.baseUrl).hostname)) { res.writeHead(401).end('Reconnect your model service in Ambio.'); return }
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (profile.kind === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = String(req.headers['anthropic-version'] ?? '2023-06-01'); if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta']) }
        else if (profile.kind === 'google') headers['x-goog-api-key'] = key
        else if (key) headers.Authorization = `Bearer ${key}`
        url.searchParams.delete('key')
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('Request is too large.'); chunks.push(chunk) }
        const upstream = await this.request(`${profile.baseUrl}${match[2]}${url.search}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined, redirect: 'error', signal: abort.signal })
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
        if (upstream.body) {
          const reader = upstream.body.getReader()
          // A service error can echo its authentication header. Redact before
          // the harness can persist it, including keys split between chunks.
          const decoder = new TextDecoder(); let pending = ''
          const write = async (value: string) => {
            if (!value || res.destroyed) return
            if (!res.write(value)) await new Promise<void>(resolve => {
              const done = () => { res.off('drain', done); res.off('close', done); resolve() }
              res.once('drain', done); res.once('close', done)
            })
          }
          try {
            for (;;) {
              const { done, value } = await reader.read()
              pending += decoder.decode(value, { stream: !done })
              if (key) pending = pending.split(key).join('[redacted]')
              let held = 0
              if (!done && key) for (let length = 1; length < key.length && length <= pending.length; length++) if (pending.endsWith(key.slice(0, length))) held = length
              await write(pending.slice(0, pending.length - held)); pending = held ? pending.slice(-held) : ''
              if (done) break
            }
          }
          finally { reader.releaseLock() }
        }
        res.end()
      } catch { if (!res.headersSent) res.writeHead(502); res.end('Model service request failed. Check your connection and provider settings.') }
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve) })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Could not start the local model connection.')
    this.origin = `http://127.0.0.1:${address.port}`
    return this.origin
  }
  close() { this.server?.closeAllConnections(); this.server?.close(); this.origin = '' }
}
