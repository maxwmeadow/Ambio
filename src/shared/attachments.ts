/**
 * Things from outside the map attached to a message: files and folders on
 * this computer, images, and long pasted text. Each travels with the message
 * as a reference, like a system or a file on the map, naming a path on disk:
 * files and folders stay where they are; pasted text and images that have no
 * file of their own are saved by Ambio (electron/attachments.ts) first.
 *
 * Agents receive them through get_inbox: a path to read, and pasted text in
 * full. Every agent can read a path, so this works with all of them; sending
 * images natively to agents that take them is a later step.
 */

export type AttachmentKind = 'file' | 'folder' | 'image' | 'text'

export interface Attachment {
  path: string
  kind: AttachmentKind
  /** What the chip says: a file's name, "Pasted text, 240 lines". */
  label: string
}

const KINDS: readonly AttachmentKind[] = ['file', 'folder', 'image', 'text']

/** The message reference for an attachment. */
export function attachmentReference(attachment: Attachment): string {
  return `ambio://path/${encodeURIComponent(attachment.path)}?label=${encodeURIComponent(attachment.label)}&kind=${attachment.kind}`
}

/** The attachment a reference names, or null for any other reference. */
export function attachmentOf(reference: string): Attachment | null {
  const found = /^ambio:\/\/path\/([^?#]*)(?:\?([^#]*))?/i.exec(reference)
  if (!found) return null
  try {
    const params = new URLSearchParams(found[2] ?? '')
    const path = decodeURIComponent(found[1])
    const kind = params.get('kind') as AttachmentKind | null
    if (!path) return null
    return { path, kind: kind && KINDS.includes(kind) ? kind : 'file', label: params.get('label') || fileName(path) }
  } catch { return null }
}

/** The last part of a path, which is how a person names a file. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

/** Whether a path names an image, by its extension. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(fileName(path).split('.').pop()?.toLowerCase() ?? '')
}

/** Pasted text this long goes in as an attachment instead of into the box. */
export const PASTE_ATTACH_CHARS = 1500
export const PASTE_ATTACH_LINES = 20

const lineCount = (text: string) => text.split(/\r\n|\r|\n/).length

/** Whether pasted text is long enough to attach rather than type in. */
export function attachesPaste(text: string): boolean {
  return text.length >= PASTE_ATTACH_CHARS || lineCount(text.trimEnd()) >= PASTE_ATTACH_LINES
}

/** What a pasted-text chip says. */
export function pastedTextLabel(text: string): string {
  const lines = lineCount(text.trimEnd())
  return lines > 1 ? `Pasted text, ${lines} lines` : `Pasted text, ${text.length.toLocaleString('en-US')} characters`
}

/**
 * Whether the agent Ambio starts for a turn sees attached images directly
 * (electron/agentDrivers.ts, codexAppServer.ts, acpClient.ts): Claude Code
 * and Codex always; an ACP agent when it says it takes images; any other
 * agent gets each image as a file to open.
 */
export function imageDelivery(hostId: string): 'direct' | 'if-supported' | 'path' {
  if (hostId === 'claude-code' || hostId === 'codex') return 'direct'
  if (hostId === 'antigravity-cli' || hostId === 'grok' || hostId === 'devin-cli') return 'if-supported'
  return 'path'
}

/** The part of an image chip's tooltip that says how the chosen agent receives it. */
export function imageDeliveryHint(hostId: string, agent: string): string {
  switch (imageDelivery(hostId)) {
    case 'direct': return `${agent} sees this image directly.`
    case 'if-supported': return `${agent} sees this image directly when it takes images; otherwise it opens the file.`
    case 'path': return hostId ? `${agent} opens this image from its file.` : 'The agent opens this image from its file.'
  }
}
