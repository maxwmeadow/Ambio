import type { PlannedNode } from '../store/sheetStore'

export interface SheetReviewDetail {
  key: string
  kind: string
  name: string
  focus: string
  source?: string
  target?: string
}

/** A nested addition and its internal/read-to-live connections form one change.
 * Connections between independent planned changes remain separate decisions. */
export function sheetReviewGroups<T extends SheetReviewDetail>(items: T[], planned: PlannedNode[]) {
  const nodes = new Map(planned.map(node => [`planned:${node.id}`, node]))
  const rootOf = (id: string) => {
    const seen = new Set<string>()
    let root = id
    while (nodes.has(root) && !seen.has(root)) {
      seen.add(root)
      const parent = nodes.get(root)!.parentSystemId
      if (!parent || !nodes.has(parent)) break
      root = parent
    }
    return root
  }
  const groups = new Map<string, { key: string; name: string; focus: string; items: T[]; connections: number; external: number }>()
  for (const item of items.filter(item => item.kind !== 'relationship')) {
    const key = item.kind === 'addition' ? rootOf(item.focus) : item.key
    const root = nodes.get(key)
    const group = groups.get(key) ?? { key, name: root ? `Add ${root.name}` : item.name, focus: root ? key : item.focus, items: [], connections: 0, external: 0 }
    group.items.push(item)
    groups.set(key, group)
  }
  for (const item of items.filter(item => item.kind === 'relationship')) {
    const source = item.source && nodes.has(item.source) ? rootOf(item.source) : null
    const target = item.target && nodes.has(item.target) ? rootOf(item.target) : null
    const key = source && (!target || source === target) ? source : !source && target ? target : item.key
    const group = groups.get(key)
    if (group) {
      group.items.push(item)
      group.connections++
      if (!source || !target) group.external++
    } else groups.set(item.key, { key: item.key, name: item.name, focus: item.focus, items: [item], connections: 1, external: 1 })
  }
  return [...groups.values()]
}
