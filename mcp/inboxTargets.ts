import fs from 'node:fs'

/** Longest pasted text get_inbox gives in full. */
const PASTED_TEXT_LIMIT = 200_000

/**
 * A message's attachment from outside the map (src/shared/attachments.ts):
 * its kind and path, and pasted text read in full so the agent need not.
 */
export function attachmentTarget(reference: string): Record<string, unknown> | null {
  const found = /^ambio:\/\/path\/([^?#]*)(?:\?([^#]*))?/i.exec(reference)
  if (!found) return null
  let path = ''
  try { path = decodeURIComponent(found[1]) } catch { return null }
  const params = new URLSearchParams(found[2] ?? '')
  const kind = params.get('kind') || 'file'
  const target: Record<string, unknown> = { reference, type: 'path', kind, path, label: params.get('label') || path }
  if (kind === 'text') {
    try {
      const text = fs.readFileSync(path, 'utf8')
      target.text = text.length > PASTED_TEXT_LIMIT ? `${text.slice(0, PASTED_TEXT_LIMIT)}\n[truncated; the full text is at path]` : text
    } catch { target.missing = true }
  } else if (!fs.existsSync(path)) target.missing = true
  return target
}
