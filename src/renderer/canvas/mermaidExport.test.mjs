import assert from 'node:assert/strict'
import test from 'node:test'
import { mapAsMermaid } from './mermaidExport.ts'

test('systems nest, file dependencies roll up per system pair, infrastructure is a cylinder', () => {
  const text = mapAsMermaid({
    systems: [
      { id: 'shop', name: 'Shop', parentId: null },
      { id: 'orders', name: 'Orders', parentId: 'shop' },
      { id: 'pay', name: 'Payments "v2"', parentId: null },
    ],
    files: [{ id: 'f1', systemId: 'orders' }, { id: 'f2', systemId: 'orders' }, { id: 'f3', systemId: 'pay' }, { id: 'loose', systemId: null }],
    infraNodes: [{ id: 'redis', name: 'Redis', status: 'confirmed' }, { id: 'gone', name: 'Gone', status: 'dismissed' }],
    dependencies: [
      { src: 'f1', dst: 'f3', srcType: 'file', dstType: 'file', dependencyType: 'IMPORTS' },
      { src: 'f2', dst: 'f3', srcType: 'file', dstType: 'file', dependencyType: 'CALLS' },
      { src: 'f1', dst: 'f2', srcType: 'file', dstType: 'file', dependencyType: 'IMPORTS' },
      { src: 'loose', dst: 'f3', srcType: 'file', dstType: 'file', dependencyType: 'IMPORTS' },
      { src: 'f3', dst: 'redis', srcType: 'file', dstType: 'infra', dependencyType: 'WRITES' },
      { src: 'f3', dst: 'gone', srcType: 'file', dstType: 'infra', dependencyType: 'READS' },
    ],
  })
  assert.equal(text, [
    'flowchart LR',
    '  s1["Payments #quot;v2#quot;"]',
    '  subgraph s2["Shop"]',
    '    s3["Orders"]',
    '  end',
    '  i4[("Redis")]',
    '  s3 -->|2| s1',
    '  s1 -.->|writes| i4',
    '',
  ].join('\n'))
})
