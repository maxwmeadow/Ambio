import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { ChatGPTAuth } from './chatgptAuth.ts'

const { privateKey, publicKey } = await generateKeyPair('RS256')
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' }
const scopes = 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct'
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'ambio-chatgpt-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const key = randomBytes(32)
  const encryption = {
    available: () => true,
    encrypt(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt(data) {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      decipher.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()
    },
  }
  const opened = [], requests = []
  let url
  const controls = { scopes, subject: 'user-1', expires: 3600, failToken: false, failKeys: false, revoked: true, refreshIdentity: false, ...options }
  const idToken = async (clientId, nonce) => new SignJWT({ email: 'same@example.com', ...(nonce ? { nonce } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com')
    .setSubject(controls.subject).setAudience(clientId).setIssuedAt().setExpirationTime('1h').sign(privateKey)
  const fetcher = async (endpoint, init) => {
    requests.push({ endpoint, init })
    if (endpoint.endsWith('openid-configuration')) return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/revoke' })
    if (endpoint.endsWith('jwks.json')) return controls.failKeys ? json({}, 503) : json({ keys: [jwk] })
    if (endpoint.endsWith('/oauth/token')) {
      const parameters = new URLSearchParams(init.body)
      if (controls.failToken) return json({ error: 'invalid_grant', secret: 'DO-NOT-EXPOSE' }, 400)
      const refresh = parameters.get('grant_type') === 'refresh_token'
      if (!refresh) {
        assert.equal(parameters.get('redirect_uri'), url.searchParams.get('redirect_uri'))
        assert.equal(createHash('sha256').update(parameters.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'))
      }
      assert.equal(parameters.get('resource'), 'https://api.openai.com/v1')
      assert.notEqual(parameters.get('client_id'), 'dynamic_agent_client')
      return json({
        access_token: refresh ? 'rotated-access-secret' : 'initial-access-secret', refresh_token: refresh ? 'rotated-refresh-secret' : 'initial-refresh-secret',
        token_type: 'Bearer', expires_in: refresh ? 3600 : controls.expires, scope: controls.scopes,
        ...(!refresh || controls.refreshIdentity ? { id_token: await idToken(parameters.get('client_id'), refresh ? undefined : controls.wrongNonce ? 'WRONG' : url.searchParams.get('nonce')) } : {}),
      })
    }
    if (endpoint.endsWith('/models')) {
      assert.match(init.headers.Authorization, /^Bearer (initial|rotated)-access-secret$/)
      return json({ models: [{ slug: 'hidden', visibility: 'hide' }, { slug: 'model-one', display_name: 'Model One', visibility: 'list' }, { slug: 'model-two', visibility: 'list' }] })
    }
    if (endpoint.endsWith('/revoke')) return new Response(null, { status: controls.revoked ? 200 : 503 })
    assert.fail(`unexpected endpoint ${endpoint}`)
  }
  const openBrowser = async endpoint => {
    url = new URL(endpoint); opened.push(url)
    assert.equal(url.origin, 'https://auth.openai.com')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    const callback = new URL(url.searchParams.get('redirect_uri'))
    assert.equal(callback.hostname, '127.0.0.1')
    if (controls.cancel) { auth.cancelSignIn(); return }
    callback.search = new URLSearchParams({ state: 'wrong', code: 'authorization-code', client_id: controls.clientId ?? 'oaiapp_one' })
    assert.equal((await fetch(callback)).status, 400, 'an unrelated callback cannot consume the attempt')
    callback.searchParams.set('state', url.searchParams.get('state'))
    if (controls.denied) { callback.searchParams.set('error', 'access_denied') }
    const saved = url.searchParams.get('client_id')
    if (saved !== 'dynamic_agent_client') callback.searchParams.set('client_id', saved)
    const response = await fetch(callback)
    assert.equal(response.status, controls.denied ? 400 : 200)
  }
  const configuration = { directory, encryption, fetch: fetcher, openBrowser }
  const auth = new ChatGPTAuth(configuration)
  return { auth, configuration, directory, encryption, opened, requests, controls }
}

test('browser PKCE sign-in encrypts credentials, verifies identity and persists the installation and registration', async t => {
  const f = await fixture(t)
  await f.auth.signIn()
  const state = f.auth.state(true)
  assert.equal(state.profiles[0].sharing, true)
  assert.equal(state.profiles[0].email, 'same@example.com')
  assert.equal(JSON.stringify(state).includes('secret'), false)
  const ciphertext = fs.readFileSync(join(f.directory, 'accounts.enc')).toString()
  for (const secret of ['initial-access-secret', 'initial-refresh-secret', 'same@example.com']) assert.equal(ciphertext.includes(secret), false)
  assert.deepEqual(await f.auth.listModels(), [{ slug: 'model-one', displayName: 'Model One' }, { slug: 'model-two', displayName: 'model-two' }])
  await f.auth.selectModel('model-two')
  assert.equal((await f.auth.prepareTurn()).model, 'model-two')
  await assert.rejects(f.auth.selectModel('hidden'), /not available/)
  const restarted = new ChatGPTAuth(f.configuration)
  assert.equal(restarted.state().activeId, state.activeId)
  await restarted.signIn(state.activeId)
  assert.equal(f.opened[1].searchParams.get('client_id'), 'oaiapp_one')
  assert.equal(f.opened[1].searchParams.has('agent_name_hint'), false)
  assert.equal(f.opened[0].searchParams.get('ext_agent_host_id'), f.opened[1].searchParams.get('ext_agent_host_id'))
  assert.notEqual(f.opened[0].searchParams.get('nonce'), f.opened[1].searchParams.get('nonce'))
  assert.equal(f.opened[1].searchParams.has('id_token_hint'), true)
})

test('identity-only consent cannot power requests', async t => {
  const { auth } = await fixture(t, { scopes: 'openid email profile' })
  await auth.signIn()
  assert.equal(auth.state().profiles[0].connected, true)
  assert.equal(auth.state().profiles[0].sharing, false)
  await assert.rejects(auth.prepareTurn(), /plan usage is not enabled/)
})

test('denied, cancelled and invalid nonce sign-ins do not activate an account', async t => {
  for (const options of [{ denied: true }, { cancel: true }, { wrongNonce: true }]) {
    const { auth } = await fixture(t, options)
    await assert.rejects(auth.signIn(), /not approved|cancelled|verification failed/)
    assert.equal(auth.state().activeId, undefined)
    assert.equal(auth.state().signingIn, false)
  }
})

test('a failed exchange keeps its issued client ID for a later retry without exposing provider errors', async t => {
  const { auth, controls, opened } = await fixture(t, { failToken: true })
  await assert.rejects(auth.signIn(), error => /expired/.test(error.message) && !error.message.includes('DO-NOT-EXPOSE'))
  controls.failToken = false
  await auth.signIn()
  assert.equal(opened[1].searchParams.get('client_id'), 'oaiapp_one')
})

test('same-email registrations remain separate and a mismatched returning identity cannot overwrite them', async t => {
  const { auth, controls } = await fixture(t)
  await auth.signIn()
  const first = auth.state().activeId
  controls.clientId = 'oaiapp_two'
  await auth.signIn()
  const second = auth.state().activeId
  assert.notEqual(first, second)
  assert.equal(auth.state().profiles.length, 2)
  await auth.selectProfile(first)
  controls.subject = 'different-user'
  await assert.rejects(auth.signIn(first), /does not match/)
  assert.equal(auth.state().activeId, first)
  assert.equal(auth.state().profiles.find(item => item.id === first).connected, true)
})

test('concurrent requests serialize rotating refresh tokens and persist the replacement', async t => {
  const { auth, requests, configuration } = await fixture(t, { expires: 0.01 })
  await auth.signIn()
  const [one, two] = await Promise.all([auth.prepareTurn(), auth.prepareTurn()])
  assert.equal(one.token, 'rotated-access-secret')
  assert.equal(two.token, one.token)
  assert.equal(requests.filter(item => new URLSearchParams(item.init?.body).get('grant_type') === 'refresh_token').length, 1)
  assert.equal((await new ChatGPTAuth(configuration).prepareTurn()).token, one.token)
})

test('a JWKS outage after rotation preserves pending credentials through restart without consuming the refresh token again', async t => {
  const { auth, controls, requests, configuration } = await fixture(t, { expires: 0.01, refreshIdentity: true })
  await auth.signIn()
  controls.failKeys = true
  await assert.rejects(auth.prepareTurn(), /verify/)
  assert.equal(auth.state().profiles[0].sharing, false)
  controls.failKeys = false
  assert.equal((await new ChatGPTAuth(configuration).prepareTurn()).token, 'rotated-access-secret')
  assert.equal(requests.filter(item => new URLSearchParams(item.init?.body).get('grant_type') === 'refresh_token').length, 1)
})

test('sign-out clears local credentials, retains registration, and reports unconfirmed revocation', async t => {
  const { auth, controls, requests, opened } = await fixture(t)
  await auth.signIn()
  const id = auth.state().activeId
  controls.revoked = false
  assert.match(await auth.signOut(), /Remote revocation could not be confirmed/)
  assert.equal(auth.state().profiles[0].connected, false)
  await assert.rejects(auth.prepareTurn(), /Sign in/)
  const revoke = requests.find(item => item.endpoint.endsWith('/revoke'))
  assert.equal(new URLSearchParams(revoke.init.body).get('client_id'), 'oaiapp_one')
  await auth.signIn(id)
  assert.equal(opened[1].searchParams.has('id_token_hint'), false)
})

test('unavailable encryption and damaged credential files fail closed without deleting saved data', async t => {
  const { auth, encryption, directory } = await fixture(t)
  encryption.available = () => false
  await assert.rejects(auth.signIn(), /Secure storage/)
  encryption.available = () => true
  await auth.signIn()
  const file = join(directory, 'accounts.enc')
  fs.writeFileSync(file, 'damaged ciphertext')
  assert.throws(() => auth.state(), /preserved/)
  await assert.rejects(auth.signIn(), /preserved/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'damaged ciphertext')
})
