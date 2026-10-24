import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverAppClients } from './agentClientDiscovery.ts'
import { buildHosts, inspectHostConfiguration } from './agentInstallers.ts'
import { deliveryTargets, findDeliveryCli, selectedDeliveryCli } from './agentDelivery.ts'
import { setExecutableOverride, clearExecutableOverride, readExecutableOverrides } from './agentExecutableOverrides.ts'
import { APP_CLIENTS, CLI_CLIENTS, installerHostId } from '../src/shared/agentDelivery.ts'
import { DRIVER_CLI_NAMES } from './agentDrivers.ts'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-discovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function write(file, content = '') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o755 }); return file }

test('a clean machine lists every terminal client, all unavailable, and every external route', t => {
  const root = fixture(t)
  const env = { PATH: root, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local') }
  const hosts = buildHosts(root, env.APPDATA, 'win32')
  assert.deepEqual(new Set(CLI_CLIENTS.map(client => client.id)), new Set(Object.keys(DRIVER_CLI_NAMES)))
  const sharedApps = hosts.flatMap(host => host.sharedSurfaces ?? []).filter(client => !DRIVER_CLI_NAMES[client.id])
  assert.deepEqual(new Set(APP_CLIENTS.map(client => client.id)), new Set([...hosts.filter(host => host.modality !== 'cli'), ...sharedApps].map(client => client.id)))
  const targets = deliveryTargets(hosts, env, 'win32', root)
  assert.deepEqual(targets.filter(host => host.route === 'run').map(host => host.id), CLI_CLIENTS.map(client => client.id))
  assert.ok(targets.filter(host => host.route === 'run').every(host => !host.available))
  const apps = discoverAppClients(hosts.map(host => ({ ...host, configured: false, detected: false, configPath: host.configPath(), ...inspectHostConfiguration(host) })), env, 'win32', root)
  assert.deepEqual(new Set(apps.filter(host => host.modality !== 'cli').map(host => host.id)), new Set(APP_CLIENTS.map(client => client.id)))
})

test('a Codex extension and desktop install do not become a standalone CLI through injected PATH', t => {
  const root = fixture(t)
  const extension = path.join(root, '.vscode', 'extensions', 'openai.chatgpt-1.2.3')
  const codex = write(path.join(extension, 'bin', 'windows-x86_64', 'codex.exe'))
  write(path.join(extension, 'package.json'), '{}')
  const local = path.join(root, 'local')
  const desktop = write(path.join(local, 'OpenAI', 'Codex', 'bin', 'opaque-version', 'codex.exe'))
  const env = { PATH: [path.dirname(codex), path.dirname(desktop)].join(path.delimiter), APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: local }
  assert.equal(findDeliveryCli('codex', env, 'win32', root), undefined)
  const hosts = buildHosts(root, env.APPDATA, 'win32').map(host => ({ ...host, configPath: host.configPath(), configured: false, detected: false }))
  const clients = discoverAppClients(hosts, env, 'win32', root)
  assert.equal(clients.find(host => host.id === 'codex-ide').detected, true)
  assert.deepEqual(clients.find(host => host.id === 'codex-app').detectionEvidence, [desktop])
  assert.equal(installerHostId('codex-ide'), 'codex')
  assert.equal(clients.find(host => host.id === 'codex-ide').configPath, clients.find(host => host.id === 'codex').configPath)
  // An independent standalone installation still wins, even with injected PATH.
  const independent = write(path.join(root, '.local', 'bin', 'codex.exe'))
  assert.equal(findDeliveryCli('codex', env, 'win32', root).command, independent)
})

test('manual CLI locations survive restart and remain visibly broken after removal instead of falling back', async t => {
  const root = fixture(t)
  const script = write(path.join(root, 'custom', 'codex.js'), 'console.log("codex-cli 1.2.3")')
  assert.equal((await setExecutableOverride(root, 'codex', script)).ok, true)
  const stored = readExecutableOverrides(root)
  const env = { PATH: root, APPDATA: root, LOCALAPPDATA: root }
  let codex = deliveryTargets([{ id: 'codex', label: 'Codex CLI' }], env, process.platform, root, stored).find(host => host.id === 'codex')
  assert.equal(codex.available, true)
  assert.equal(codex.executablePath, script)
  assert.deepEqual(codex.launcher.args, [script])
  fs.rmSync(script)
  write(path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex'))
  codex = deliveryTargets([{ id: 'codex', label: 'Codex CLI' }], env, process.platform, root, readExecutableOverrides(root)).find(host => host.id === 'codex')
  assert.equal(codex.available, false)
  assert.equal(codex.executableOverride, script)
  assert.match(codex.discoveryError, /missing|inaccessible/)
  assert.equal(clearExecutableOverride(root, 'codex').ok, true)
  assert.deepEqual(readExecutableOverrides(root), {})
})

test('wrong executables and installer shims cannot overwrite a verified CLI selection', async t => {
  const root = fixture(t)
  const good = write(path.join(root, 'good.js'), 'console.log("GitHub Copilot CLI 1.2.3")')
  assert.equal((await setExecutableOverride(root, 'copilot-cli', good)).ok, true)
  const wrong = write(path.join(root, 'wrong.js'), 'console.log("AWS Copilot 1.2.3")')
  assert.equal((await setExecutableOverride(root, 'copilot-cli', wrong)).ok, false)
  const shortcut = write(path.join(root, 'copilot.bat'), '@echo install me')
  assert.throws(() => selectedDeliveryCli('copilot-cli', shortcut), /shell or installer shortcut/)
  assert.equal(readExecutableOverrides(root)['copilot-cli'], good)
  assert.equal((await setExecutableOverride(root, 'unknown', good)).ok, false)
})

test('Windows npm shortcuts resolve their package entry without invoking a shell', t => {
  const root = fixture(t)
  const shim = write(path.join(root, 'codex.cmd'))
  const script = write(path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'custom.js'))
  write(path.join(root, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ bin: { codex: 'bin/custom.js' } }))
  assert.deepEqual(selectedDeliveryCli('codex', shim, 'win32', 'node-runtime'), { command: 'node-runtime', args: [script], bundledNode: true })
  assert.throws(() => selectedDeliveryCli('codex', root), /missing|not executable/)
})

test('corrupt executable-location storage reports an error without destroying the file', t => {
  const root = fixture(t)
  const file = write(path.join(root, 'agent-executable-overrides.json'), '{invalid')
  assert.throws(() => readExecutableOverrides(root), /Could not read/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid')
})

test('locating an ACP server preserves its executable without starting an interactive protocol session', async t => {
  const root = fixture(t)
  const file = write(path.join(root, 'agy_acp_server.par'), 'this file must not be executed during detection')
  assert.equal((await setExecutableOverride(root, 'antigravity-acp', file)).ok, true)
  assert.equal(readExecutableOverrides(root)['antigravity-acp'], file)
  assert.deepEqual(selectedDeliveryCli('antigravity-acp', file, 'win32'), { command: file, args: [] })
})
