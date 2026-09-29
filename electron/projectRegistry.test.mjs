import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createProjectId,
  exportManifest,
  importedProjectConfig,
  findProjectByRoot,
  migrateIndexedProjectLifecycle,
  rebasePath,
  refreshProjectDiskState,
  relocateProjectConfig,
  readResumeProjectId,
  listTrash,
  purgeExpiredTrash,
  removeProjectData,
  restoreTrash,
  writeResumeProjectId,
  writeTrashMeta,
} from './projectRegistry.ts'

test('resume pointer persists and clears independently from browser storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-resume-'))
  const settings = path.join(dir, 'settings.json')
  try {
    assert.equal(readResumeProjectId(settings), null)
    writeResumeProjectId(settings, 'workspace-1')
    assert.equal(readResumeProjectId(settings), 'workspace-1')
    fs.writeFileSync(settings, JSON.stringify({ resumeProjectId: 'workspace-1', theme: 'dark' }))
    writeResumeProjectId(settings, null)
    assert.equal(readResumeProjectId(settings), null)
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).theme, 'dark')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an older indexed project gains a durable workbench marker without daemon access', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-legacy-index-'))
  const project = { id: 'legacy', rootPath: '/repo', openedAt: 123 }
  try {
    assert.equal(migrateIndexedProjectLifecycle(project, dataDir), project)
    fs.mkdirSync(path.join(dataDir, project.id))
    fs.writeFileSync(path.join(dataDir, project.id, 'axiom.db'), '')
    assert.equal(migrateIndexedProjectLifecycle(project, dataDir).workbenchOpenedAt, 123)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('an existing recent path keeps its project lifetime but a removed path gets a new id', () => {
  const rootPath = path.join(os.tmpdir(), 'axiom-project-lifetime')
  const existing = { id: 'old-id', rootPath }
  assert.equal(findProjectByRoot([existing], rootPath)?.id, 'old-id')
  assert.notEqual(createProjectId(), createProjectId())
  assert.notEqual(createProjectId(), existing.id)
})

test('project disk state follows the current folder contents without losing its launcher origin', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-project-state-'))
  const project = {
    id: 'workspace-1',
    name: 'Blank project',
    rootPath,
    creationSource: 'new-project',
  }
  try {
    assert.deepEqual(refreshProjectDiskState(project), { ...project, rootIsEmpty: true, rootMissing: false })
    fs.writeFileSync(path.join(rootPath, 'main.ts'), 'export {}')
    assert.deepEqual(refreshProjectDiskState(project), { ...project, rootIsEmpty: false, rootMissing: false })
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('project removal verifies data deletion and clears the active MCP pointer', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-project-delete-'))
  const projectId = 'workspace-1'
  const projectDir = path.join(dataDir, projectId)
  fs.mkdirSync(projectDir)
  fs.writeFileSync(path.join(projectDir, 'axiom.db'), 'stale proposal')
  fs.writeFileSync(
    path.join(dataDir, 'active_project.json'),
    JSON.stringify({ workspaceId: projectId, rootPath: 'C:/repo' }),
  )
  try {
    await removeProjectData({
      projectId,
      dataDir,
      apiPort: 7743,
      request: async () => new Response('{}', { status: 200 }),
    })
    assert.equal(fs.existsSync(projectDir), false)
    assert.equal(fs.existsSync(path.join(dataDir, 'active_project.json')), false)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a daemon refusal is surfaced and never pretends the project was removed', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-project-refusal-'))
  const projectDir = path.join(dataDir, 'workspace-1')
  fs.mkdirSync(projectDir)
  try {
    await assert.rejects(
      removeProjectData({
        projectId: 'workspace-1',
        dataDir,
        apiPort: 7743,
        request: async () => new Response('locked', { status: 500 }),
      }),
      /could not delete the project data/,
    )
    assert.equal(fs.existsSync(projectDir), true)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a moved folder is reported missing, an existing one is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-missing-'))
  try {
    assert.equal(refreshProjectDiskState({ rootPath: dir }).rootMissing, false)
    assert.equal(refreshProjectDiskState({ rootPath: path.join(dir, 'gone') }).rootMissing, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('relocating a project rebases its exclusions and keeps its identity', () => {
  const moved = relocateProjectConfig({
    id: 'p1', name: 'app', rootPath: '/old/app', rootMissing: true,
    ignoredPaths: ['/old/app/vendor/**', '/old/application/x', '/elsewhere/**'],
    workbenchOpenedAt: 5,
  }, '/new/app')
  assert.equal(moved.id, 'p1')
  assert.equal(moved.rootPath, '/new/app')
  assert.equal(moved.rootMissing, false)
  assert.equal(moved.workbenchOpenedAt, 5)
  assert.deepEqual(moved.ignoredPaths, ['/new/app/vendor/**', '/old/application/x', '/elsewhere/**'])
  assert.equal(rebasePath('C:\\old\\app\\vendor/**', 'C:\\old\\app', 'D:\\app'), 'D:\\app\\vendor/**')
})

test('a trashed map is listed, restored once, and purged after 30 days', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-trash-'))
  const config = { id: 'p1', name: 'app', rootPath: '/repo' }
  try {
    fs.mkdirSync(path.join(dataDir, 'p1'))
    fs.writeFileSync(path.join(dataDir, 'p1', 'axiom.db'), 'map')
    const unreachable = async () => { throw new TypeError('fetch failed') }
    const trashPath = await removeProjectData({ projectId: 'p1', dataDir, apiPort: 1, request: unreachable, trash: true })
    assert.ok(trashPath && fs.existsSync(path.join(trashPath, 'axiom.db')))
    assert.equal(fs.existsSync(path.join(dataDir, 'p1')), false)
    writeTrashMeta(trashPath, config, 1000)
    const [entry] = listTrash(dataDir)
    assert.equal(entry.config.name, 'app')
    assert.equal(entry.expiresAt, 1000 + 30 * 86_400_000)
    assert.throws(() => restoreTrash(dataDir, '../p1'), /Invalid/)

    fs.mkdirSync(path.join(dataDir, 'p1'))
    assert.throws(() => restoreTrash(dataDir, entry.trashId), /already has a map/)
    fs.rmSync(path.join(dataDir, 'p1'), { recursive: true })
    assert.equal(restoreTrash(dataDir, entry.trashId).id, 'p1')
    assert.equal(fs.readFileSync(path.join(dataDir, 'p1', 'axiom.db'), 'utf8'), 'map')
    assert.equal(fs.existsSync(path.join(dataDir, 'p1', 'trash.json')), false)
    assert.deepEqual(listTrash(dataDir), [])

    const old = path.join(dataDir, '.trash', 'p2-1')
    fs.mkdirSync(old)
    writeTrashMeta(old, { ...config, id: 'p2' }, 0)
    // Unlabelled entries age by the time in their name, never by folder time.
    fs.mkdirSync(path.join(dataDir, '.trash', `p3-${Date.now() - 31 * 86_400_000}`))
    fs.mkdirSync(path.join(dataDir, '.trash', `p5-${Date.now() - 86_400_000}`))
    fs.mkdirSync(path.join(dataDir, '.trash', 'unknown'))
    const fresh = path.join(dataDir, '.trash', 'p4-1')
    fs.mkdirSync(fresh)
    writeTrashMeta(fresh, { ...config, id: 'p4' }, Date.now())
    assert.equal(purgeExpiredTrash(dataDir), 2)
    assert.deepEqual(fs.readdirSync(path.join(dataDir, '.trash')).sort().map(name => name.replace(/-\d{13}$/, '-t')), ['p4-1', 'p5-t', 'unknown'])
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('archd reports where it put a trashed map', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-trash-api-'))
  try {
    const request = async (url) => {
      assert.match(url, /\/api\/workspace\/p1\?trash=1$/)
      return new Response(JSON.stringify({ trashed: true, trashPath: '/data/.trash/p1-9' }))
    }
    assert.equal(await removeProjectData({ projectId: 'p1', dataDir, apiPort: 1, request, trash: true }), '/data/.trash/p1-9')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('an exported map imports with its settings, pointed at the code on this computer', () => {
  const project = {
    id: 'p1', name: 'app', rootPath: '/old/app', ignoredPaths: ['/old/app/vendor/**'],
    languageOverrides: { '.x': 'go' }, layoutPreferences: { zoom: 2, panX: 1, panY: 1 },
    openedAt: 1, workbenchOpenedAt: 1, hiddenFromRecents: true, rootMissing: true,
  }
  const manifest = { ...exportManifest(project, '1.2.3'), workspaceId: 'p1' }
  assert.equal(manifest.appVersion, '1.2.3')
  assert.ok(!JSON.parse(manifest.config).hiddenFromRecents)

  const same = importedProjectConfig(manifest, '/old/app', 50)
  assert.equal(same.id, 'p1')
  assert.equal(same.rootPath, '/old/app')
  assert.deepEqual(same.ignoredPaths, ['/old/app/vendor/**'])
  assert.deepEqual(same.languageOverrides, { '.x': 'go' })
  assert.equal(same.openedAt, 50)
  assert.equal(same.hiddenFromRecents, false)

  const moved = importedProjectConfig(manifest, '/new/app', 50)
  assert.equal(moved.rootPath, '/new/app')
  assert.deepEqual(moved.ignoredPaths, ['/new/app/vendor/**'])

  const bare = importedProjectConfig({ workspaceId: 'p9', name: 'x', config: 'not json' }, '/code/x', 7)
  assert.equal(bare.id, 'p9')
  assert.equal(bare.rootPath, '/code/x')
  assert.equal(bare.workbenchOpenedAt, 7)
  assert.deepEqual(bare.ignoredPaths, [])
})
