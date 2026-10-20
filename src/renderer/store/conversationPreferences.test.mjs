import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationKey, useConversationPreferences } from './conversationPreferences.ts'

test('read watermarks cannot swallow a newer reply, remain project-specific, and deletion forgets presentation', () => {
  const saved = new Map()
  const previous = globalThis.localStorage
  globalThis.localStorage = { setItem: (key, value) => saved.set(key, value) }
  try {
    useConversationPreferences.setState({ items: {} })
    const state = useConversationPreferences.getState()
    state.update('project', 'chat', { title: 'Formula architecture', readAt: 10 })
    state.update('project', 'chat', { readAt: 7 })
    const preference = useConversationPreferences.getState().items[conversationKey('project', 'chat')]
    assert.equal(preference.readAt, 10)
    assert.equal(preference.title, 'Formula architecture')
    assert.ok(11 > preference.readAt, 'a later reply remains unread')
    assert.equal(useConversationPreferences.getState().items[conversationKey('other', 'chat')], undefined)
    assert.equal(JSON.parse(saved.get('ambio:conversation-presentation'))[conversationKey('project', 'chat')].title, 'Formula architecture')
    state.forget('project', 'chat')
    assert.deepEqual(JSON.parse(saved.get('ambio:conversation-presentation')), {})
  } finally { globalThis.localStorage = previous }
})
