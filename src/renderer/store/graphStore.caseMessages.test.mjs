import assert from 'node:assert/strict'
import test from 'node:test'
import { useGraphStore } from './graphStore.ts'
import { emptyCase } from './caseFile.ts'

test('chat replies are bound to a live case and preserve delivery received before the HTTP response', async () => {
  const fetchBefore = globalThis.fetch
  const stateBefore = useGraphStore.getState()
  try {
    const caseFile = emptyCase('first', 'Sensor startup', 'live')
    useGraphStore.setState({ currentProject: { id: 'project' }, caseFile })
    let requests = 0
    globalThis.fetch = async (_url, init) => {
      requests++
      assert.deepEqual(JSON.parse(init.body), { workspaceId: 'project', caseId: 'first', text: 'Check the late callback', fileId: 'sensor' })
      const message = { id: 'm1', text: 'Check the late callback', at: 20 }
      useGraphStore.getState().applyCaseEvent('investigation:message', { message }, 20)
      useGraphStore.getState().applyCaseEvent('investigation:message_delivered', { ids: ['m1'] }, 21)
      return new Response(JSON.stringify({ message }))
    }
    await useGraphStore.getState().sendCaseMessage('Check the late callback', { fileId: 'sensor' }, 'first')
    assert.equal(requests, 1)
    assert.equal(useGraphStore.getState().caseFile.messages.length, 1)
    assert.equal(useGraphStore.getState().caseFile.messages[0].deliveredAt, 21)
    useGraphStore.setState({ caseFile: emptyCase('replacement', 'Other case', 'live') })
    await assert.rejects(useGraphStore.getState().sendCaseMessage('Stale draft', undefined, 'first'), /ended or changed/)
    useGraphStore.setState({ caseFile: { ...caseFile, status: 'closed' } })
    await assert.rejects(useGraphStore.getState().sendCaseMessage('Late draft', undefined, 'first'), /ended or changed/)
    assert.equal(requests, 1)
  } finally {
    globalThis.fetch = fetchBefore
    useGraphStore.setState(stateBefore)
  }
})

test('an HTTP result for an old case cannot append feedback to its replacement', async () => {
  const fetchBefore = globalThis.fetch
  const stateBefore = useGraphStore.getState()
  try {
    useGraphStore.setState({ currentProject: { id: 'project' }, caseFile: emptyCase('first', 'First', 'live') })
    globalThis.fetch = async () => {
      useGraphStore.setState({ caseFile: emptyCase('next', 'Next', 'live') })
      return new Response(JSON.stringify({ message: { id: 'late', text: 'Old reply', at: 1 } }))
    }
    await useGraphStore.getState().sendCaseMessage('Old reply', undefined, 'first')
    assert.deepEqual(useGraphStore.getState().caseFile.messages, [])
  } finally {
    globalThis.fetch = fetchBefore
    useGraphStore.setState(stateBefore)
  }
})
