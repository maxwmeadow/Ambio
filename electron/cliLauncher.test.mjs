import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { installCliLauncher, launcherScript } from './cliLauncher.ts'

test('the launcher script passes every argument to the app', () => {
  assert.match(launcherScript('/Applications/Axiom.app/Contents/MacOS/Axiom', 'darwin'), /nohup "\/Applications\/Axiom\.app\/Contents\/MacOS\/Axiom" "\$@"/)
  assert.match(launcherScript('C:\\Axiom\\Axiom.exe', 'win32'), /start "" "C:\\Axiom\\Axiom\.exe" %\*/)
})

test('installs into a writable folder on PATH, or says exactly what to run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cli-'))
  try {
    const localBin = path.join(home, '.local', 'bin')
    fs.mkdirSync(localBin, { recursive: true })
    const installed = installCliLauncher({
      executable: '/opt/Axiom/axiom', configDir: path.join(home, '.axiom'), home,
      env: { PATH: ['/usr/bin', localBin].join(path.delimiter) }, platform: 'linux',
    })
    assert.ok(installed.ok, installed.detail)
    assert.equal(installed.path, path.join(localBin, 'axiom'))
    assert.match(fs.readFileSync(installed.path, 'utf8'), /\/opt\/Axiom\/axiom/)

    const manual = installCliLauncher({
      executable: '/opt/Axiom/axiom', configDir: path.join(home, '.axiom'), home,
      env: { PATH: '/usr/bin' }, platform: 'linux',
    })
    assert.equal(manual.ok, false)
    assert.match(manual.manual, /sudo ln -sf .*\.axiom[\\/]bin[\\/]axiom" \/usr\/local\/bin\/axiom/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
