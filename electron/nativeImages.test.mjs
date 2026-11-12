import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { attachedImagesNote, inlineImage, INLINE_IMAGE_MAX_BYTES, messageAttachments } from './attachments.ts'
import { acpPrompt } from './acpClient.ts'
import { CodexAppServer } from './codexAppServer.ts'
import { deliveryPlan } from './agentDelivery.ts'
import { attachmentReference, imageDelivery, imageDeliveryHint } from '../src/shared/attachments.ts'

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-native-images-'))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwqZYRwAU7QG/i/m3WkAAAAASUVORK5CYII=', 'base64')

function attached() {
  const directory = scratch()
  const image = path.join(directory, 'shot.png'), notes = path.join(directory, 'notes.md'), folder = path.join(directory, 'docs')
  fs.writeFileSync(image, PNG); fs.writeFileSync(notes, '# notes'); fs.mkdirSync(folder)
  return {
    image: { path: image, kind: 'image', label: 'shot.png' },
    notes: { path: notes, kind: 'file', label: 'notes.md' },
    folder: { path: folder, kind: 'folder', label: 'docs' },
    directory,
  }
}

test("a message's attachments are read back from its selection; map references and missing files are left out", () => {
  const { image, notes, directory } = attached()
  const gone = { path: path.join(directory, 'gone.png'), kind: 'image', label: 'gone.png' }
  const selection = JSON.stringify(['ambio://system/s1?label=Payments', attachmentReference(image), attachmentReference(notes), attachmentReference(gone)])
  assert.deepEqual(messageAttachments(selection), [image, notes])
  assert.deepEqual(messageAttachments('not json'), [])
})

test('an image goes inline as base64; one too large or an SVG stays a path', () => {
  const { image, directory } = attached()
  assert.deepEqual(inlineImage(image.path), { mimeType: 'image/png', data: PNG.toString('base64') })
  const svg = path.join(directory, 'a.svg'); fs.writeFileSync(svg, '<svg/>')
  assert.equal(inlineImage(svg), null)
  const huge = path.join(directory, 'huge.png'); fs.writeFileSync(huge, Buffer.alloc(INLINE_IMAGE_MAX_BYTES + 1))
  assert.equal(inlineImage(huge), null)
  assert.match(attachedImagesNote(2), /2 images .* are included with this message/)
})

test('Claude Code gets attached images as image blocks in its opening message, after the text', () => {
  const { image, notes } = attached()
  const plan = deliveryPlan('claude-code', { command: 'archd', args: [] }, 'ws', 'Check the work order', { attachments: [image, notes] })
  const content = JSON.parse(plan.stdin).message.content
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /^Check the work order\n\nThe image the person attached/)
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } })
  assert.equal(content.length, 2, 'a file is not an image; get_inbox gives it by path')
  // Without images the opening message is the plain prompt, as before.
  assert.equal(JSON.parse(deliveryPlan('claude-code', { command: 'archd', args: [] }, 'ws', 'p', { attachments: [notes] }).stdin).message.content, 'p')
})

test('Codex gets attached images as local image paths in its turn', async t => {
  const { image } = attached()
  const sent = []
  const client = new CodexAppServer({
    cwd: process.cwd(), prompt: 'Claim Ambio request', mode: 'ask', images: [image.path],
    onEvent: () => {}, onSession: () => {},
    send: line => {
      const message = JSON.parse(line); sent.push(message)
      queueMicrotask(() => {
        if (message.method === 'initialize') client.receive(JSON.stringify({ id: message.id, result: { userAgent: 'Codex Desktop/0.162.1 (Windows; ambio)' } }))
        else if (message.method === 'thread/start') client.receive(JSON.stringify({ id: message.id, result: { thread: { id: 'thread' }, approvalPolicy: message.params.approvalPolicy, approvalsReviewer: message.params.approvalsReviewer, sandbox: { type: message.params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly' } } }))
        else if (message.method === 'turn/start') client.receive(JSON.stringify({ id: message.id, result: { turn: { id: 'turn' } } }))
      })
    },
  })
  t.after(() => client.close())
  void client.run().catch(() => {})
  for (let i = 0; i < 20 && !sent.some(message => message.method === 'turn/start'); i++) await new Promise(resolve => setImmediate(resolve))
  const input = sent.find(message => message.method === 'turn/start').params.input
  assert.equal(input[0].type, 'text')
  assert.match(input[0].text, /^Claim Ambio request\n\nThe image the person attached/)
  assert.deepEqual(input[1], { type: 'localImage', path: image.path })
})

test('an ACP agent that takes images gets them inline; files, folders and images it cannot take go as file links', () => {
  const { image, notes, folder } = attached()
  const withImages = acpPrompt('Check the work order', [image, notes, folder], { image: true })
  assert.deepEqual(withImages.map(block => block.type), ['text', 'image', 'resource_link', 'resource_link'])
  assert.deepEqual(withImages[1], { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') })
  assert.deepEqual(withImages[2], { type: 'resource_link', uri: pathToFileURL(notes.path).href, name: 'notes.md' })
  const without = acpPrompt('Check the work order', [image], {})
  assert.deepEqual(without, [{ type: 'text', text: 'Check the work order' }, { type: 'resource_link', uri: pathToFileURL(image.path).href, name: 'shot.png' }])
  assert.deepEqual(acpPrompt('p', [], { image: true }), [{ type: 'text', text: 'p' }])
})

test('the message box says how the chosen agent receives an image', () => {
  assert.equal(imageDelivery('claude-code'), 'direct')
  assert.equal(imageDelivery('codex'), 'direct')
  assert.equal(imageDelivery('antigravity-cli'), 'if-supported')
  assert.equal(imageDelivery('copilot-cli'), 'path')
  assert.equal(imageDeliveryHint('codex', 'Codex CLI'), 'Codex CLI sees this image directly.')
  assert.equal(imageDeliveryHint('', ''), 'The agent opens this image from its file.')
})
