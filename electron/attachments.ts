import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { attachmentOf, fileName, isImagePath, pastedTextLabel, type Attachment } from '../src/shared/attachments.ts'

/**
 * Where Ambio keeps what a message brings that has no file of its own: pasted
 * text and pasted images. Kept apart from ~/.ambio on purpose: agents are told
 * never to read Ambio's data there, and they must read these.
 */
export function attachmentsDirectory(userData: string, workspaceId: string): string {
  return path.join(userData, 'attachments', workspaceId.replace(/[^\w.-]/g, '_'))
}

/** Largest pasted text or image Ambio keeps for a message. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
}

/** Saves pasted text or a pasted image and says what to attach. */
export function saveAttachment(directory: string, input: { kind: 'text'; text: string } | { kind: 'image'; bytes: Uint8Array; type: string; name?: string }): Attachment {
  fs.mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const id = randomUUID().slice(0, 8)
  if (input.kind === 'text') {
    if (Buffer.byteLength(input.text) > ATTACHMENT_MAX_BYTES) throw new Error('That text is too large to attach.')
    const file = path.join(directory, `pasted-${stamp}-${id}.txt`)
    fs.writeFileSync(file, input.text, 'utf8')
    return { path: file, kind: 'text', label: pastedTextLabel(input.text) }
  }
  const extension = IMAGE_TYPES[input.type.toLowerCase()]
  if (!extension) throw new Error('Only PNG, JPEG, GIF, WebP and BMP images can be attached.')
  if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new Error('That image is too large to attach.')
  const base = input.name ? input.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 60) : 'image'
  const file = path.join(directory, `${base}-${stamp}-${id}.${extension}`)
  fs.writeFileSync(file, input.bytes)
  // Named by when it was pasted, in the person's own time.
  const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return { path: file, kind: 'image', label: input.name || `Pasted image ${at}` }
}

const PREVIEW_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
}

/**
 * An attached image as a data URL, to show it in the message box: the page
 * cannot load files from disk itself. Only images, and only up to the size
 * Ambio would keep.
 */
export function imagePreview(target: string): string {
  const type = PREVIEW_TYPES[fileName(target).split('.').pop()?.toLowerCase() ?? '']
  if (!type) throw new Error('Only images have a preview.')
  const stat = fs.statSync(target)
  if (!stat.isFile()) throw new Error('Only images have a preview.')
  if (stat.size > ATTACHMENT_MAX_BYTES) throw new Error('That image is too large to preview.')
  return `data:${type};base64,${fs.readFileSync(target).toString('base64')}`
}

/** What paths on this computer are, to attach them: folders, images or files. Missing paths are left out. */
export function describePaths(paths: readonly string[]): Attachment[] {
  return paths.flatMap(item => {
    if (typeof item !== 'string' || !item) return []
    try {
      const stat = fs.statSync(item)
      const kind = stat.isDirectory() ? 'folder' : isImagePath(item) ? 'image' : 'file'
      return [{ path: item, kind, label: fileName(item) } satisfies Attachment]
    } catch { return [] }
  })
}

/** What a message brings from outside the map, from its stored selection; ones no longer on disk are left out. */
export function messageAttachments(selection: unknown): Attachment[] {
  let references: unknown = selection
  if (typeof selection === 'string') { try { references = JSON.parse(selection) } catch { return [] } }
  if (!Array.isArray(references)) return []
  return references.flatMap(reference => {
    const attachment = typeof reference === 'string' ? attachmentOf(reference) : null
    return attachment && fs.existsSync(attachment.path) ? [attachment] : []
  })
}

/** Largest image sent to an agent inline; a larger one stays a path to read. */
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** An attached image as base64 for an agent that takes images inline, or null when it cannot be. */
export function inlineImage(target: string): { mimeType: string; data: string } | null {
  const mimeType = PREVIEW_TYPES[fileName(target).split('.').pop()?.toLowerCase() ?? '']
  if (!mimeType || mimeType === 'image/svg+xml') return null
  try {
    const stat = fs.statSync(target)
    if (!stat.isFile() || stat.size > INLINE_IMAGE_MAX_BYTES) return null
    return { mimeType, data: fs.readFileSync(target).toString('base64') }
  } catch { return null }
}

/** The line added to an agent's turn when its attached images come with it. */
export function attachedImagesNote(count: number): string {
  return `\n\nThe ${count === 1 ? 'image' : `${count} images`} the person attached to this request ${count === 1 ? 'is' : 'are'} included with this message; get_inbox also lists ${count === 1 ? 'it' : 'them'} by path.`
}

/** A file URI for a path on this computer, as agent protocols name files. */
export const fileUri = (target: string) => pathToFileURL(target).href
