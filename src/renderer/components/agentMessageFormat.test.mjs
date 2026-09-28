import assert from 'node:assert/strict'
import test from 'node:test'
import { messageBlocks } from './agentMessageFormat.ts'

test('agent replies distinguish paragraphs, headings, lists, and fenced code', () => {
  const blocks = messageBlocks('## Changes\n\nMoved **Checkout**.\n\n- One\n- Two\n\n1. Test\n2. Verify\n\n```ts\nconst x = "<script>"\n```')
  assert.deepEqual(blocks.map(block => block.kind), ['heading','paragraph','list','list','code'])
  assert.equal(blocks[3].ordered, true)
  assert.equal(blocks[4].text, 'const x = "<script>"')
  assert.equal(blocks[4].language, 'ts')
})
test('unfinished fences and raw HTML are retained as text', () => {
  assert.deepEqual(messageBlocks('<img src=x onerror=alert(1)>'), [{kind:'paragraph',text:'<img src=x onerror=alert(1)>'}])
  assert.equal(messageBlocks('```\nunfinished')[0].text, 'unfinished')
})
