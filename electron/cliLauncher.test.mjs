import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { installCliLauncher, launcherScript } from './cliLauncher.ts'

test('the launcher script passes every argument to the app', () => {
  assert.match(launcherScript('/Applications/Ambio.app/Contents/MacOS/Ambio', 'darwin'), /nohup "\/Applications\/Ambio\.app\/Contents\/MacOS\/Ambio" "\$@"/)
  assert.match(launcherScript('C:\\Ambio\\Ambio.exe', 'win32'), /start "" "C:\\Ambio\\Ambio\.exe" %\*/)
})

test('installs into a writable folder on PATH, or says exactly what to run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-cli-'))
  try {
    const localBin = path.join(home, '.local', 'bin')
    fs.mkdirSync(localBin, { recursive: true })
    const installed = installCliLauncher({
      executable: '/opt/Ambio/ambio', configDir: path.join(home, '.ambio'), home,
      env: { PATH: ['/usr/bin', localBin].join(path.delimiter) }, platform: 'linux',
    })
    assert.ok(installed.ok, installed.detail)
    assert.equal(installed.path, path.join(localBin, 'ambio'))
    assert.match(fs.readFileSync(installed.path, 'utf8'), /\/opt\/Ambio\/ambio/)

    const manual = installCliLauncher({
      executable: '/opt/Ambio/ambio', configDir: path.join(home, '.ambio'), home,
      env: { PATH: '/usr/bin' }, platform: 'linux',
    })
    assert.equal(manual.ok, false)
    assert.match(manual.manual, /sudo ln -sf .*\.ambio[\\/]bin[\\/]ambio" \/usr\/local\/bin\/ambio/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
