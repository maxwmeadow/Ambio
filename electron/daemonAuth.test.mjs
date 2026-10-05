import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DaemonUnavailableError, daemonFetch, resolveDaemonUrl } from './daemonAuth.ts'

const TOKEN = 'x'.repeat(40)

function freePort() {
  return new Promise(resolve => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

test('without a way to start archd, an unreachable daemon says to open Ambio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-daemon-'))
  const saved = { ...process.env }
  try {
    process.env.AMBIO_API_TOKEN_FILE = path.join(dir, 'api-token')
    delete process.env.AMBIO_ARCHD_PATH
    delete process.env.AMBIO_API_TOKEN
    const port = await freePort()
    await assert.rejects(daemonFetch(`http://127.0.0.1:${port}/api/anything`), error =>
      error instanceof DaemonUnavailableError && /Open the Ambio app/.test(error.message))
  } finally {
    process.env = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreachable daemon is started headless and the request retried', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-daemon-'))
  const saved = { ...process.env }
  const port = await freePort()
  // A stand-in archd: writes its token and serves until killed.
  const fake = path.join(dir, 'fake-archd.mjs')
  fs.writeFileSync(fake, `
    import http from 'node:http'
    import fs from 'node:fs'
    const dataDir = process.argv[process.argv.indexOf('-data') + 1]
    fs.writeFileSync(dataDir + '/args', process.argv.slice(2).join(' '))
    http.createServer((req, res) => {
      res.end(JSON.stringify({ auth: req.headers.authorization, url: req.url }))
    }).listen(${port}, '127.0.0.1', () => fs.writeFileSync(dataDir + '/api-token', '${TOKEN}'))
    setTimeout(() => process.exit(0), 5000)
  `)
  const launcher = path.join(dir, 'archd')
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 })
  try {
    process.env.AMBIO_ACTIVE_PROJECT = path.join(dir, 'active_project.json')
    delete process.env.AMBIO_API_TOKEN_FILE
    delete process.env.AMBIO_API_TOKEN
    process.env.AMBIO_ARCHD_PATH = launcher
    const response = await daemonFetch(`http://127.0.0.1:${port}/api/snapshot/x`)
    const body = await response.json()
    assert.equal(body.url, '/api/snapshot/x')
    assert.equal(body.auth, `Bearer ${TOKEN}`)
    assert.equal(fs.readFileSync(path.join(dir, 'args'), 'utf8'), `-data ${dir} -headless -auto-ports`)
  } finally {
    process.env = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('requests to the default port follow archd to the port it published', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-daemon-'))
  const saved = { ...process.env }
  try {
    process.env.AMBIO_ACTIVE_PROJECT = path.join(dir, 'active_project.json')
    assert.equal(resolveDaemonUrl('http://127.0.0.1:7743/api/x').port, '7743')
    fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: 1, apiPort: 51234 }))
    assert.equal(resolveDaemonUrl('http://127.0.0.1:7743/api/x').href, 'http://127.0.0.1:51234/api/x')
    // An explicitly configured address is never rewritten.
    assert.equal(resolveDaemonUrl('http://127.0.0.1:9999/api/x').port, '9999')
  } finally {
    process.env = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
