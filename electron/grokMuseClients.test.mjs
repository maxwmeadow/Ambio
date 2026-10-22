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
        assert.deepEqual(settings.mcp_servers.ambio, { transport: 'stdio', enabled: true, mode: 'optional', command, args: [...args, '--ambio-host=muse'] })
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
    assert.deepEqual(inspectHostConfiguration(host).unreadablePaths, [host.configPath()])
    if (source !== '{invalid') assert.match(result.detail, /valid JSON.*server map/)
  }
})

for (const otherId of ['codex', 'grok', 'copilot-cli']) {
  for (const museFirst of [true, false]) {
    test(`Muse instructions survive ${otherId} setup and either removal order (Muse first: ${museFirst})`, t => {
      const { home, project } = fixture(t)
      const hosts = buildHosts(home)
      const muse = hosts.find(host => host.id === 'muse')
      const other = hosts.find(host => host.id === otherId)
      const claude = path.join(project, 'CLAUDE.md')
      const authored = '# Project contract\nKeep the billing workflow.\n'
      fs.writeFileSync(claude, authored)
      assert.ok(muse.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
      assert.ok(other.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
      const agents = path.join(project, 'AGENTS.md')
      assert.match(fs.readFileSync(agents, 'utf8'), /For Muse Code only: Read and follow.*CLAUDE.md/)
      assert.ok(inspectHostConfiguration(muse, project).workflowInstalled)
      const order = museFirst ? [muse, other] : [other, muse]
      assert.ok(uninstallHost(order[0], project, [order[1]]).ok)
      assert.ok(inspectHostConfiguration(order[1], project).workflowInstalled)
      assert.ok(uninstallHost(order[1], project).ok)
      assert.equal(fs.existsSync(agents), false)
      assert.ok(fs.readFileSync(claude, 'utf8').startsWith(authored))
      assert.doesNotMatch(fs.readFileSync(claude, 'utf8'), /ambio:draw-first/)
    })
  }
}

test('Muse cleans an older managed candidate after an externally created AGENTS.md changes precedence', t => {
  const { home, project } = fixture(t)
  const muse = buildHosts(home).find(host => host.id === 'muse')
  const original = path.join(project, '.claude', 'CLAUDE.md')
  fs.mkdirSync(path.dirname(original), { recursive: true })
  fs.writeFileSync(original, '# My original rules\n')
  assert.ok(muse.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# New authored rules\n')
  assert.ok(uninstallHost(muse, project).ok)
  assert.doesNotMatch(fs.readFileSync(original, 'utf8'), /ambio:draw-first/)
  assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), '# New authored rules\n')
})

test('Grok inspects ancestor configs through the nearest git root, including a worktree git file', t => {
  const { root, home, project } = fixture(t)
  const nested = path.join(project, 'packages', 'api')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(project, '.git'), 'gitdir: elsewhere\n')
  const locations = [path.join(project, '.grok', 'config.toml'), path.join(project, 'packages', '.grok', 'config.toml')]
  for (const file of [...locations, path.join(root, '.grok', 'config.toml')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '[mcp_servers.ambio]\ncommand = "node"\n')
  }
  const grok = buildHosts(home).find(host => host.id === 'grok')
  assert.deepEqual(new Set(inspectHostConfiguration(grok, nested).configuredPaths), new Set(locations))
  assert.ok(uninstallHost(grok, nested).ok)
  for (const file of locations) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /ambio/)
  assert.match(fs.readFileSync(path.join(root, '.grok', 'config.toml'), 'utf8'), /ambio/)
})

