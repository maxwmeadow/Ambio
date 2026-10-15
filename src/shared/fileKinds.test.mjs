import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyProjectFile, isAlwaysSkippedDir, isCanvasSourceFile, isDocumentationFile } from './fileKinds.ts'

test('classifies code, readable documents, and unsupported assets separately', () => {
  assert.equal(classifyProjectFile('src/app.tsx'), 'source')
  assert.equal(classifyProjectFile('src/app.css'), 'source')
  assert.equal(classifyProjectFile('src/theme.SCSS'), 'source')
  assert.equal(classifyProjectFile('README.md'), 'document')
  assert.equal(classifyProjectFile('notes.TXT'), 'document')
  assert.equal(classifyProjectFile('demo.mp4'), 'unsupported')
  assert.equal(classifyProjectFile('plan.pdf'), 'unsupported')
  assert.equal(classifyProjectFile('src', true), 'folder')
})

test('documents stay searchable but never become canvas source nodes', () => {
  const markdown = { relPath: 'docs/architecture.md', language: 'markdown' }
  const source = { relPath: 'src/main.go', language: 'go' }
  assert.equal(isDocumentationFile(markdown), true)
  assert.equal(isCanvasSourceFile(markdown), false)
  assert.equal(isDocumentationFile(source), false)
  assert.equal(isCanvasSourceFile(source), true)
  assert.equal(isCanvasSourceFile({ relPath: 'web/src/index.css', language: 'css' }), true)
})

test('dependency, build and dot folders are never read', () => {
  for (const name of ['node_modules', 'dist', 'vendor', '.git', '.venv', '.anything']) assert.equal(isAlwaysSkippedDir(name), true, name)
  for (const name of ['src', 'venv', 'coverage', 'bin']) assert.equal(isAlwaysSkippedDir(name), false, name)
})
