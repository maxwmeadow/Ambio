import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildHosts, detectHosts, inspectHostConfiguration } from './agentInstallers.ts'
import { uninstallHost } from './agentUninstall.ts'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-grok-muse-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  fs.mkdirSync(project, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, home, project }
}

for (const platform of ['linux', 'darwin', 'win32']) {
  for (const id of ['grok', 'muse']) {
    test(`${id} on ${platform}: install, repair and removal preserve other settings`, t => {
      const { root, home, project } = fixture(t)
      const appData = path.join(root, 'appdata')
      const host = buildHosts(home, appData, platform).find(host => host.id === id)
      assert.equal(detectHosts(home, appData, platform)[id], false)
      fs.mkdirSync(path.dirname(host.configPath()), { recursive: true })
      const unrelated = id === 'grok'
        ? 'model = "chosen-model"\r\n\r\n[mcp_servers.github]\r\ncommand = "github-server"\r\n'
        : JSON.stringify({ model: 'chosen-model', mcp_servers: { github: { transport: 'stdio', command: 'github-server', args: [] } } })
      fs.writeFileSync(host.configPath(), unrelated)
      fs.writeFileSync(path.join(project, 'AGENTS.md'), '# My rules\nKeep these instructions.\n')
      const command = path.join(root, 'Ambio install', 'node')
      const args = [path.join(root, 'Ambio install', 'mcp.mjs'), '--project=spaces and "quotes"']
      for (let i = 0; i < 2; i++) {
        const result = host.install(command, args, '# Ambio mapping', project)
        assert.ok(result.ok, result.detail)
        const status = inspectHostConfiguration(host, project)
        assert.ok(status.configured)
        assert.ok(status.workflowInstalled)
        assert.equal(detectHosts(home, appData, platform)[id], true)
      }
      const config = fs.readFileSync(host.configPath(), 'utf8')
      if (id === 'muse') {
        const settings = JSON.parse(config)
        assert.equal(settings.model, 'chosen-model')
        assert.deepEqual(settings.mcp_servers.ambio, { transport: 'stdio', enabled: true, mode: 'required', command, args: [...args, '--ambio-host=muse'] })
      } else {
        assert.equal((config.match(/^\[mcp_servers\.ambio\]/gm) ?? []).length, 1)
        assert.match(config, /model = "chosen-model"/)
        assert.match(config, /\[mcp_servers.github\]\r\ncommand = "github-server"/)
        assert.equal(JSON.parse(config.match(/^command = (.+)$/gm).at(-1).slice('command = '.length)), command)
        assert.deepEqual(JSON.parse(config.match(/^args = (.+)$/m)[1]), [...args, '--ambio-host=grok'])
      }
      fs.rmSync(host.commandPath(project))
      assert.equal(inspectHostConfiguration(host, project).workflowInstalled, false)
      assert.ok(host.install(command, args, '# Ambio mapping', project).ok)
      assert.ok(uninstallHost(host, project).ok)
      assert.equal(inspectHostConfiguration(host, project).configured, false)
      assert.equal(fs.existsSync(host.commandPath(project)), false)
      assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /Keep these instructions/)
      assert.doesNotMatch(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /ambio:draw-first/)
      const remaining = fs.readFileSync(host.configPath(), 'utf8')
      assert.match(remaining, /chosen-model/)
      assert.match(remaining, /github-server/)
      assert.doesNotMatch(remaining, /ambio/)
    })
  }
}

test('Grok and Muse config overrides are used by install, detection and uninstall', t => {
  const { root, home, project } = fixture(t)
  for (const id of ['grok', 'muse']) {
    const file = path.join(root, 'custom', `${id}.config`)
    const overrides = { [id]: file }
    const host = buildHosts(home, undefined, 'linux', overrides).find(host => host.id === id)
    assert.ok(host.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
    assert.equal(host.configPath(), file)
    assert.equal(detectHosts(home, undefined, 'linux', overrides)[id], true)
    assert.deepEqual(inspectHostConfiguration(host).configuredPaths, [file])
    assert.ok(uninstallHost(host, project).ok)
    assert.equal(inspectHostConfiguration(host).configured, false)
  }
})

test('Muse refuses malformed config or server maps without changing them', t => {
  const { home, project } = fixture(t)
  const host = buildHosts(home).find(host => host.id === 'muse')
  fs.mkdirSync(path.dirname(host.configPath()), { recursive: true })
  for (const source of ['{invalid', '[]', '{"mcp_servers":[]}', '{"mcp_servers":null}', '{"mcp_servers":"custom"}']) {
    fs.writeFileSync(host.configPath(), source)
    const result = host.install('node', ['ambio.mjs'], '# Ambio mapping', project)
    assert.equal(result.ok, false)
    assert.equal(fs.readFileSync(host.configPath(), 'utf8'), source)
    assert.equal(fs.existsSync(host.commandPath(project)), false)
  }
})

test('Muse appends to existing project instructions without shadowing them', t => {
  const { home, project } = fixture(t)
  const host = buildHosts(home).find(host => host.id === 'muse')
  const instructions = path.join(project, 'CLAUDE.md')
  fs.writeFileSync(instructions, '# Authored instructions\nKeep my workflow.\n')
  assert.ok(host.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
  assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false)
  assert.match(fs.readFileSync(instructions, 'utf8'), /Keep my workflow/)
  assert.match(fs.readFileSync(instructions, 'utf8'), /ambio:draw-first/)
  assert.ok(inspectHostConfiguration(host, project).workflowInstalled)
  assert.ok(uninstallHost(host, project).ok)
  assert.doesNotMatch(fs.readFileSync(instructions, 'utf8'), /ambio:draw-first/)
})

test('Grok and Muse share project rules without removing another configured client guidance', t => {
  const { home, project } = fixture(t)
  const hosts = buildHosts(home).filter(host => ['codex', 'grok', 'muse'].includes(host.id))
  for (const host of hosts) assert.ok(host.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
  for (let i = 0; i < hosts.length; i++) {
    assert.ok(uninstallHost(hosts[i], project, hosts.slice(i + 1)).ok)
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), i !== hosts.length - 1)
  }
})
