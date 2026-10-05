import type { DbDependency, DbFile, DbInfraNode, DbSystem } from '../../shared/types'

/**
 * The map as a Mermaid flowchart (WORK export-diagrams), for READMEs, PRs
 * and issues: systems nest as subgraphs, infrastructure is drawn as
 * cylinders, and file-level dependencies are rolled up to one edge per pair
 * of systems, labelled with how many there are. Files that belong to no
 * system and dismissed infrastructure are left out.
 */
export function mapAsMermaid(input: {
  systems: Array<Pick<DbSystem, 'id' | 'name' | 'parentId'>>
  files: Array<Pick<DbFile, 'id' | 'systemId'>>
  infraNodes: Array<Pick<DbInfraNode, 'id' | 'name' | 'status'>>
  dependencies: Array<Pick<DbDependency, 'src' | 'dst' | 'srcType' | 'dstType' | 'dependencyType'>>
}): string {
  const systems = new Map(input.systems.map(system => [system.id, system]))
  const infra = new Map(input.infraNodes.filter(node => node.status !== 'dismissed').map(node => [node.id, node]))
  const fileSystem = new Map(input.files.map(file => [file.id, file.systemId ?? null]))
  const ids = new Map<string, string>()
  const idFor = (key: string, prefix: string) => {
    if (!ids.has(key)) ids.set(key, `${prefix}${ids.size + 1}`)
    return ids.get(key)!
  }
  const label = (text: string) => `"${text.replace(/"/g, '#quot;')}"`

  const children = new Map<string | null, string[]>()
  for (const system of input.systems) {
    const parent = system.parentId && systems.has(system.parentId) ? system.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), system.id])
  }
  for (const list of children.values()) list.sort((a, b) => systems.get(a)!.name.localeCompare(systems.get(b)!.name))

  const lines = ['flowchart LR']
  const drawSystem = (id: string, depth: number) => {
    const indent = '  '.repeat(depth)
    const system = systems.get(id)!
    const nested = children.get(id) ?? []
    if (nested.length === 0) {
      lines.push(`${indent}${idFor(id, 's')}[${label(system.name)}]`)
      return
    }
    lines.push(`${indent}subgraph ${idFor(id, 's')}[${label(system.name)}]`)
    for (const child of nested) drawSystem(child, depth + 1)
    lines.push(`${indent}end`)
  }
  for (const id of children.get(null) ?? []) drawSystem(id, 1)
  for (const node of [...infra.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  ${idFor(node.id, 'i')}[(${label(node.name)})]`)
  }

  // Who an endpoint belongs to on this diagram: its system, or itself.
  const owner = (id: string, type: string): string | null => {
    if (type === 'file') {
      const system = fileSystem.get(id)
      return system && systems.has(system) ? system : null
    }
    if (type === 'system') return systems.has(id) ? id : null
    return infra.has(id) ? id : null
  }
  const edges = new Map<string, { from: string; to: string; count: number; kinds: Set<string>; toInfra: boolean }>()
  for (const dep of input.dependencies) {
    const from = owner(dep.src, dep.srcType)
    const to = owner(dep.dst, dep.dstType)
    if (!from || !to || from === to) continue
    const key = `${from}\u0000${to}`
    const edge = edges.get(key) ?? { from, to, count: 0, kinds: new Set<string>(), toInfra: dep.dstType === 'infra' }
    edge.count++
    edge.kinds.add(dep.dependencyType.toLowerCase())
    edges.set(key, edge)
  }
  for (const edge of [...edges.values()].sort((a, b) => b.count - a.count)) {
    const from = idFor(edge.from, systems.has(edge.from) ? 's' : 'i')
    const to = idFor(edge.to, systems.has(edge.to) ? 's' : 'i')
    lines.push(edge.toInfra
      ? `  ${from} -.->|${[...edge.kinds].sort().join(', ')}| ${to}`
      : `  ${from} -->|${edge.count}| ${to}`)
  }
  return lines.join('\n') + '\n'
}
