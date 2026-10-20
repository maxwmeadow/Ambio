import fs from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createLocalJWKSet, jwtVerify, type JWTPayload, type JSONWebKeySet } from 'jose'
import type { ChatGPTModel, ChatGPTState } from '../src/shared/chatgpt.ts'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const DYNAMIC_CLIENT = 'dynamic_agent_client'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

interface Tokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt: number
  scopes: string[]
  /** Rotated tokens are saved before verification, but cannot yet be used. */
  pendingIdentity?: boolean
}
interface Profile {
  id: string; label: string; clientId: string; subject?: string; email?: string
  tokens?: Tokens; model?: string; models?: string[]
}
interface Store { version: 1; profiles: Profile[]; activeId?: string }
export interface CredentialEncryption {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}
interface Options {
  directory: string
  encryption: CredentialEncryption
  openBrowser: (url: string) => Promise<void>
  fetch?: typeof fetch
}

/** Implements the published SIWC protocol independently of the noncommercial DevKit. */
export class ChatGPTAuth {
  private options: Options
  private queue: Promise<unknown> = Promise.resolve()
  private authorization?: AbortController
  private discovery?: { jwks_uri: string; revocation_endpoint: string }
  constructor(options: Options) { this.options = options }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work)
    this.queue = next.catch(() => {})
    return next
  }
  private ensureEncryption(): void {
    if (!this.options.encryption.available()) throw new Error('Unlock your OS credential store to connect ChatGPT. Secure storage is required.')
  }
  private read(): Store {
    const file = join(this.options.directory, 'accounts.enc')
    if (!fs.existsSync(file)) return { version: 1, profiles: [] }
    this.ensureEncryption()
    try {
      const store = JSON.parse(this.options.encryption.decrypt(fs.readFileSync(file))) as Store
      if (store.version !== 1 || !Array.isArray(store.profiles)) throw new Error()
      return store
    } catch { throw new Error('Could not unlock the saved ChatGPT connections. Restore access to the original OS credential store; the saved file has been preserved.') }
  }
  private save(store: Store): void {
    this.ensureEncryption()
    fs.mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
    const file = join(this.options.directory, 'accounts.enc')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, this.options.encryption.encrypt(JSON.stringify(store)), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, file)
    } finally { fs.rmSync(temporary, { force: true }) }
  }
  private hostId(): string {
    fs.mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
    const file = join(this.options.directory, 'host-id')
    if (!fs.existsSync(file)) fs.writeFileSync(file, `urn:uuid:${randomUUID()}`, { mode: 0o600, flag: 'wx' })
    const id = fs.readFileSync(file, 'utf8')
    if (!/^urn:uuid:[0-9a-f-]{36}$/.test(id)) throw new Error('The ChatGPT installation identifier is invalid.')
    return id
  }
  state(): ChatGPTState {
    const store = this.read()
    const active = store.profiles.find(profile => profile.id === store.activeId)
    return {
      profiles: store.profiles.filter(profile => profile.subject).map(profile => ({
        id: profile.id, label: profile.label, email: profile.email,
        connected: !!profile.tokens && !profile.tokens.pendingIdentity,
        sharing: this.canShare(profile),
        model: profile.model, models: profile.models,
      })),
      activeId: store.activeId, model: active?.model, signingIn: !!this.authorization,
      secureStorage: this.options.encryption.available(),
    }
  }
  private canShare(profile: Profile): boolean {
    return !!profile.tokens && !profile.tokens.pendingIdentity && ['resource.invoke', 'chatgpt.tokens.use.direct'].every(scope => profile.tokens!.scopes.includes(scope))
  }
  private selected(store: Store): Profile {
    const profile = store.profiles.find(item => item.id === store.activeId)
    if (!profile) throw new Error('Connect a ChatGPT account in Settings → Agents first.')
    return profile
  }
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    // Only fixed OpenAI HTTPS endpoints receive credentials. Never follow redirects.
    const destination = new URL(url)
    if (destination.protocol !== 'https:' || !['auth.openai.com', 'api.openai.com'].includes(destination.host)) throw new Error('Unexpected OpenAI endpoint.')
    try {
      return await (this.options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) })
    } catch { throw new Error('Could not reach OpenAI. Check your connection and try again.') }
  }
  private async configuration() {
    if (!this.discovery) {
      const response = await this.request(`${ISSUER}/.well-known/openid-configuration`)
      if (!response.ok) throw new Error('Could not load OpenAI sign-in configuration.')
      const data = await response.json()
      if (data.issuer !== ISSUER || ![data.jwks_uri, data.revocation_endpoint].every(value => typeof value === 'string' && new URL(value).origin === ISSUER)) throw new Error('Invalid OpenAI sign-in configuration.')
      this.discovery = { jwks_uri: data.jwks_uri, revocation_endpoint: data.revocation_endpoint }
    }
    return this.discovery
  }
  private async identity(token: string | undefined, clientId: string, nonce?: string): Promise<JWTPayload> {
    if (!token) throw new Error('OpenAI did not return an ID token. Sign in again.')
    const config = await this.configuration()
    const response = await this.request(config.jwks_uri)
    if (!response.ok) throw new Error('Could not verify your ChatGPT identity. Try again.')
    try {
      const keys = createLocalJWKSet(await response.json() as JSONWebKeySet)
      const { payload } = await jwtVerify(token, keys, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] })
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw new Error()
      return payload
    } catch { throw new Error('ChatGPT identity verification failed. Sign in again.') }
  }
  private async tokenRequest(parameters: URLSearchParams, signal?: AbortSignal): Promise<any> {
    const response = await this.request(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameters.toString(), signal })
    if (!response.ok) {
      // Never surface provider response bodies: they can contain credential material.
      throw new Error(response.status === 400 || response.status === 401 ? 'ChatGPT authorization expired or was revoked. Sign in again.' : 'OpenAI could not renew the connection. Try again.')
    }
    const data = await response.json()
    if (typeof data.access_token !== 'string' || !data.access_token || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(Number(data.expires_in)) || !(Number(data.expires_in) > 0)) throw new Error('OpenAI returned an invalid token response.')
    return data
  }
  private credentials(data: any, prior?: Tokens): Tokens {
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : prior?.refreshToken,
      idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
      expiresAt: Date.now() + Number(data.expires_in) * 1000,
      scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : prior?.scopes ?? [],
    }
  }
  cancelSignIn(): void { this.authorization?.abort() }
  signIn(profileId?: string): Promise<void> {
    if (this.authorization) return Promise.reject(new Error('A ChatGPT sign-in is already open. Finish or cancel it first.'))
    const controller = new AbortController()
    this.authorization = controller
    return this.exclusive(async () => {
      this.ensureEncryption()
      const store = this.read()
      // An interrupted first registration is retained and reused as well.
      let profile = profileId ? store.profiles.find(item => item.id === profileId) : store.profiles.find(item => !item.subject)
      if (profileId && !profile) throw new Error('Unknown ChatGPT connection.')
      const prior = profile
      const state = randomBytes(32).toString('base64url')
      const nonce = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const hostId = this.hostId()
      const issuedClient = prior?.clientId
      const server = createServer()
      const timeout = setTimeout(() => controller.abort(), 180000)
      let redirectUri = ''
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
        })
        const port = (server.address() as { port: number }).port
        redirectUri = `http://127.0.0.1:${port}/auth/callback`
        let done = false
        const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
          const abort = () => reject(new Error('ChatGPT sign-in was cancelled or timed out.'))
          controller.signal.addEventListener('abort', abort, { once: true })
          if (controller.signal.aborted) abort()
          server.on('request', (request, response) => {
            response.setHeader('Cache-Control', 'no-store')
            response.setHeader('Content-Security-Policy', "default-src 'none'")
            const url = new URL(request.url ?? '/', redirectUri)
            if (done || request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}` || url.pathname !== '/auth/callback' || url.searchParams.get('state') !== state) {
              response.writeHead(400).end('Invalid sign-in callback.'); return
            }
            const clientId = url.searchParams.get('client_id') ?? issuedClient
            if (url.searchParams.has('error') || !url.searchParams.get('code') || !clientId || clientId === DYNAMIC_CLIENT || (issuedClient && issuedClient !== clientId)) {
              done = true; response.writeHead(400).end('Sign-in was not completed. Return to Ambio.'); reject(new Error('ChatGPT sign-in was not approved or returned a different registration.')); return
            }
            done = true
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Sign-in received. Return to Ambio to finish connecting.')
            resolve({ code: url.searchParams.get('code')!, clientId })
          })
        })
        // Attach rejection handling before opening the browser, which can itself fail.
        void callback.catch(() => {})
        const url = new URL(`${ISSUER}/api/accounts/authorize`)
        url.search = new URLSearchParams({
          client_id: issuedClient ?? DYNAMIC_CLIENT,
          ...(issuedClient ? {} : { agent_name_hint: 'Ambio' }),
          ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES,
          resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          ...(prior?.tokens?.idToken ? { id_token_hint: prior.tokens.idToken } : {}),
          ...(prior?.email ? { login_hint: prior.email } : {}),
        }).toString()
        await this.options.openBrowser(url.toString())
        const result = await callback
        if (!profile) {
          profile = { id: randomUUID(), label: `Connection ${store.profiles.length + 1}`, clientId: result.clientId }
          store.profiles.push(profile)
        }
        // Preserve the registration even if the exchange fails, without switching accounts.
        this.save(store)
        const data = await this.tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: result.clientId, code: result.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }), controller.signal)
        const identity = await this.identity(data.id_token, result.clientId, nonce)
        if (prior?.subject && identity.sub !== prior.subject) throw new Error('The signed-in ChatGPT account does not match this saved connection.')
        if (controller.signal.aborted) throw new Error('ChatGPT sign-in was cancelled.')
        profile.subject = identity.sub
        profile.email = typeof identity.email === 'string' ? identity.email : undefined
        profile.tokens = this.credentials(data)
        profile.model = undefined
        store.activeId = profile.id
        this.save(store)
      } finally {
        clearTimeout(timeout)
        server.close()
        server.closeAllConnections()
      }
    }).finally(() => { if (this.authorization === controller) this.authorization = undefined })
  }
  selectProfile(id: string): Promise<void> {
    return this.exclusive(async () => {
      const store = this.read()
      if (!store.profiles.some(profile => profile.id === id && profile.subject)) throw new Error('Unknown ChatGPT connection.')
      store.activeId = id; this.save(store)
    })
  }
  private async access(store: Store, profile: Profile): Promise<string> {
    let tokens = profile.tokens
    if (!tokens) throw new Error('Sign in to this ChatGPT connection again.')
    if (tokens.pendingIdentity) {
      const identity = await this.identity(tokens.idToken, profile.clientId)
      if (identity.sub !== profile.subject) throw new Error('The renewed ChatGPT identity does not match this connection.')
      tokens.pendingIdentity = false; this.save(store)
    }
    if (tokens.expiresAt <= Date.now() + 60000) {
      if (!tokens.refreshToken) throw new Error('ChatGPT sign-in has expired. Sign in again.')
      const data = await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: tokens.refreshToken, resource: RESOURCE }))
      tokens = this.credentials(data, tokens)
      tokens.pendingIdentity = !!tokens.idToken
      profile.tokens = tokens
      // A rotated refresh token must survive a transient JWKS failure.
      this.save(store)
      if (tokens.pendingIdentity) {
        const identity = await this.identity(tokens.idToken, profile.clientId)
        if (identity.sub !== profile.subject) throw new Error('The renewed ChatGPT identity does not match this connection.')
        tokens.pendingIdentity = false; this.save(store)
      }
    }
    if (!this.canShare(profile)) throw new Error('ChatGPT plan usage is not enabled. Reconnect and approve plan usage in ChatGPT.')
    return tokens.accessToken
  }
  private async models(token: string): Promise<ChatGPTModel[]> {
    const response = await this.request(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(response.status === 401 ? 'ChatGPT authorization expired. Sign in again.' : 'ChatGPT models are unavailable. Check your plan access and usage in ChatGPT.')
    const body = await response.json()
    if (!Array.isArray(body.models)) throw new Error('OpenAI returned an invalid model catalog.')
    return body.models.filter((model: any) => model.visibility === 'list' && typeof model.slug === 'string').map((model: any) => ({ slug: model.slug, displayName: typeof model.display_name === 'string' ? model.display_name : model.slug }))
  }
  listModels(): Promise<ChatGPTModel[]> {
    return this.exclusive(async () => {
      const store = this.read(), profile = this.selected(store)
      const models = await this.models(await this.access(store, profile))
      profile.models = models.map(model => model.slug)
      if (!models.some(model => model.slug === profile.model)) profile.model = models[0]?.slug
      this.save(store)
      return models
    })
  }
  selectModel(slug: string): Promise<void> {
    return this.exclusive(async () => {
      const store = this.read(), profile = this.selected(store)
      const models = await this.models(await this.access(store, profile))
      if (!models.some(model => model.slug === slug)) throw new Error('This model is not available to the selected ChatGPT account.')
      profile.model = slug; this.save(store)
    })
  }
  /** Main-process only: never expose this result to IPC or persist it in a run receipt. */
  authorize(profileId: string): Promise<string> {
    return this.exclusive(async () => {
      const store = this.read()
      const profile = store.profiles.find(item => item.id === profileId && item.subject)
      if (!profile) throw new Error('This ChatGPT connection is unavailable. Reconnect it in Model services.')
      return this.access(store, profile)
    })
  }
  signOut(): Promise<string> {
    this.cancelSignIn()
    return this.exclusive(async () => {
      const store = this.read(), profile = this.selected(store)
      let confirmed = !profile.tokens?.refreshToken
      try {
        if (profile.tokens?.refreshToken) {
          const config = await this.configuration()
          for (let attempt = 0; attempt < 2 && !confirmed; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 250))
            try {
              const response = await this.request(config.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: profile.tokens.refreshToken, token_type_hint: 'refresh_token', client_id: profile.clientId }).toString() })
              confirmed = response.status === 200
              if (response.status < 500) break
            } catch { /* Retry a transient network error before clearing locally. */ }
          }
        }
      } catch { /* Local sign-out must still remove credentials. */ }
      profile.tokens = undefined; this.save(store)
      return confirmed ? 'Signed out of ChatGPT.' : 'Signed out locally. Remote revocation could not be confirmed; disconnect Ambio in ChatGPT Settings → Usage.'
    })
  }
}
