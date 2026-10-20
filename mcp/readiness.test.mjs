import assert from 'node:assert/strict'
import test from 'node:test'
import { readinessLine } from './readiness.ts'

test('one line says where runs show values, where only output, and what is missing', () => {
  const line = readinessLine([
    { language: 'JavaScript/TypeScript', files: 50, level: 'full', tool: 'node', note: '' },
    { language: 'Python', files: 1, level: 'full', tool: 'python3', note: '' },
    { language: 'Go', files: 7, level: 'output', tool: 'go', note: '' },
    { language: 'Ruby', files: 3, level: 'missing', note: 'no ruby on PATH; runs of this code need Ruby (ruby-lang.org)' },
  ])
  assert.equal(line, 'Runs record calls, arguments and returns for JavaScript/TypeScript (50 files), Python (1 file). '
    + 'Go (7 files): exit code and output only. Ruby: no ruby on PATH; runs of this code need Ruby (ruby-lang.org).')
  assert.equal(readinessLine([]), '')
})
