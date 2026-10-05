import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RotatingLog, formatDiagnostics, redactHome } from './logging.ts'

test('a log rotates past its size limit and tails across backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-log-'))
  try {
    const log = new RotatingLog(path.join(dir, 'main.log'), 40, 2)
    for (let index = 0; index < 10; index++) log.write(`line ${index}`)
    assert.ok(fs.existsSync(path.join(dir, 'main.log.1')))
    assert.ok(!fs.existsSync(path.join(dir, 'main.log.3')))
    assert.deepEqual(log.tail(3), ['line 7', 'line 8', 'line 9'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('diagnostics never carry the home directory', () => {
  assert.equal(redactHome('/Users/sam/code/app and /Users/sam', '/Users/sam'), '~/code/app and ~')
  assert.equal(redactHome('C:\\Users\\sam\\repo', 'C:\\Users\\sam'), '~\\repo')
  const report = formatDiagnostics({
    appVersion: '0.1.0', electron: '31', chrome: '126', node: '20', platform: 'darwin', arch: 'arm64',
    osRelease: '24.0', locale: 'en-US', packaged: true, archdRunning: true, archdRestartsLastMinute: 0,
    projectCount: 2, logs: { main: [`opened ${os.homedir()}/secret-project`] },
  })
  assert.ok(!report.includes(os.homedir()))
  assert.match(report, /Ambio 0\.1\.0/)
})
