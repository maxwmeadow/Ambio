import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewMarkdown } from './reviewMarkdown.ts'

const claim = (overrides) => ({
  id: 'c', kind: 'coupling.added', title: 'Api now depends on Storage', subtitle: 'by codex', severity: 3, score: 1,
  actor: 'agent', ts: 1, createsCycle: false, internal: false, evidence: [], sessionId: 's1', ...overrides,
})

test('a review reads as a short Markdown summary', () => {
  const text = reviewMarkdown({
    headline: '3 architecture changes', window: 'since yesterday 17:00', projectName: 'shop',
    sessions: [{ id: 's1', agent: 'codex', goal: 'add refunds', summary: 'done', notes: [], focusSystemIds: [], focusFileIds: [], startedAt: 0, endedAt: 1 }],
    claims: [
      claim({ evidence: Array.from({ length: 7 }, (_, i) => ({ kind: 'import', label: `file${i}.ts`, detail: 'imports store.ts' })) }),
      claim({ title: 'billing.ts moved from Orders to Payments', subtitle: 'by you', actor: 'human', sessionId: undefined, codeFit: [{}] }),
      claim({ title: 'Jobs now calls Api', createsCycle: true, sessionId: undefined }),
    ],
  })
  assert.match(text, /^## Architecture changes · shop\n\n3 architecture changes \(since yesterday 17:00\)\n/)
  assert.match(text, /- codex: add refunds - done/)
  assert.match(text, /- Api now depends on Storage _\(by codex\)_\n  - file0\.ts: imports store\.ts/)
  assert.match(text, /  - and 2 more/)
  assert.match(text, /- billing\.ts moved from Orders to Payments _\(by you\)_ - code still disagrees/)
  assert.match(text, /- Jobs now calls Api _\(by codex\)_ - closes a dependency loop, unexplained/)
})
