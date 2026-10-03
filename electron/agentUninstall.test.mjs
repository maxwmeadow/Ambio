import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildHosts, inspectHostConfiguration } from './agentInstallers.ts'
import { removeLegacyServer, removeTomlAmbioTable, removeXmlAmbioEntry, uninstallAll, uninstallHost } from './agentUninstall.ts'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-uninstall-'))
  const appData = path.join(home, 'AppData')
  const project = path.join(home, 'project')
  fs.mkdirSync(project, { recursive: true })
  // Other tools' configuration that must survive.
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh' } } }))
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.github]\ncommand = "gh"\n')
  return { home, appData, project, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('uninstalling every agent removes only what Ambio wrote', () => {
  const { home, appData, project, cleanup } = fixture()
  try {
    const hosts = buildHosts(home, appData, 'linux')
    for (const host of hosts) {
      const result = host.install('/opt/ambio/archd', ['mcp-run', '/opt/ambio/Ambio', '/opt/ambio/mcp.mjs'], '# Ambio - map', project)
      assert.ok(result.ok, `${host.id}: ${result.detail}`)
      assert.ok(inspectHostConfiguration(host, project).configured, `${host.id} not configured after install`)
    }

    const result = uninstallAll(hosts, project)
    assert.ok(result.ok, result.detail)
    for (const host of hosts) {
      const status = inspectHostConfiguration(host, project)
      assert.equal(status.configured, false, `${host.id} still configured: ${status.configuredPaths}`)
      if (host.commandPath) assert.ok(!fs.existsSync(host.commandPath(project)), `${host.id} workflow left behind`)
    }

    const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
    assert.deepEqual(cursor.mcpServers, { github: { command: 'gh' } })
    const codex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    assert.match(codex, /model = "o3"/)
    assert.match(codex, /\[mcp_servers\.github\]/)
    assert.doesNotMatch(codex, /ambio/)
  } finally {
    cleanup()
  }
})

test('an agent set up under the old name loses only its axiom entries', () => {
  const { home, appData, project, cleanup } = fixture()
  try {
    // Install as before the rename: every file the installers write, renamed.
    const hosts = buildHosts(home, appData, 'linux')
    const written = new Set()
    for (const host of hosts) {
      for (const file of host.install('node', ['/mcp.mjs'], '# Ambio - map', project).paths) written.add(file)
    }
    const legacyFiles = []
    for (const file of written) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
      const legacy = file.replace(/ambio-(map|inbox)/g, 'axiom-$1')
      const text = fs.readFileSync(file, 'utf8').replace(/ambio/g, 'axiom').replace(/Ambio/g, 'Axiom')
      if (legacy !== file) fs.rmSync(file)
      fs.mkdirSync(path.dirname(legacy), { recursive: true })
      fs.writeFileSync(legacy, text)
      legacyFiles.push(legacy)
    }

    for (const host of hosts) removeLegacyServer(host, project)
    const skillFolders = new Set(hosts.flatMap(host => host.commandPath ? [path.dirname(path.dirname(host.commandPath(project)))] : []))
    for (const file of legacyFiles) {
      if (/axiom-(map|inbox)/.test(file)) {
        // Only the skills uninstall knows about (WORK Inbox: Devin's copy).
        if (!skillFolders.has(path.dirname(path.dirname(file)))) continue
        assert.ok(!fs.existsSync(file), `${file} left behind`)
        continue
      }
      const text = fs.readFileSync(file, 'utf8')
      assert.doesNotMatch(text, /"axiom"\s*:|\[mcp_servers\.axiom\]|key="axiom"/, `${file} still lists axiom`)
    }
    const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
    assert.deepEqual(cursor.mcpServers, { github: { command: 'gh' } })
    assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.github\]/)
  } finally {
    cleanup()
  }
})

test('a workflow folder shared with a still-configured agent is kept', () => {
  const { home, appData, project, cleanup } = fixture()
  try {
    const hosts = buildHosts(home, appData, 'linux')
    const copilot = hosts.find(host => host.id === 'copilot')
    const copilotCli = hosts.find(host => host.id === 'copilot-cli')
    copilot.install('node', ['/mcp.mjs'], '# Ambio', project)
    copilotCli.install('node', ['/mcp.mjs'], '# Ambio', project)
    uninstallHost(copilot, project, hosts)
    // VS Code's own files lose the entry...
    const vscodeFiles = copilot.serverLocations(project)
      .map(location => location.path)
      .filter(file => !copilotCli.serverLocations(project).some(location => location.path === file))
    for (const file of vscodeFiles) {
      if (!fs.existsSync(file)) continue
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /"ambio"/, `${file} still has Ambio`)
    }
    // ...while the CLI keeps its entry and the skill folder it shares.
    assert.ok(inspectHostConfiguration(copilotCli, project).configured, 'the CLI lost its configuration')
    assert.ok(fs.existsSync(copilotCli.commandPath(project)), 'the CLI lost the skill it still uses')
  } finally {
    cleanup()
  }
})

test('unparseable configuration is reported, never rewritten', () => {
  const { home, appData, project, cleanup } = fixture()
  try {
    const broken = path.join(home, '.cursor', 'mcp.json')
    fs.writeFileSync(broken, '{ not json')
    const cursor = buildHosts(home, appData, 'linux').find(host => host.id === 'cursor')
    const result = uninstallHost(cursor, project)
    assert.equal(result.ok, false)
    assert.equal(fs.readFileSync(broken, 'utf8'), '{ not json')
  } finally {
    cleanup()
  }
})

test('TOML and XML removal touch only the ambio entry', () => {
  assert.equal(
    removeTomlAmbioTable('a = 1\n\n[mcp_servers.ambio]\ncommand = "x"\n\n[mcp_servers.ambio.env]\nK = "v"\n\n[other]\nb = 2\n'),
    'a = 1\n\n[other]\nb = 2\n',
  )
  const xml = '<map>\n        <entry key="github"><value/></entry>\n        <entry key="ambio">\n          <value/>\n        </entry>\n      </map>'
  assert.equal(removeXmlAmbioEntry(xml), '<map>\n        <entry key="github"><value/></entry>\n      </map>')
})
