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
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', loader: { '.svg': 'dataurl', '.css': 'empty' },
  plugins: [{ name: 'setup-controls', setup(builder) {
    builder.onResolve({ filter: /(?:MapWithAgent|AgentChatPanel|AgentModelMenu)$/ }, args => ({ path: args.path, namespace: 'setup-test' }))
    builder.onLoad({ filter: /.*/, namespace: 'setup-test' }, args => ({ contents:
      args.path.endsWith('MapWithAgent') ? 'export const CHAT_SETUP="chat-setup"; export const startMapping=()=>{}; export const useRunnableChoices=()=>({choices:globalThis.ambioSetupChoices??[],loading:globalThis.ambioSetupChoices==null,error:\'\',refresh:async()=>{}});'
        : args.path.endsWith('AgentChatPanel') ? 'export const OPEN_MODEL_SERVICES="model-services";'
          : 'export const AgentModelSelect=()=>null; export const useAgentModel=()=>({value:""});', loader: 'js' }))
  } }],
})
const module = { exports: {} }
const require = createRequire(import.meta.url)
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(name => name === 'react' ? {
  ...React, useState: initial => React.useState(initial === null ? globalThis.ambioSetupSelection ?? null : initial),
} : require(name), module, module.exports)
const { ChooseAgent } = module.exports
const hosts = [
  { id: 'grok', label: 'Grok Build CLI', modality: 'cli' },
  { id: 'muse', label: 'Muse Code CLI', modality: 'cli' },
  { id: 'claude-code', label: 'Claude Code', modality: 'cli' },
  { id: 'cursor', label: 'Cursor', modality: 'editor' },
].map(host => ({ ...host, configured: true, detected: true, workflowInstalled: true, sharedSurfaces: [] }))
function render(selectedAppId = 'cursor') {
  return renderToStaticMarkup(React.createElement(ChooseAgent, {
    hosts, selectedAppId, stateOf: () => 'installed', blankProject: false,
    workspaceId: 'fixture', projectRoot: '/fixture', notes: {}, locateNotices: {}, onChoice() {}, onSelectApp() {},
  }))
}
function choices(t) {
  globalThis.ambioSetupChoices = hosts.filter(host => host.modality === 'cli').map(host => ({ id: host.id, label: host.label, kind: 'run', host: { ...host, route: 'run', available: true, detail: '' } }))
  t.after(() => { delete globalThis.ambioSetupChoices; delete globalThis.ambioSetupSelection })
}
// The selected agent is the checked pill; its Map/Continue action opens beside it.
const checked = (html, label) => new RegExp(`role="radio" aria-checked="true" aria-label="${label} —`).test(html)
test('an automatically preselected Cursor does not override a runnable agent', t => {
  choices(t)
  // Discovery's first runnable agent remains the setup default.
  globalThis.ambioSetupChoices.reverse()
  const html = render()
  assert.ok(checked(html, 'Claude Code'))
  assert.equal(checked(html, 'Cursor IDE'), false)
})
for (const id of ['grok', 'muse']) {
  test(`an explicit ${id} selection maps with it from Ambio`, t => {
    choices(t)
    globalThis.ambioSetupSelection = id
    const html = render()
    assert.ok(checked(html, hosts.find(host => host.id === id).label))
    const otherApps = html.split('In another app')[1]
    assert.doesNotMatch(otherApps, /<strong>(Grok Build CLI|Muse Code CLI)<\/strong>/)
  })
}
test('an installed editor stays available while launch discovery is loading', t => {
  choices(t)
  globalThis.ambioSetupChoices = null
  // With nothing runnable yet, setup falls back to the installed editor.
  assert.ok(checked(render(), 'Cursor IDE'))
})
