import assert from 'node:assert/strict'
import test from 'node:test'

import { COMMANDS, buildMenu, commandForKey, formatAccelerator, paletteCommands } from './appMenu.ts'

const key = (overrides) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides })

test('CmdOrCtrl means Command on macOS and Control elsewhere', () => {
  assert.equal(commandForKey(key({ key: 'p', metaKey: true, shiftKey: true }), 'darwin'), 'view.commandPalette')
  assert.equal(commandForKey(key({ key: 'P', ctrlKey: true, shiftKey: true }), 'win32'), 'view.commandPalette')
  assert.equal(commandForKey(key({ key: 'p', ctrlKey: true, shiftKey: true }), 'darwin'), null)
})

test('shifted digits and symbols match by physical key', () => {
  assert.equal(commandForKey(key({ key: '0', code: 'Digit0', ctrlKey: true }), 'linux'), 'view.fitView')
  assert.equal(commandForKey(key({ key: '+', code: 'Equal', ctrlKey: true }), 'win32'), 'view.zoomMapIn')
  // Option changes the character on macOS; the physical key still matches.
  assert.equal(commandForKey(key({ key: '≠', code: 'Equal', metaKey: true, altKey: true }), 'darwin'), 'view.zoomIn')
  assert.equal(commandForKey(key({ key: 'L', ctrlKey: true, shiftKey: true }), 'linux'), 'map.tidy')
  assert.equal(commandForKey(key({ key: 'k' }), 'linux'), null)
})

test('every accelerator is unique on each platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const seen = new Map()
    for (const spec of Object.values(COMMANDS)) {
      if (!spec.accelerator) continue
      const shown = formatAccelerator(spec.accelerator, platform)
      assert.ok(!seen.has(shown), `${shown} used by ${seen.get(shown)} and ${spec.id} on ${platform}`)
      seen.set(shown, spec.id)
    }
  }
})

test('shortcuts are written the way each platform writes them', () => {
  assert.equal(formatAccelerator('CmdOrCtrl+Shift+P', 'darwin'), '⇧⌘P')
  assert.equal(formatAccelerator('CmdOrCtrl+Shift+P', 'win32'), 'Ctrl+Shift+P')
  assert.equal(formatAccelerator('F11', 'linux'), 'F11')
})

test('macOS keeps app items in the app menu; other platforms use File and Help', () => {
  const mac = buildMenu('darwin').map(section => section.id)
  assert.deepEqual(mac, ['app', 'file', 'edit', 'view', 'go', 'map', 'agent', 'window', 'help'])
  const windows = buildMenu('win32')
  assert.deepEqual(windows.map(section => section.id), ['file', 'edit', 'view', 'go', 'map', 'agent', 'help'])
  const help = windows.find(section => section.id === 'help').entries
  assert.ok(help.some(entry => entry.kind === 'command' && entry.id === 'app.about'))
  const developer = buildMenu('linux', { developer: true }).find(section => section.id === 'view').entries
  assert.ok(developer.some(entry => entry.kind === 'role' && entry.role === 'toggleDevTools'))
  const plain = buildMenu('linux').find(section => section.id === 'view').entries
  assert.ok(!plain.some(entry => entry.kind === 'role' && entry.role === 'toggleDevTools'))
})

test('every command is reachable from the menu bar on every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const entries = buildMenu(platform).flatMap(section => section.entries)
    const inMenu = new Set(entries.filter(entry => entry.kind === 'command').map(entry => entry.id))
    // Open Recent always ends with Clear Recently Opened.
    if (entries.some(entry => entry.kind === 'recent')) inMenu.add('project.clearRecent')
    for (const id of Object.keys(COMMANDS)) assert.ok(inMenu.has(id), `${id} missing from the ${platform} menu`)
  }
})

test('the palette filters by words and hides project commands on the launcher', () => {
  assert.ok(paletteCommands('', false).every(spec => !spec.needsProject))
  assert.ok(paletteCommands('', true).some(spec => spec.id === 'view.search'))
  assert.deepEqual(paletteCommands('report bug', true).map(spec => spec.id), ['help.reportBug'])
  assert.ok(!paletteCommands('palette', true).some(spec => spec.id === 'view.commandPalette'))
  assert.equal(paletteCommands('set', false)[0].id, 'app.settings')
  assert.equal(paletteCommands('zoom', false)[0].id, 'view.zoomIn')
  assert.equal(paletteCommands('log', true)[0].id, 'view.agentLog')
})
