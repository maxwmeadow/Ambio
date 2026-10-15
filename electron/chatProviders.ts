import fs from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CHAT_CONTEXT_WINDOW_MAX, CHAT_CONTEXT_WINDOW_MIN, type ChatConnectionTest, type ChatProvider, type ChatProviderInput } from '../src/shared/agentChat.ts'

export interface KeyEncryption {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
interface StoredProvider extends Omit<ChatProvider, 'hasKey' | 'persistentKey'> { encryptedKey?: string }

export function providerUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) throw new Error('Use a service URL without credentials, query parameters or fragments.')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Use HTTPS for your service, or HTTP for a local service.')
  return url.toString().replace(/\/$/, '')
}

/** API keys never cross back into renderer state. Insecure Linux key storage
 * falls back to this process's memory rather than writing a plaintext key. */
export class ChatProviders {
  private providers: StoredProvider[] = []
  private keys = new Map<string, string>()
  private directory: string
  private encryption: KeyEncryption
  private request: typeof fetch
  constructor(directory: string, encryption: KeyEncryption, request: typeof fetch = fetch) {
    this.directory = directory; this.encryption = encryption; this.request = request
    try { this.providers = JSON.parse(fs.readFileSync(join(directory, 'providers.json'), 'utf8')) } catch { /* first run */ }
    if (!Array.isArray(this.providers)) this.providers = []
    for (const profile of this.providers) {
      if (profile.encryptedKey && encryption.available()) {
        try { this.keys.set(profile.id, encryption.decrypt(Buffer.from(profile.encryptedKey, 'base64'))) } catch { /* locked keychain: show key missing */ }
      }
    }
  }
  private persist() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, 'providers.json')
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.providers), { mode: 0o600 })
    fs.renameSync(`${file}.tmp`, file)
  }
  list(): ChatProvider[] {
    return this.providers.map(({ encryptedKey, ...profile }) => ({ ...profile, hasKey: this.keys.has(profile.id), persistentKey: !!encryptedKey && this.keys.has(profile.id) }))
  }
  get(id: string): ChatProvider {
    const profile = this.list().find(item => item.id === id)
    if (!profile) throw new Error('This model service was removed. Configure a service to continue.')
    return profile
  }
  key(id: string): string { this.get(id); return this.keys.get(id) ?? '' }
  redact(text: string): string {
    for (const key of this.keys.values()) if (key) text = text.split(key).join('[redacted]')
    return text
  }
  save(input: ChatProviderInput): ChatProvider {
    if (!input || !['openai', 'anthropic', 'google', 'compatible'].includes(input.kind) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256) throw new Error('Choose a service name, provider and model.')
    if (input.contextWindow !== undefined && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < CHAT_CONTEXT_WINDOW_MIN || input.contextWindow > CHAT_CONTEXT_WINDOW_MAX)) throw new Error(`Enter a context window between ${CHAT_CONTEXT_WINDOW_MIN.toLocaleString('en-US')} and ${CHAT_CONTEXT_WINDOW_MAX.toLocaleString('en-US')} tokens, or leave it blank.`)
    const baseUrl = providerUrl(input.baseUrl)
    const id = input.id ?? randomUUID()
    const old = input.id ? this.get(id) : undefined
    if (old && old.kind !== input.kind) throw new Error('Add a new service to change provider type.')
    if (old && old.baseUrl !== baseUrl && !input.apiKey?.trim()) throw new Error('Enter the key for the new service URL. Saved keys are not forwarded to a different service.')
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey))) throw new Error('Invalid API key.')
    const key = input.apiKey?.trim() || this.keys.get(id) || ''
    if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('Enter an API key for this service.')
    const stored: StoredProvider = { id, name: input.name.trim(), kind: input.kind, baseUrl, model: input.model.trim() }
    if (input.contextWindow !== undefined) stored.contextWindow = input.contextWindow
    if (key && this.encryption.available()) stored.encryptedKey = this.encryption.encrypt(key).toString('base64')
    if (key) this.keys.set(id, key)
    this.providers = [...this.providers.filter(item => item.id !== id), stored]
    this.persist()
    return this.get(id)
  }
  remove(id: string) { this.get(id); this.providers = this.providers.filter(item => item.id !== id); this.keys.delete(id); this.persist() }
  async test(input: ChatProviderInput): Promise<ChatConnectionTest> {
    const baseUrl = providerUrl(input.baseUrl)
    if (input.id && !input.apiKey?.trim()) {
      const saved = this.get(input.id)
      if (saved.baseUrl !== baseUrl || saved.kind !== input.kind) throw new Error('Enter the key for the new service URL. Saved keys are not forwarded to a different service.')
    }
    const key = input.apiKey?.trim() || (input.id ? this.key(input.id) : '')
    const headers: Record<string, string> = {}
    if (input.kind === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01' }
    else if (input.kind === 'google') headers['x-goog-api-key'] = key
    else if (key) headers.Authorization = `Bearer ${key}`
    let response: Response
    try { response = await this.request(`${baseUrl}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) }) }
    catch { throw new Error('Could not reach this service. Check the URL and your connection.') }
    if (!response.ok) throw new Error(`Service returned HTTP ${response.status}. Check the API key and model-list access.`)
    let body: { data?: Array<{ id: string }>; models?: Array<{ name: string }> }
    try { body = await response.json() } catch { throw new Error('The service returned an invalid model list. Check the service URL.') }
    const models = (Array.isArray(body?.data) ? body.data.map(item => item?.id) : Array.isArray(body?.models) ? body.models.map(item => typeof item?.name === 'string' ? item.name.replace(/^models\//, '') : '') : []).filter(item => typeof item === 'string' && item.length > 0).map(item => this.redact(item)).sort()
    return { models, detail: models.length ? `Connected · ${models.length} models available` : 'Connected. Enter a model ID supplied by your service.' }
  }
}
