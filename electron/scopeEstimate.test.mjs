import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { estimateScope } from './scopeEstimate.ts'

test('the estimate counts what archd would index and names the heaviest folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-scope-'))
  const write = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), '') }
  try {
    for (let i = 0; i < 5; i++) write(`generated/g${i}.ts`)
    for (let i = 0; i < 2; i++) write(`src/s${i}.ts`)
    write('main.go')
    write('node_modules/lib/index.js')
    write('.cache/x.ts')
    write('docs/readme.md')
    write('web/app.min.js')
    const all = estimateScope(root, [])
    assert.equal(all.sourceFiles, 8)
    assert.equal(all.documents, 1)
    write('src/api/routes/a.ts')
    const nested = estimateScope(root, [])
    assert.equal(nested.folders[path.join(root, 'src')], 3)
    assert.equal(nested.folders[path.join(root, 'src', 'api')], 1)
    assert.equal(nested.folders[path.join(root, 'src', 'api', 'routes')], 1)
    assert.equal(nested.folders[path.join(root, 'node_modules')], undefined)
    fs.rmSync(path.join(root, 'src', 'api'), { recursive: true })
    assert.deepEqual(all.largest.map(entry => [entry.name, entry.sourceFiles]), [['generated', 5], ['src', 2]])
    const trimmed = estimateScope(root, [`${path.join(root, 'generated')}/**`])
    assert.equal(trimmed.sourceFiles, 3)
    assert.equal(estimateScope(root, [], { maxEntries: 2 }).truncated, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a new project skips generated folders nested where the tree was never opened, by what they hold', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-scope-'))
  const write = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), '') }
  try {
    write('backend/app.py')
    write('backend/venv/pyvenv.cfg')
    for (let i = 0; i < 4; i++) write(`backend/venv/Lib/site-packages/pkg${i}.py`)
    write('backend/py311/pyvenv.cfg')
    write('backend/py311/Lib/site.py')
    write('web/coverage/lcov.info')
    write('web/coverage/lcov-report/prettify.js')
    // Named like tool output, but the app's own code.
    write('web/src/components/coverage/CoverageMap.tsx')
    write('backend/tools/bin/run.sh')
    const venv = path.join(root, 'backend', 'venv')
    const py311 = path.join(root, 'backend', 'py311')
    const report = path.join(root, 'web', 'coverage')

    const existing = estimateScope(root, [])
    assert.equal(existing.sourceFiles, 9, 'a project already set up keeps its saved choices')
    assert.deepEqual(existing.skippedFolders, [])

    const fresh = estimateScope(root, [], {}, [])
    assert.equal(fresh.sourceFiles, 3, 'app.py, CoverageMap.tsx and run.sh')
    assert.deepEqual(fresh.skippedFolders, [py311, venv, report].sort())

    const kept = estimateScope(root, [], {}, [py311])
    assert.equal(kept.sourceFiles, 4, 'a virtualenv shown checked is read')
    assert.deepEqual(kept.skippedFolders, [venv, report].sort())
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
