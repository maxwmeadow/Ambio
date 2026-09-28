import assert from 'node:assert/strict'
import test from 'node:test'
import {
  foldersFirst,
  makeTreeNode,
  findNode,
  toggleNode,
  setChildren,
  collectExcluded,
  countExploredKinds,
  formatExploredScopeSummary,
  shouldAutoExclude,
} from './projectSetupModel.ts'

test('foldersFirst places folders before files and demotes noise folders', () => {
  const entries = [
    { name: 'README.md', isDirectory: false, path: '/p/README.md' },
    { name: 'src', isDirectory: true, path: '/p/src' },
    { name: 'node_modules', isDirectory: true, path: '/p/node_modules' },
    { name: 'package.json', isDirectory: false, path: '/p/package.json' },
    { name: 'docs', isDirectory: true, path: '/p/docs' },
  ]
  const sorted = foldersFirst(entries).map(e => e.name)
  // Non-noise folders ('docs', 'src') first, then noise folder ('node_modules'), then files ('package.json', 'README.md')
  assert.deepEqual(sorted, ['docs', 'src', 'node_modules', 'package.json', 'README.md'])
})

test('shouldAutoExclude identifies build dirs, dotfiles, and dependency roots', () => {
  assert.equal(shouldAutoExclude('node_modules'), true)
  assert.equal(shouldAutoExclude('.git'), true)
  assert.equal(shouldAutoExclude('dist'), true)
  assert.equal(shouldAutoExclude('.env'), true)
  assert.equal(shouldAutoExclude('src'), false)
  assert.equal(shouldAutoExclude('main.ts'), false)
})

test('makeTreeNode assigns appropriate file kinds and auto-excludes noise', () => {
  const sourceNode = makeTreeNode({ name: 'App.tsx', isDirectory: false, path: '/p/src/App.tsx' })
  assert.equal(sourceNode.kind, 'source')
  assert.equal(sourceNode.excluded, false)

  const docNode = makeTreeNode({ name: 'ARCH.md', isDirectory: false, path: '/p/ARCH.md' })
  assert.equal(docNode.kind, 'document')
  assert.equal(docNode.excluded, false)

  const noiseNode = makeTreeNode({ name: 'node_modules', isDirectory: true, path: '/p/node_modules' })
  assert.equal(noiseNode.kind, 'folder')
  assert.equal(noiseNode.excluded, true)

  const unsupportedNode = makeTreeNode({ name: 'video.mp4', isDirectory: false, path: '/p/video.mp4' })
  assert.equal(unsupportedNode.kind, 'unsupported')
  assert.equal(unsupportedNode.excluded, true)
})

test('tree navigation helpers: findNode, toggleNode, and setChildren', () => {
  const initial = [
    {
      name: 'src',
      path: '/p/src',
      isDirectory: true,
      kind: 'folder',
      excluded: false,
      expanded: false,
    },
  ]
  const found = findNode(initial, '/p/src')
  assert.ok(found)
  assert.equal(found.name, 'src')

  // Toggle expanded
  const expanded = toggleNode(initial, '/p/src', 'expanded')
  assert.equal(expanded[0].expanded, true)

  // Attach children
  const withChildren = setChildren(expanded, '/p/src', [
    {
      name: 'index.ts',
      path: '/p/src/index.ts',
      isDirectory: false,
      kind: 'source',
      excluded: false,
      expanded: false,
    },
  ])
  assert.equal(withChildren[0].children?.length, 1)

  // Toggle child excluded
  const toggledChild = toggleNode(withChildren, '/p/src/index.ts', 'excluded')
  assert.equal(toggledChild[0].children?.[0].excluded, true)
})

test('countExploredKinds honestly counts discovered nodes without claiming whole-repo coverage', () => {
  const tree = [
    {
      name: 'src',
      path: '/p/src',
      isDirectory: true,
      kind: 'folder',
      excluded: false,
      expanded: true,
      children: [
        { name: 'main.ts', path: '/p/src/main.ts', isDirectory: false, kind: 'source', excluded: false, expanded: false },
        { name: 'utils.ts', path: '/p/src/utils.ts', isDirectory: false, kind: 'source', excluded: true, expanded: false },
        { name: 'guide.md', path: '/p/src/guide.md', isDirectory: false, kind: 'document', excluded: false, expanded: false },
        { name: 'banner.png', path: '/p/src/banner.png', isDirectory: false, kind: 'unsupported', excluded: true, expanded: false },
      ],
    },
    {
      name: 'unexpanded_dir',
      path: '/p/unexpanded',
      isDirectory: true,
      kind: 'folder',
      excluded: false,
      expanded: false,
      // children not fetched yet
    },
  ]

  const counts = countExploredKinds(tree)
  assert.equal(counts.folders, 2)
  assert.equal(counts.files, 1) // only main.ts; utils.ts is excluded
  assert.equal(counts.documents, 1) // guide.md
  assert.equal(counts.unsupported, 1) // banner.png
  assert.equal(counts.totalExplored, 6)
  assert.equal(counts.excludedCount, 2) // utils.ts and banner.png

  const summary = formatExploredScopeSummary(counts)
  assert.match(summary.headline, /1 source file and 1 document discovered across 2 folders/)
  assert.match(summary.subtext, /Counts reflect folders explored in this preview, not total files on disk/)
})

test('collectExcluded generates wildcards for folders and omits unsupported files', () => {
  const tree = [
    {
      name: 'dist',
      path: '/p/dist',
      isDirectory: true,
      kind: 'folder',
      excluded: true,
      expanded: false,
    },
    {
      name: 'src',
      path: '/p/src',
      isDirectory: true,
      kind: 'folder',
      excluded: false,
      expanded: true,
      children: [
        { name: 'temp.ts', path: '/p/src/temp.ts', isDirectory: false, kind: 'source', excluded: true, expanded: false },
        { name: 'asset.bin', path: '/p/src/asset.bin', isDirectory: false, kind: 'unsupported', excluded: true, expanded: false },
      ],
    },
  ]

  const excluded = collectExcluded(tree)
  assert.deepEqual(excluded, ['/p/dist/**', '/p/src/temp.ts'])
})
