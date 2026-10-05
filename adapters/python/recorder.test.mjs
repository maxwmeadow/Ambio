import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTER = dirname(fileURLToPath(import.meta.url))
const PYTHON = ['python3', 'python'].find(bin => spawnSync(bin, ['--version']).status === 0)

// Ubuntu's own sitecustomize installs apport's sys.excepthook. Ambio's
// sitecustomize shadows it and chain-loads it, so the recorder must still
// see a crash after that hook is installed.
test('a crash is recorded when another sitecustomize installs its own excepthook', { skip: !PYTHON && 'no python on this machine' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ambio-pyrec-')))
  const evidence = join(root, '.evidence')
  const system = join(root, 'system-site')
  mkdirSync(system)
  writeFileSync(join(system, 'sitecustomize.py'), [
    'import sys',
    'def apport_like_hook(etype, value, tb):',
    '    sys.__excepthook__(etype, value, tb)',
    'sys.excepthook = apport_like_hook',
  ].join('\n'))
  writeFileSync(join(root, 'stock.py'), 'def ship(qty):\n    raise ValueError("cannot ship %d" % qty)\n\nship(9)\n')
  const result = spawnSync(PYTHON, ['stock.py'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: [ADAPTER, system].join(delimiter),
      AMBIO_WORKSPACE_ROOT: root,
      AMBIO_EVIDENCE_DIR: evidence,
      AMBIO_RUN_ID: 'r1',
      AMBIO_WATCHES: '[]',
    },
  })
  assert.notEqual(result.status, 0)
  const docs = readdirSync(evidence).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(evidence, f), 'utf8')))
  assert.equal(docs.length, 1, `expected one evidence file; stderr:\n${result.stderr}`)
  assert.deepEqual(docs[0].uncaught.map(u => u.what), ['ValueError: cannot ship 9'])
  assert.match(result.stderr, /ValueError: cannot ship 9/, 'the chained hook still prints the traceback')
})
