import assert from 'node:assert/strict'
import test from 'node:test'
import { useOnboardingStore } from './onboardingStore.ts'

test('the old guide opens only on request and preserves progress across projects', () => {
  const saved = new Map()
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }
  try {
    const store = useOnboardingStore.getState()
    store.enterProject('first')
    assert.equal(useOnboardingStore.getState().visible, false)
    store.reveal()
    assert.equal(useOnboardingStore.getState().visible, true)
    store.patch({ sheetId: 'existing-plan', dispatched: true })
    store.dismiss()
    assert.equal(useOnboardingStore.getState().visible, false)
    assert.equal(useOnboardingStore.getState().progress.completed, undefined)
    store.enterProject('second')
    store.enterProject('first')
    assert.equal(useOnboardingStore.getState().visible, false)
    assert.equal(useOnboardingStore.getState().progress.sheetId, 'existing-plan')
    store.reveal()
    assert.equal(useOnboardingStore.getState().progress.dispatched, true)
    assert.equal(useOnboardingStore.getState().visible, true)
  } finally { delete globalThis.localStorage }
})
