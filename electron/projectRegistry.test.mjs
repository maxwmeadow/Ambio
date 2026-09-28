import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createProjectId,
  findProjectByRoot,
  migrateIndexedProjectLifecycle,
  refreshProjectDiskState,
  readResumeProjectId,
  removeProjectData,
  writeResumeProjectId,
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
    assert.deepEqual(refreshProjectDiskState(project), { ...project, rootIsEmpty: true })
    fs.writeFileSync(path.join(rootPath, 'main.ts'), 'export {}')
    assert.deepEqual(refreshProjectDiskState(project), { ...project, rootIsEmpty: false })
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
