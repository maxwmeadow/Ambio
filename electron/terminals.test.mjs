import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Terminals, terminalSize } from './terminals.ts'
import { detectTerminalProfiles } from './terminalProfiles.ts'

test('PTY sessions enforce ownership, resize bounds, flow control and cleanup', () => {
  const writes = [], sizes = [], events = []
  let data, exit, paused = 0, resumed = 0, killed = 0, options
  const manager = new Terminals((_path, _args, input) => {
    options = input
    return { onData: listener => { data = listener }, onExit: listener => { exit = listener }, write: text => writes.push(text),
      resize: (...size) => sizes.push(size), pause: () => paused++, resume: () => resumed++, kill: () => killed++ }
  })
  const profile = { id: 'shell', path: '/shell', label: 'Shell', args: ['-l'] }
  const input = { id: 'session-1', workspaceId: 'project', profileId: profile.id, cols: 80, rows: 24 }
  manager.start(7, input, profile, tmpdir(), event => events.push(event))
  assert.equal(options.cwd, tmpdir())
  assert.equal(options.name, 'xterm-256color')
  assert.equal(options.env.TERM_PROGRAM, 'Ambio')
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined)
  manager.write(8, input.id, 'wrong owner'); manager.stop(8, input.id)
  manager.write(7, input.id, 'hello\r')
  manager.resize(7, input.id, 100, 30)
  assert.deepEqual(writes, ['hello\r']); assert.deepEqual(sizes, [[100, 30]])
  assert.throws(() => manager.start(7, input, profile, tmpdir(), () => {}), /Invalid terminal session/)
  assert.throws(() => terminalSize(NaN, 10), /Invalid terminal size/)
  assert.throws(() => terminalSize(1, 10), /Invalid terminal size/)
  data('x'.repeat(300000)); assert.equal(paused, 1)
  manager.acknowledge(8, input.id, 300000); assert.equal(resumed, 0)
  manager.acknowledge(7, input.id, 300000); assert.equal(resumed, 1)
  assert.equal(events[0].type, 'data')
  manager.stopOwner(7); assert.equal(killed, 1)
  manager.close(); assert.equal(killed, 1)
  exit({ exitCode: 0 }); assert.equal(events.length, 1)
  manager.start(7, input, profile, tmpdir(), event => events.push(event))
  exit({ exitCode: 12 }); assert.deepEqual(events.at(-1), { id: input.id, type: 'exit', exitCode: 12 })
  manager.close(); assert.equal(killed, 1)
})

test('shell discovery finds PATH shells, the default shell, custom paths and deduplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ambio-shells-'))
  try {
    await mkdir(join(root, 'bin'))
    const shell = join(root, 'bin', 'fish'), custom = join(root, 'custom-shell')
    await writeFile(shell, ''); await chmod(shell, 0o755)
    await writeFile(custom, ''); await chmod(custom, 0o755)
    for (const platform of ['darwin', 'linux']) {
      const profiles = await detectTerminalProfiles(platform, { SHELL: shell, PATH: join(root, 'bin') }, [custom, shell, join(root, 'missing')])
      assert.equal(profiles[0].path, shell)
      assert.equal(profiles.filter(profile => profile.path === shell).length, 1)
      assert.ok(profiles.some(profile => profile.path === custom))
      assert.ok(!profiles.some(profile => profile.path.endsWith('missing')))
    }
    const cmd = join(root, 'cmd.exe'); await writeFile(cmd, '')
    const windows = await detectTerminalProfiles('win32', { SystemRoot: root, ProgramFiles: root, LOCALAPPDATA: root, ComSpec: cmd, PATH: root })
    assert.equal(windows.filter(profile => profile.path === cmd).length, 1)
    assert.ok(windows.some(profile => profile.label === 'Command Prompt'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
