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
