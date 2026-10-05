import assert from 'node:assert/strict'
import test from 'node:test'
import { looksLikeMermaid, mermaidToSheetMarkdown } from './mermaidImport.ts'
import { mapAsMermaid } from './mermaidExport.ts'

test('a sketch drafts new boxes and keeps what the map already has as context', () => {
  const sketch = [
    '```mermaid',
    'flowchart LR',
    '  api["Public API"] --> queue[Job Queue]',
    '  queue -.->|writes| db[(Postgres)]',
    '  worker --> queue',
    '```',
  ].join('\n')
  assert.ok(looksLikeMermaid(sketch))
  assert.equal(mermaidToSheetMarkdown(sketch, { systems: ['Public API'], infra: ['Postgres'] }, 'Queue plan'), [
    '# Queue plan', '',
    '## Context', '- system `Public API`', '- infrastructure `Postgres`', '',
    '## Add', '- system `Job Queue`', '- system `worker`', '',
    '## Connections', '- `Public API` DEPENDS_ON `Job Queue`', '- `Job Queue` WRITES `Postgres`', '- `worker` DEPENDS_ON `Job Queue`', '',
  ].join('\n'))
})

test('Copy Map as Mermaid reads back as context only', () => {
  const diagram = mapAsMermaid({
    systems: [{ id: 'shop', name: 'Shop', parentId: null }, { id: 'orders', name: 'Orders', parentId: 'shop' }],
    files: [], infraNodes: [{ id: 'r', name: 'Redis', status: 'confirmed' }], dependencies: [],
  })
  const spec = mermaidToSheetMarkdown(diagram, { systems: ['Shop', 'Orders'], infra: ['Redis'] })
  assert.ok(!spec.includes('## Add'), spec)
  assert.match(spec, /- system `Orders`/)
  assert.equal(looksLikeMermaid('# A spec'), false)
})
