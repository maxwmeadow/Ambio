import assert from 'node:assert/strict'
import test from 'node:test'
import { architectureLinkTarget, fileLinkTarget, normalizeAgentText } from './agentMessageFormat.ts'
import { codeReferenceFromText } from './codeReference.ts'

const inlineFilePath = (text, files) => codeReferenceFromText(text, files)?.relPath ?? null

test('artifact links resolve encoded identifiers without browser-specific custom scheme handling', () => {
  assert.deepEqual(architectureLinkTarget('ambio://sheet/394dba97-cb06-46b3-9e53-c4c8d231bad5'), { type: 'sheet', id: '394dba97-cb06-46b3-9e53-c4c8d231bad5' })
  assert.deepEqual(architectureLinkTarget('AMBIO://SYSTEM/arch%3Aruntime%2Fformula'), { type: 'system', id: 'arch:runtime/formula' })
  for (const href of ['https://system/example', 'ambio://file/foo', 'ambio://system/%invalid', 'ambio://sheet/', 'ambio://sheet/id?other=1']) assert.equal(architectureLinkTarget(href), null)
})

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
  const { remarkCodeReferences } = await import('./agentMessageFormat.ts')
  const files = new Set(['backend/src/database/query_builder.py', 'backend/test_skills.py'])
  const text = (value) => ({ type: 'text', value })
  const chip = (url, label) => ({ type: 'link', url, children: [text(label)] })
  const tree = { type: 'root', children: [
    { type: 'paragraph', children: [text('See backend/src/database/query_builder.py, test_skills.py:12 and notes.py.')] },
    { type: 'paragraph', children: [{ type: 'strong', children: [text('(backend/test_skills.py)')] }] },
    { type: 'link', url: 'https://x.io', children: [text('query_builder.py')] },
    { type: 'paragraph', children: [text('https://x.io/query_builder.py')] },
    { type: 'code', value: 'query_builder.py:3' },
  ] }
  remarkCodeReferences(files)()(tree)
  assert.deepEqual(tree.children[0].children, [
    text('See '), chip('ambio://code/backend%2Fsrc%2Fdatabase%2Fquery_builder.py', 'backend/src/database/query_builder.py'), text(', '),
    chip('ambio://code/backend%2Ftest_skills.py#L12', 'test_skills.py:12'), text(' and notes.py.'),
  ])
  assert.deepEqual(tree.children[1].children[0].children, [text('('), chip('ambio://code/backend%2Ftest_skills.py', 'backend/test_skills.py'), text(')')])
  assert.deepEqual(tree.children[2].children, [text('query_builder.py')])
  assert.deepEqual(tree.children[3].children, [text('https://x.io/query_builder.py')])
  assert.deepEqual(tree.children[4], { type: 'code', value: 'query_builder.py:3' })
})

test('inline code, links and nearby line numbers from different clients all reach the same chip', async () => {
  const { remarkCodeReferences } = await import('./agentMessageFormat.ts')
  const files = new Set(['robot/heuristics.py'])
  const root = 'C:\\Users\\me\\proj'
  const text = (value) => ({ type: 'text', value })
  const paragraph = (...children) => ({ type: 'paragraph', children })
  const tree = { type: 'root', children: [
    paragraph(text('One line in evaluate_scene ('), { type: 'inlineCode', value: 'heuristics.py:114' }, text('):')),
    paragraph({ type: 'link', url: 'file:///C:/Users/me/proj/robot/heuristics.py#L50-L67', children: [text('heuristics.py')] }),
    paragraph({ type: 'link', url: 'robot/heuristics.py:9', children: [text('heuristics.py:9')] }),
    paragraph({ type: 'inlineCode', value: 'heuristics.py' }, text(' line 114 hardcodes it')),
    paragraph(text('see line 7 of '), { type: 'inlineCode', value: 'robot/heuristics.py' }),
    paragraph({ type: 'inlineCode', value: 'evaluate_scene' }),
  ] }
  remarkCodeReferences(files, root)()(tree)
  const [inline, codexLink, claudeLink, after, before, symbol] = tree.children.map(node => node.children)
  assert.deepEqual(inline[1], { type: 'link', url: 'ambio://code/robot%2Fheuristics.py#L114', children: [text('heuristics.py:114')] })
  assert.equal(codexLink[0].url, 'ambio://code/robot%2Fheuristics.py#L50-L67')
  assert.deepEqual(codexLink[0].children, [text('heuristics.py'), text(':50\u201367')])
  assert.equal(claudeLink[0].url, 'ambio://code/robot%2Fheuristics.py#L9')
  assert.deepEqual(claudeLink[0].children, [text('heuristics.py:9')])
  assert.equal(after[0].url, 'ambio://code/robot%2Fheuristics.py#L114')
  assert.deepEqual(after[0].children, [text('heuristics.py')])
  assert.equal(before[1].url, 'ambio://code/robot%2Fheuristics.py#L7')
  assert.deepEqual(symbol, [{ type: 'inlineCode', value: 'evaluate_scene' }])
})

test('architecture references read as names, open the artifact, and preserve code examples', async () => {
  const { remarkArchitectureNames } = await import('./agentMessageFormat.ts')
  const tree = { type: 'root', children: [
    { type: 'paragraph', children: [{ type: 'text', value: 'Review Skill Split (ID 394dba97-cb06-46b3-9e53-c4c8d231bad5). Formula Runtime DEPENDS_ON Dispatch.' }] },
    { type: 'paragraph', children: [{ type: 'inlineCode', value: 'system-secret-hash' }] },
    { type: 'code', value: 'system-secret-hash DEPENDS_ON Dispatch' },
    { type: 'link', url: 'https://example.com/system-secret-hash', children: [{ type: 'text', value: 'Original link' }] },
  ] }
  remarkArchitectureNames([{ id: '394dba97-cb06-46b3-9e53-c4c8d231bad5', name: 'Skill Split', type: 'sheet' }, { id: 'system-secret-hash', name: 'Formula Runtime', type: 'system' }])()(tree)
  assert.equal(tree.children[0].children[1].url, 'ambio://sheet/394dba97-cb06-46b3-9e53-c4c8d231bad5')
  assert.ok(JSON.stringify(tree.children[0]).includes('uses Dispatch'))
  assert.ok(!JSON.stringify(tree.children[0]).includes('(ID'))
  assert.equal(tree.children[1].children[0].children[0].value, 'Formula Runtime')
  assert.equal(tree.children[2].value, 'system-secret-hash DEPENDS_ON Dispatch')
  assert.equal(tree.children[3].url, 'https://example.com/system-secret-hash')
})
