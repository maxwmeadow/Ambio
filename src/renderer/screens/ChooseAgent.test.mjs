import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Render the real setup view with deterministic discovery and model controls.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./ChooseAgent.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external',
  plugins: [{ name: 'setup-controls', setup(builder) {
    builder.onResolve({ filter: /(?:MapWithAgent|AgentChatPanel|AgentModelMenu)$/ }, args => ({ path: args.path, namespace: 'setup-test' }))
    builder.onLoad({ filter: /.*/, namespace: 'setup-test' }, args => ({ contents:
      args.path.endsWith('MapWithAgent') ? 'export const CHAT_SETUP="chat-setup"; export const startMapping=()=>{}; export const useRunnableChoices=()=>globalThis.ambioSetupChoices;'
        : args.path.endsWith('AgentChatPanel') ? 'export const OPEN_MODEL_SERVICES="model-services";'
          : 'export const AgentModelSelect=()=>null; export const useAgentModel=()=>({value:""});', loader: 'js' }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { ChooseAgent } = module.exports
const hosts = [
  { id: 'grok', label: 'Grok Build CLI', modality: 'cli' },
  { id: 'muse', label: 'Muse Code CLI', modality: 'cli' },
  { id: 'codex', label: 'Codex', modality: 'cli' },
].map(host => ({ ...host, configured: true, workflowInstalled: true, sharedSurfaces: [] }))

for (const selectedAppId of ['grok', 'muse']) {
  test(`guided setup displays and preserves preselected ${selectedAppId} alongside runnable agents`, t => {
    globalThis.ambioSetupChoices = [{ id: 'codex', label: 'Codex', kind: 'run', host: { id: 'codex' } }]
    t.after(() => { delete globalThis.ambioSetupChoices })
    const html = renderToStaticMarkup(React.createElement(ChooseAgent, {
      hosts, selectedAppId, stateOf: () => 'installed', blankProject: false,
      workspaceId: 'fixture', projectRoot: '/fixture', notes: {}, locateNotices: {},
      onChoice() {}, onSelectApp() {},
    }))
    const otherApps = html.split('In another app')[1]
    assert.match(otherApps, /Grok Build CLI/)
    assert.match(otherApps, /Muse Code CLI/)
    assert.doesNotMatch(otherApps, /<strong>Codex<\/strong>/)
    const name = hosts.find(host => host.id === selectedAppId).label
    assert.ok(html.includes(`aria-checked="true"`) && html.includes(`Continue with ${name}`))
    assert.doesNotMatch(html, /Map with (Grok|Muse)/)
  })
}

test('MCP-only CLIs stay visible while runnable discovery is unavailable', t => {
  globalThis.ambioSetupChoices = null
  t.after(() => { delete globalThis.ambioSetupChoices })
  const html = renderToStaticMarkup(React.createElement(ChooseAgent, {
    hosts, selectedAppId: 'muse', stateOf: () => 'installed', blankProject: false,
    workspaceId: 'fixture', projectRoot: '/fixture', notes: {}, locateNotices: {}, onChoice() {},
  }))
  assert.match(html, /Grok Build CLI/)
  assert.match(html, /Continue with Muse Code CLI/)
})
