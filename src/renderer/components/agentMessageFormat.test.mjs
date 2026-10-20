import assert from 'node:assert/strict'
import test from 'node:test'
import { fileLinkTarget, inlineFilePath, normalizeAgentText } from './agentMessageFormat.ts'

test('a "\\b" or "\\f" the agent meant as a letter is put back', () => {
  assert.equal(normalizeAgentText('see \u0008ackend/src and \u0008uild_query, \u000corm'), 'see backend/src and build_query, form')
})

test('a code fence written with one or two backticks becomes a real fence', () => {
  assert.equal(normalizeAgentText('Code:\n`python\nfrom a import b\n`\nAfter'), 'Code:\n```python\nfrom a import b\n```\nAfter')
  // A lone backtick with no closing line is left alone.
  assert.equal(normalizeAgentText('`python\nno close'), '`python\nno close')
  // Real fences are untouched.
  assert.equal(normalizeAgentText('```ts\nconst x = 1\n```'), '```ts\nconst x = 1\n```')
})

test('the project folder is dropped from paths in the text, but not from link targets', () => {
  const root = 'C:\\Users\\me\\shop'
  assert.equal(normalizeAgentText('Edit C:\\Users\\me\\shop\\src\\a.ts and C:/Users/me/shop/src/b.ts', root), 'Edit src\\a.ts and src/b.ts')
  const link = '[a.ts](file:///C:/Users/me/shop/src/a.ts#L5)'
  assert.equal(normalizeAgentText(link, root), link)
})

test('a file link is read as a project path with its line range', () => {
  const root = 'C:\\Users\\me\\shop'
  assert.deepEqual(fileLinkTarget('file:///C:/Users/me/shop/backend/src/skills/executor.py#L50-L67', root),
    { absolute: 'C:/Users/me/shop/backend/src/skills/executor.py', lines: '50-67', relPath: 'backend/src/skills/executor.py' })
  assert.deepEqual(fileLinkTarget('file:///C:/elsewhere/notes%20one.md', root), { absolute: 'C:/elsewhere/notes one.md' })
  assert.equal(fileLinkTarget('file:///home/me/shop/a.ts', '/home/me/shop')?.relPath, 'a.ts')
  assert.equal(fileLinkTarget('https://example.com', root), null)
})

test('inline code naming an indexed file is recognised, in either slash style', () => {
  const files = new Set(['backend/src/database/common_queries.py'])
  assert.equal(inlineFilePath('backend\\src\\database\\common_queries.py', files), 'backend/src/database/common_queries.py')
  assert.equal(inlineFilePath('backend/src/database/common_queries.py:12', files), 'backend/src/database/common_queries.py')
  assert.equal(inlineFilePath('build_query', files), null)
})

test('a bare file name or partial path is recognised when one indexed file ends with it', () => {
  const files = new Set(['web/src/components/Chat.tsx', 'backend/src/agents/judge.py', 'backend/a/utils.py', 'backend/b/utils.py'])
  assert.equal(inlineFilePath('Chat.tsx', files), 'web/src/components/Chat.tsx')
  assert.equal(inlineFilePath('agents/judge.py:4', files), 'backend/src/agents/judge.py')
  // Two files share the name: which one is meant is unknown, so it stays code.
  assert.equal(inlineFilePath('utils.py', files), null)
  // Part of a name, a wildcard or a folder is not a file.
  assert.equal(inlineFilePath('hat.tsx', files), null)
  assert.equal(inlineFilePath('backend/src/agents/*', files), null)
  assert.equal(inlineFilePath('backend/src/agents/', files), null)
  assert.equal(inlineFilePath('orchestrator.process(...)', files), null)
})

test('file names written as plain prose become chips; code, links and unknown names do not', async () => {
  const { remarkFilePaths } = await import('./agentMessageFormat.ts')
  const files = new Set(['backend/src/database/query_builder.py', 'backend/test_skills.py'])
  const text = (value) => ({ type: 'text', value })
  const tree = { type: 'root', children: [
    { type: 'paragraph', children: [text('See backend/src/database/query_builder.py, test_skills.py and notes.py.')] },
    { type: 'paragraph', children: [{ type: 'strong', children: [text('(backend/test_skills.py)')] }] },
    { type: 'link', children: [text('query_builder.py')] },
    { type: 'paragraph', children: [text('https://x.io/query_builder.py')] },
  ] }
  remarkFilePaths(files)()(tree)
  assert.deepEqual(tree.children[0].children, [
    text('See '), { type: 'inlineCode', value: 'backend/src/database/query_builder.py' }, text(', '),
    { type: 'inlineCode', value: 'test_skills.py' }, text(' and notes.py.'),
  ])
  assert.deepEqual(tree.children[1].children[0].children, [text('('), { type: 'inlineCode', value: 'backend/test_skills.py' }, text(')')])
  assert.deepEqual(tree.children[2].children, [text('query_builder.py')])
  assert.deepEqual(tree.children[3].children, [text('https://x.io/query_builder.py')])
})
