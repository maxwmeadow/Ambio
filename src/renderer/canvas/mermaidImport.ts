/**
 * A pasted Mermaid flowchart (a whiteboard sketch, an agent's diagram, or
 * Copy Map as Mermaid) drafted as a sheet: it becomes the sheet Markdown spec
 * (archd api/sheet_markdown.go) and goes through the same import. Boxes that
 * name a live system or infrastructure node are context; anything else is a
 * planned element - subgraphs and boxes as systems, cylinders as data stores.
 * Edges become connections; a labelled edge to infrastructure keeps its verb.
 */
const INFRA_VERBS: Record<string, string> = {
  reads: 'READS', writes: 'WRITES', publishes: 'PUBLISHES', consumes: 'CONSUMES', subscribes: 'SUBSCRIBES',
  calls: 'CALLS', stores: 'STORES', invalidates: 'INVALIDATES',
}

export function looksLikeMermaid(text: string): boolean {
  return /^\s*(```mermaid\s*\n\s*)?(flowchart|graph)\b/.test(text)
}

interface Box { id: string; label: string; shape: 'box' | 'cylinder' | 'subgraph' }

const NODE_RE = /^([A-Za-z0-9_-]+)\s*(\[\(|\(\(|\[\[|\[|\(|\{)\s*"?([^"\])}]*)"?\s*(\)\]|\)\)|\]\]|\]|\)|\})/

function unescape(text: string): string {
  return text.replace(/#quot;/g, '"').trim()
}

export function mermaidToSheetMarkdown(text: string, live: { systems: string[]; infra: string[] }, name = 'Sketch'): string {
  const boxes = new Map<string, Box>()
  const edges: Array<{ from: string; to: string; label: string }> = []
  const define = (raw: string): string | null => {
    const match = raw.trim().match(NODE_RE)
    if (match) {
      const [, id, open, label] = match
      const shape = open === '[(' ? 'cylinder' : 'box'
      if (!boxes.has(id) || boxes.get(id)!.label === id) boxes.set(id, { id, label: unescape(label) || id, shape })
      return id
    }
    const bare = raw.trim().match(/^([A-Za-z0-9_-]+)$/)
    if (!bare) return null
    if (!boxes.has(bare[1])) boxes.set(bare[1], { id: bare[1], label: bare[1], shape: 'box' })
    return bare[1]
  }
  for (const raw of text.replace(/```(mermaid)?/g, '').split('\n')) {
    const line = raw.trim()
    if (!line || /^(flowchart|graph)\b/.test(line) || line === 'end' || line.startsWith('%%') ||
        /^(classDef|class|style|linkStyle|click|direction)\b/.test(line)) continue
    const subgraph = line.match(/^subgraph\s+([A-Za-z0-9_-]+)\s*(?:\[\s*"?([^"\]]*)"?\s*\])?/)
    if (subgraph) {
      boxes.set(subgraph[1], { id: subgraph[1], label: unescape(subgraph[2] ?? subgraph[1]), shape: 'subgraph' })
      continue
    }
    const edge = line.match(/^(.+?)\s*(-\.->|-->|==>|---|-\.-)\s*(?:\|([^|]*)\|\s*)?(.+)$/)
    if (edge) {
      const from = define(edge[1])
      const to = define(edge[4])
      if (from && to) edges.push({ from, to, label: (edge[3] ?? '').trim().toLowerCase() })
      continue
    }
    define(line)
  }

  const systems = new Set(live.systems)
  const infra = new Set(live.infra)
  const context: string[] = []
  const add: string[] = []
  for (const box of boxes.values()) {
    if (systems.has(box.label)) context.push(`- system \`${box.label}\``)
    else if (infra.has(box.label)) context.push(`- infrastructure \`${box.label}\``)
    else add.push(`- ${box.shape === 'cylinder' ? 'data_store' : 'system'} \`${box.label}\``)
  }
  const connections = edges.map(({ from, to, label }) => {
    const kind = label.split(',').map(part => INFRA_VERBS[part.trim()]).find(Boolean) ?? 'DEPENDS_ON'
    return `- \`${boxes.get(from)!.label}\` ${kind} \`${boxes.get(to)!.label}\``
  })
  const sections = [`# ${name}`, '']
  if (context.length) sections.push('## Context', ...context, '')
  if (add.length) sections.push('## Add', ...add, '')
  if (connections.length) sections.push('## Connections', ...connections, '')
  return sections.join('\n')
}
