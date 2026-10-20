import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChatProviders } from './chatProviders.ts'
import { chatGPTEvents, chatGPTRequest } from './chatgptResponses.ts'

/** The harness gets a short-lived local token. Real service credentials stay
 * in Electron, outside the agent's environment and tools. */
export class ChatProviderProxy {
  /** Prevent the native harness from automatically replaying a failed plan request. */
  onChatGPTFailure?: (providerId: string, sessionId: string, message: string) => void
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
      let subscription = false
      const failSubscription = (message: string) => {
        const sessionId = req.headers['x-opencode-session-id']
        if (!abort.signal.aborted && subscription && typeof sessionId === 'string') this.onChatGPTFailure?.(match[1], sessionId, message)
      }
      try {
        const profile = this.providers.get(match[1])
        subscription = profile.auth === 'chatgpt'
        // OAuth credentials can be renewed here, never sent to the harness.
        // The provider ID pins every request to its original registration.
        if (profile.auth === 'chatgpt' && (url.search || !(req.method === 'POST' && match[2] === '/responses' || req.method === 'GET' && match[2] === '/models'))) {
          res.writeHead(400).end('ChatGPT plan usage only supports the public Responses and model-list endpoints.'); return
        }
        const key = await this.providers.credential(profile.id)
        if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(profile.baseUrl).hostname)) { res.writeHead(401).end('Reconnect your model service in Ambio.'); return }
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (profile.kind === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = String(req.headers['anthropic-version'] ?? '2023-06-01'); if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta']) }
        else if (profile.kind === 'google') headers['x-goog-api-key'] = key
        else if (key) headers.Authorization = `Bearer ${key}`
        url.searchParams.delete('key')
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('Request is too large.'); chunks.push(chunk) }
        let requestBody: string | undefined = req.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined
        if (profile.auth === 'chatgpt' && requestBody) {
          const body = chatGPTRequest(JSON.parse(requestBody.toString()))
          if (![profile.model, ...(profile.models ?? [])].includes(body.model)) { res.writeHead(400).end('Choose an available ChatGPT model in Ambio.'); return }
          requestBody = JSON.stringify(body)
        }
        const upstream = await this.request(`${profile.baseUrl}${match[2]}${url.search}`, { method: req.method, headers, body: requestBody, redirect: 'error', signal: abort.signal })
        if (subscription && !upstream.ok) failSubscription('ChatGPT could not complete this request. Check Manage usage or reconnect ChatGPT in Model services.')
        const subscriptionStream = subscription && match[2] === '/responses' && upstream.ok
        const contentType = upstream.headers.get('content-type')
        // Electron can expose a completed OpenAI stream without its content type.
        // Its frames still pass through chatGPTEvents, which requires completion.
        if (subscriptionStream && (!upstream.body || contentType && !contentType.toLowerCase().includes('text/event-stream'))) throw new Error('ChatGPT did not return a response stream.')
        res.writeHead(upstream.status, { 'content-type': contentType ?? (subscriptionStream ? 'text/event-stream' : 'application/json'), 'cache-control': 'no-store' })
        if (upstream.body) {
          const validated = profile.auth === 'chatgpt' && match[2] === '/responses' && upstream.ok
          const source = validated ? chatGPTEvents(upstream.body, failSubscription) : undefined
          const reader = source ? undefined : upstream.body.getReader()
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
              const { done, value } = source ? await source.next() : await reader!.read()
              pending += typeof value === 'string' ? value : decoder.decode(value, { stream: !done })
              if (key) pending = pending.split(key).join('[redacted]')
              let held = 0
              if (!done && key) for (let length = 1; length < key.length && length <= pending.length; length++) if (pending.endsWith(key.slice(0, length))) held = length
              await write(pending.slice(0, pending.length - held)); pending = held ? pending.slice(-held) : ''
              if (done) break
            }
          }
          finally { if (source) await source.return(undefined); else reader!.releaseLock() }
        }
        res.end()
      } catch {
        if (!abort.signal.aborted) failSubscription('ChatGPT could not complete this request. Check Manage usage or reconnect ChatGPT in Model services.')
        if (!res.headersSent) res.writeHead(502)
        res.end('Model service request failed. Check your connection and provider settings.')
      }
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve) })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Could not start the local model connection.')
    this.origin = `http://127.0.0.1:${address.port}`
    return this.origin
  }
  close() { this.server?.closeAllConnections(); this.server?.close(); this.origin = '' }
}