test('Muse appends to existing project instructions without shadowing them', t => {
  const { home, project } = fixture(t)
  const host = buildHosts(home).find(host => host.id === 'muse')
  const instructions = path.join(project, 'CLAUDE.md')
  fs.writeFileSync(instructions, '# Authored instructions\nKeep my workflow.\n')
  assert.ok(host.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
  const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')
  assert.match(agents, /For Muse Code only: Read and follow.*CLAUDE.md/)
  assert.match(agents, /ambio:draw-first/)
  assert.equal(fs.readFileSync(instructions, 'utf8'), '# Authored instructions\nKeep my workflow.\n')
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

test('shared compatibility files are reported, preserved and not counted as dedicated setup', t => {
  const { home, project } = fixture(t)
  const hosts = buildHosts(home)
  const claude = hosts.find(host => host.id === 'claude-code')
  const codex = hosts.find(host => host.id === 'codex')
  const grok = hosts.find(host => host.id === 'grok')
  const muse = hosts.find(host => host.id === 'muse')
  for (const host of [claude, codex]) assert.ok(host.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
  assert.equal(inspectHostConfiguration(grok, project).configured, false)
  assert.ok(inspectHostConfiguration(grok, project).inheritedPaths.includes(claude.configPath()))
  for (const host of [grok, muse]) {
    assert.ok(host.install('node', ['ambio.mjs'], '# Ambio mapping', project).ok)
    assert.ok(uninstallHost(host, project, [claude, codex]).ok)
    const remaining = inspectHostConfiguration(host, project)
    assert.equal(remaining.configured, false)
    assert.ok(remaining.inheritedPaths.includes(codex.commandPath(project)))
    assert.ok(fs.existsSync(claude.commandPath(project)))
  }
  assert.ok(inspectHostConfiguration(claude, project).configured)
  assert.ok(inspectHostConfiguration(codex, project).configured)
})

for (const id of ['codex', 'grok', 'copilot-cli']) {
  test(`${id} alone neither imports CLAUDE.md nor changes status when it appears`, t => {
    const {home,project}=fixture(t)
    const host=buildHosts(home).find(host=>host.id===id)
    assert.ok(host.install('node',['ambio.mjs'],'# Mapping',project).ok)
    const agents=path.join(project,'AGENTS.md')
    const source=fs.readFileSync(agents,'utf8')
    const claude=path.join(project,'CLAUDE.md')
    fs.writeFileSync(claude,'# Claude-only rules\n')
    assert.ok(inspectHostConfiguration(host,project).workflowInstalled)
    assert.ok(host.install('node',['ambio.mjs'],'# Mapping',project).ok)
    assert.equal(fs.readFileSync(agents,'utf8'),source)
    assert.doesNotMatch(source,/CLAUDE.md|muse-context/)
    fs.rmSync(claude)
    assert.ok(inspectHostConfiguration(host,project).workflowInstalled)
  })
}

test('Muse context choice remains stable when lower-priority files appear or disappear', t => {
  const {home,project}=fixture(t)
  const host=buildHosts(home).find(host=>host.id==='muse')
  assert.ok(host.install('node',['ambio.mjs'],'# Mapping',project).ok)
  const agents=path.join(project,'AGENTS.md')
  const source=fs.readFileSync(agents,'utf8')
  const claude=path.join(project,'CLAUDE.md')
  fs.writeFileSync(claude,'# Later Claude-only rules\n')
  assert.ok(inspectHostConfiguration(host,project).workflowInstalled)
  assert.ok(host.install('node',['ambio.mjs'],'# Mapping',project).ok)
  assert.equal(fs.readFileSync(agents,'utf8'),source)
  fs.rmSync(claude)
  assert.ok(inspectHostConfiguration(host,project).workflowInstalled)
})

test('an older checksum-valid shared pointer remains installed independent of CLAUDE.md presence', async t => {
  const {createHash}=await import('node:crypto')
  const {DRAW_FIRST_WORKFLOW}=await import('../src/shared/agentWorkflow.ts')
  const {home,project}=fixture(t)
  const host=buildHosts(home).find(host=>host.id==='codex')
  assert.ok(host.install('node',['ambio.mjs'],'# Mapping',project).ok)
  const payload="Read and follow the project's existing instructions in CLAUDE.md before working. Ambio's setup created this file; it does not replace those instructions.\n\n"+DRAW_FIRST_WORKFLOW+'\n'
  const checksum=createHash('sha256').update(payload).digest('hex')
  fs.writeFileSync(path.join(project,'AGENTS.md'),`<!-- ambio:draw-first:v1 sha256=${checksum} -->\n${payload}<!-- /ambio:draw-first -->\n`)
  assert.ok(inspectHostConfiguration(host,project).workflowInstalled)
  fs.writeFileSync(path.join(project,'CLAUDE.md'),'# Original\n')
  assert.ok(inspectHostConfiguration(host,project).workflowInstalled)
})
