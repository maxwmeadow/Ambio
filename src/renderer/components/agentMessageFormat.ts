export type MessageBlock = { kind: 'code' | 'paragraph' | 'heading' | 'list'; text: string; language?: string; ordered?: boolean }

// A small, deliberately non-HTML formatter. Agent output is always React text,
// never executable markup. Keep incomplete fences readable while preserving code.
export function messageBlocks(text: string): MessageBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: MessageBlock[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = line.match(/^\s*```([^`]*)$/)
    if (fence) {
      const code: string[] = []; i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++
      blocks.push({ kind: 'code', text: code.join('\n'), language: fence[1].trim() }); continue
    }
    if (/^#{1,6}\s/.test(line)) { blocks.push({ kind: 'heading', text: line.replace(/^#{1,6}\s+/, '') }); i++; continue }
    const list = line.match(/^\s*(?:([-*])|\d+\.)\s+/)
    if (list) {
      const items: string[] = [], ordered = !list[1]
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/
      while (i < lines.length && pattern.test(lines[i])) items.push(lines[i++].replace(pattern, ''))
      blocks.push({ kind: 'list', text: items.join('\n'), ordered }); continue
    }
    const paragraph = [line]; i++
    while (i < lines.length && lines[i].trim() && !/^\s*(?:```|#{1,6}\s|[-*]\s|\d+\.\s)/.test(lines[i])) paragraph.push(lines[i++])
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}
