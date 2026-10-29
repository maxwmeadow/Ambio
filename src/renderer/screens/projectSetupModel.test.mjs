import assert from 'node:assert/strict'
import test from 'node:test'
import {
  foldersFirst,
  makeTreeNode,
  findNode,
  toggleNode,
  setChildren,
  collectExcluded,
  collectCheckedPaths,
  isNeverRead,
  noiseFolderWarning,
  scopeHeadline,
  splitSetupRows,
  tuckedSummary,
  shouldAutoExclude,
} from './projectSetupModel.ts'

test('collectCheckedPaths lists the folders shown checked, and files checked against a reason', () => {
  const backend = makeTreeNode({ name: 'backend', isDirectory: true, path: '/p/backend' })
  const venv = makeTreeNode({ name: 'venv', isDirectory: true, path: '/p/backend/venv' })
  const env = makeTreeNode({ name: 'env', isDirectory: true, path: '/p/backend/env' }, undefined, 'Python virtualenv')
  const src = makeTreeNode({ name: 'src', isDirectory: true, path: '/p/backend/src' })
  const local = makeTreeNode({ name: 'settings_local.py', isDirectory: false, path: '/p/backend/settings_local.py' }, undefined, 'In .gitignore')
  const app = makeTreeNode({ name: 'app.py', isDirectory: false, path: '/p/backend/app.py' })
  let tree = setChildren([backend], '/p/backend', [venv, env, src, local, app])
  assert.equal(env.reason, 'Python virtualenv')
  assert.deepEqual(collectCheckedPaths(tree), ['/p/backend', '/p/backend/src'], 'venv by name and env for its reason start unchecked')
  tree = toggleNode(tree, '/p/backend/env', 'excluded')
  tree = toggleNode(tree, '/p/backend/settings_local.py', 'excluded')
  assert.deepEqual(collectCheckedPaths(tree), ['/p/backend', '/p/backend/env', '/p/backend/src', '/p/backend/settings_local.py'])
  tree = toggleNode(tree, '/p/backend', 'excluded')
  assert.deepEqual(collectCheckedPaths(tree), [], 'nothing under an unchecked folder is read')
  const saved = makeTreeNode({ name: 'env', isDirectory: true, path: '/p/env' }, new Set(), 'Python virtualenv')
  assert.equal(saved.excluded, false, 'Project Settings shows the saved choice, not a default')
})

test('a reasoned row is tucked while skipped and named in its warning once checked', () => {
  const copy = makeTreeNode({ name: 'api', isDirectory: true, path: '/p/old/api' }, undefined, 'Worktree of api (feature/x)')
  assert.deepEqual(splitSetupRows([copy]).tucked, [copy])
  const checked = { ...copy, excluded: false }
  assert.deepEqual(splitSetupRows([checked]).shown, [checked])
  assert.equal(noiseFolderWarning(checked, 120),
    'Left out by default: Worktree of api (feature/x). It adds 120 source files to the map. Uncheck it unless you want it on the map.')
})

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

test('rows that need no decision are tucked away, and never-read rows are told apart', () => {
  const node = (name, isDirectory, existing) => makeTreeNode({ name, isDirectory, path: `/p/${name}` }, existing)
  const rows = [node('src', true), node('venv', true), node('node_modules', true), node('.git', true), node('package.json', false), node('README.md', false), node('main.py', false)]
  const { shown, tucked } = splitSetupRows(rows)
  assert.deepEqual(shown.map(row => row.name), ['src', 'README.md', 'main.py'])
  assert.deepEqual(tucked.map(row => row.name), ['venv', 'node_modules', '.git', 'package.json'])
  assert.deepEqual(tucked.map(isNeverRead), [false, true, true, true])
  assert.equal(tuckedSummary(tucked), '4 skipped automatically: venv, node_modules, .git and 1 more')
  assert.equal(tuckedSummary(tucked.slice(0, 2)), '2 skipped automatically: venv, node_modules')

  // A noise folder the user chose to include is a choice again; an ordinary
  // folder the user excluded stays among the choices.
  const edited = [node('venv', true, new Set()), node('src', true, new Set(['/p/src/**']))]
  assert.deepEqual(splitSetupRows(edited).shown.map(row => row.name), ['venv', 'src'])
})

test('the footer states what indexing will read', () => {
  assert.equal(scopeHeadline(null), 'Counting source files…')
  assert.equal(scopeHeadline({ sourceFiles: 1, truncated: false }), '1 source file will be read')
  assert.equal(scopeHeadline({ sourceFiles: 13500, truncated: false }), '13,500 source files will be read')
  assert.equal(scopeHeadline({ sourceFiles: 250000, truncated: true }), 'More than 250,000 source files will be read')
  assert.equal(scopeHeadline({ sourceFiles: 0, truncated: false }), 'No source files in what is checked')
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

test('editing seeds rows from saved exclusions instead of first-run defaults', async () => {
  const { makeTreeNode } = await import('./projectSetupModel.ts')
  const saved = new Set(['/repo/src/**'])
  assert.equal(makeTreeNode({ name: 'src', isDirectory: true, path: '/repo/src' }, saved).excluded, true)
  // node_modules is excluded by default on first run, but the user included it.
  assert.equal(makeTreeNode({ name: 'node_modules', isDirectory: true, path: '/repo/node_modules' }, saved).excluded, false)
  assert.equal(makeTreeNode({ name: 'node_modules', isDirectory: true, path: '/repo/node_modules' }).excluded, true)
})

test('exclusions inside folders the user never expanded survive an edit', async () => {
  const { makeTreeNode, mergeExclusions, toggleNode } = await import('./projectSetupModel.ts')
  const previous = ['/repo/src/generated/**', '/repo/docs/**']
  const saved = new Set(previous)
  let tree = [
    makeTreeNode({ name: 'src', isDirectory: true, path: '/repo/src' }, saved),
    makeTreeNode({ name: 'docs', isDirectory: true, path: '/repo/docs' }, saved),
  ]
  tree = toggleNode(tree, '/repo/docs', 'excluded')
  assert.deepEqual(mergeExclusions(tree, previous).sort(), ['/repo/src/generated/**'])
})

test('checking a folder that is skipped by default earns a warning', () => {
  const folder = (name, excluded) => ({ name, path: `/p/${name}`, isDirectory: true, kind: 'folder', excluded, expanded: false })
  assert.equal(noiseFolderWarning(folder('venv', true)), null)
  assert.equal(noiseFolderWarning(folder('src', false)), null)
  // The indexer never enters these, so they cannot be checked at all.
  assert.equal(noiseFolderWarning(folder('node_modules', false)), null)
  assert.equal(noiseFolderWarning(folder('.venv', false)), null)
  assert.equal(noiseFolderWarning(folder('venv', false), 4210),
    'venv is usually a Python virtual environment: installed packages, not your code. It adds 4,210 source files to the map. Uncheck it unless you wrote what is inside.')
  assert.equal(noiseFolderWarning(folder('htmlcov', false), 0),
    'htmlcov is usually test coverage reports. It holds no source files Ambio reads. Uncheck it unless you wrote what is inside.')
  // Sometimes code (src/components/coverage), so judged by what it holds, not its name.
  assert.equal(noiseFolderWarning(folder('coverage', false)), null)
  assert.equal(noiseFolderWarning(folder('bin', false)), null)
})
