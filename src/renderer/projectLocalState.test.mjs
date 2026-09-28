import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearProjectLocalState,
  migrateLegacyProjectCreationSource,
  migrateLegacyProjectLifecycle,
} from './projectLocalState.ts'

class MemoryStorage {
  #values = new Map()

  get length() { return this.#values.size }
  key(index) { return [...this.#values.keys()][index] ?? null }
  getItem(key) { return this.#values.get(key) ?? null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
}

test('legacy browser hints promote into durable project config and clear on removal', () => {
  const previousStorage = globalThis.localStorage
  const storage = new MemoryStorage()
  globalThis.localStorage = storage

  try {
    storage.setItem('project_created_blank_new-project', 'true')
    assert.equal(
      migrateLegacyProjectCreationSource({ id: 'new-project' }).creationSource,
      'new-project',
    )
    assert.equal(
      migrateLegacyProjectCreationSource({ id: 'existing-project' }).creationSource,
      'open-codebase',
    )
    assert.equal(
      migrateLegacyProjectCreationSource({
        id: 'existing-project',
        creationSource: 'new-project',
      }).creationSource,
      'new-project',
    )
    storage.setItem('agent_setup_completed_new-project', 'true')
    const migratedSetup = migrateLegacyProjectLifecycle({ id: 'new-project', openedAt: 100 })
    assert.equal(migratedSetup.workbenchOpenedAt, 100)
    assert.ok(migratedSetup.agentSetupCompletedAt > 0)

    storage.setItem('review_completed_legacy-project', 'true')
    const migratedReview = migrateLegacyProjectLifecycle({ id: 'legacy-project', openedAt: 200 })
    assert.equal(migratedReview.workbenchOpenedAt, 200)
    assert.ok(migratedReview.reviewCompletedAt > 0)
    assert.ok(migrateLegacyProjectLifecycle({ id: 'legacy-project', workbenchOpenedAt: 150 }).reviewCompletedAt > 0)

    clearProjectLocalState('new-project')
    clearProjectLocalState('legacy-project')
    assert.equal(migrateLegacyProjectLifecycle({ id: 'new-project' }).workbenchOpenedAt, undefined)
    assert.equal(migrateLegacyProjectLifecycle({ id: 'legacy-project' }).reviewCompletedAt, undefined)
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})
