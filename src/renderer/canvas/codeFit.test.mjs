import assert from 'node:assert/strict'
import test from 'node:test'
import { codeFitInstruction, codeFitNoticeBody } from './codeFit.ts'

const folder = {
  kind: 'folder', fileId: 'billing', filePath: 'src/orders/billing.ts', systemId: 'payments', systemName: 'Payments',
  suggestedPath: 'src/payments/billing.ts',
  summary: 'billing.ts belongs to Payments, but the rest of Payments is in src/payments/',
  ask: 'Move src/orders/billing.ts to src/payments/billing.ts and update every import of it. Keep its behavior unchanged.',
}
const coupling = { ...folder, kind: 'coupling', summary: 'billing.ts belongs to Payments, but 3 of its 4 imports connect to Orders', ask: 'Untangle it.' }

test('the notice names the first disagreement and counts the rest', () => {
  assert.equal(codeFitNoticeBody([]), undefined)
  assert.equal(codeFitNoticeBody([folder]), `${folder.summary}.`)
  assert.equal(codeFitNoticeBody([folder, coupling]), `${folder.summary}, and 1 more thing disagrees with the code.`)
  assert.match(codeFitNoticeBody([folder, coupling, coupling]), /2 more things disagree/)
})

test('the work order lists every ask and keeps the map as decided', () => {
  const text = codeFitInstruction([folder, coupling])
  assert.match(text, /^I changed the architecture map; please make the code match it\./)
  assert.ok(text.includes(`- ${folder.ask}`))
  assert.ok(text.includes('- Untangle it.'))
  assert.match(text, /Do not change what the map says/)
})

test('a checked work order says whether the code now matches', async () => {
  const { codeCheckHeadline } = await import('./codeFit.ts')
  const agrees = { sent: folder, state: 'agrees', now: 'ok' }
  const disagrees = { sent: folder, state: 'disagrees', now: 'no' }
  const changed = { sent: folder, state: 'map-changed', now: 'moved' }
  assert.equal(codeCheckHeadline([agrees]), 'Ambio checked the code: it now matches the map.')
  assert.equal(codeCheckHeadline([agrees, disagrees]), 'Ambio checked the code: 1 of 2 still disagrees with the map.')
  assert.match(codeCheckHeadline([agrees, changed]), /map changed since/)
})
