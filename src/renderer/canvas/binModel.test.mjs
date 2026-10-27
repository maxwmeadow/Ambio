import assert from 'node:assert/strict'
import test from 'node:test'
import { createLooseFileLookup, partitionCanvasFiles, sortForBin } from './binModel.ts'

const file = (relPath, overrides = {}) => ({
  id: relPath,
  rootId: 'root',
  path: `/repo/${relPath}`,
  relPath,
  language: 'python',
  systemId: null,
  lineCount: 1,
  churnScore: 0,
  indexedAt: 0,
  ...overrides,
})

const liveHome = { hasHome: f => !!f.systemId }

test('placed files do not scan layouts; loose-file queries share one exact root-file index', () => {
  let reads = 0
  const layouts = [
    { nodeId: 'root', nodeType: 'file', containmentKind: 'root' },
    { nodeId: 'nested', nodeType: 'file', containmentKind: 'part_of' },
    { nodeId: 'frame', nodeType: 'system', containmentKind: 'root' },
  ].map(layout => ({ ...layout, get nodeType() { reads++; return layout.nodeType } }))
  const loose = createLooseFileLookup(layouts)
  const hasHome = f => f.systemId === 'shown' || loose.has(f.id)
  const placed = file('placed.ts', { systemId: 'shown' })
  assert.deepEqual(partitionCanvasFiles([placed], { hasHome }).placed, [placed])
  assert.equal(reads, 0)
  const root = file('root.ts', { id: 'root', systemId: 'withheld' })
  const nested = file('nested.ts', { id: 'nested' })
  assert.deepEqual(partitionCanvasFiles([root, nested], { hasHome }).placed, [root])
  assert.equal(loose.has('frame'), false)
  assert.equal(reads, layouts.length)
  // Replacing the layout population invalidates both positive and negative
  // membership; a removed root may not remain on the Floor via an old cache.
  const replacement = createLooseFileLookup([{ nodeId: 'nested', nodeType: 'file', containmentKind: 'root' }])
  assert.equal(replacement.has('root'), false)
  assert.equal(replacement.has('nested'), true)
})

test('partition keeps the complete source order and classifies each filename only once', () => {
  let reads = 0
  const paths = ['loose.ts', 'README.md', 'placed.go', 'asset.png', 'other.py']
  const files = paths.map((path, i) => ({
    ...file(path, { systemId: i === 2 ? 'system' : null }),
    get relPath() { reads++; return path },
  }))
  const result = partitionCanvasFiles(files, liveHome)
  assert.equal(reads, paths.length)
  assert.deepEqual(result.source, [files[0], files[2], files[4]])
  assert.deepEqual(result.placed, [files[2]])
  assert.deepEqual(result.unclassified, [files[0], files[4]])
  assert.deepEqual(result.documents, [files[1]])
  const documentOverride = file('source.ts', { language: 'markdown', systemId: 'system' })
  assert.deepEqual(partitionCanvasFiles([documentOverride], liveHome).source, [])
})

test('a source file with a system is drawn, not binned', () => {
  const { placed, unclassified, documents } = partitionCanvasFiles(
    [file('app/main.py', { systemId: 'sys-1' })], liveHome,
  )
  assert.deepEqual(placed.map(f => f.relPath), ['app/main.py'])
  assert.equal(unclassified.length, 0)
  assert.equal(documents.length, 0)
})

test('a source file with no system goes to the unclassified bin', () => {
  const { placed, unclassified } = partitionCanvasFiles([file('app/loose.py')], liveHome)
  assert.equal(placed.length, 0)
  assert.deepEqual(unclassified.map(f => f.relPath), ['app/loose.py'])
})

test('every documentation extension lands in the documents bin', () => {
  const docs = ['README.md', 'notes.mdx', 'log.txt', 'guide.rst', 'book.adoc']
  const { documents, placed, unclassified } = partitionCanvasFiles(
    docs.map(name => file(name, { language: 'markdown' })), liveHome,
  )
  assert.deepEqual(documents.map(f => f.relPath), docs)
  assert.equal(placed.length, 0)
  assert.equal(unclassified.length, 0)
})

// The bug this whole feature came out of: a doc that a classifier had attached
// to a system used to read as ordinary architecture.
test('documentation is binned as documentation even when it has a system', () => {
  const { documents, placed } = partitionCanvasFiles(
    [file('docs/PLAN.md', { language: 'markdown', systemId: 'sys-1' })], liveHome,
  )
  assert.deepEqual(documents.map(f => f.relPath), ['docs/PLAN.md'])
  assert.equal(placed.length, 0)
})

test('documentation never reaches the unclassified bin', () => {
  const { documents, unclassified } = partitionCanvasFiles(
    [file('README.md', { language: 'markdown' })], liveHome,
  )
  assert.equal(unclassified.length, 0)
  assert.equal(documents.length, 1)
})

test('an unsupported file is dropped rather than binned', () => {
  const { placed, unclassified, documents } = partitionCanvasFiles(
    [file('assets/logo.png', { language: 'unknown' })], liveHome,
  )
  assert.equal(placed.length + unclassified.length + documents.length, 0)
})

// The review surface answers "has a home?" from proposal membership, not
// `system_id`, and must partition identically otherwise.
test('the review surface can define home as proposal membership', () => {
  const assigned = new Set(['app/a.py'])
  const files = [file('app/a.py'), file('app/b.py'), file('docs/x.md', { language: 'markdown' })]
  const { placed, unclassified, documents } = partitionCanvasFiles(files, {
    hasHome: f => assigned.has(f.relPath),
  })
  assert.deepEqual(placed.map(f => f.relPath), ['app/a.py'])
  assert.deepEqual(unclassified.map(f => f.relPath), ['app/b.py'])
  assert.deepEqual(documents.map(f => f.relPath), ['docs/x.md'])
})

test('the three populations always account for every source and document file', () => {
  const files = [
    file('a.py', { systemId: 's' }), file('b.py'), file('c.md', { language: 'markdown' }),
    file('d.go', { systemId: 's' }), file('e.rs'),
  ]
  const { placed, unclassified, documents } = partitionCanvasFiles(files, liveHome)
  assert.equal(placed.length + unclassified.length + documents.length, files.length)
})

test('bin order is stable and path-sorted', () => {
  const sorted = sortForBin([file('z/a.py'), file('a/z.py'), file('a/a.py')])
  assert.deepEqual(sorted.map(f => f.relPath), ['a/a.py', 'a/z.py', 'z/a.py'])
})
