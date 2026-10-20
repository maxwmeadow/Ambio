import type { Node } from '@xyflow/react'

const emptyMeasurements: ReadonlyMap<string, Node['measured']> = new Map()
interface PresentationEntry {
  base: Node
  floorData: Node['data'] | undefined
  node: Node
}

/** Merge live runtime flags and selection without rebuilding sheet geometry,
 * authoring callbacks, or unaffected React Flow node identities. */
export function createSheetPresentation() {
  let previous: Node[] = []
  let entries = new Map<string, PresentationEntry>()
  return (
    baseNodes: Node[], floorNodes: Node[], selected: ReadonlySet<string>,
    movable: ReadonlySet<string>, measurements = emptyMeasurements,
  ): Node[] => {
    const floorById = new Map(floorNodes.map(node => [node.id, node]))
    const nextEntries = new Map<string, PresentationEntry>()
    const next = baseNodes.map(base => {
      const floorData = floorById.get(base.id)?.data
      const old = entries.get(base.id)
      const isSelected = selected.has(base.id)
      const draggable = !base.hidden && movable.has(base.id)
      const measured = measurements.get(base.id) ?? base.measured
      let node: Node
      if (old?.base === base && old.floorData === floorData && old.node.selected === isSelected && old.node.draggable === draggable && old.node.measured === measured) {
        node = old.node
      } else {
        const merged = { ...floorData, ...base.data }
        const sameData = old?.base === base && Object.keys(merged).length === Object.keys(old.node.data).length &&
          Object.keys(merged).every(key => merged[key] === old.node.data[key])
        const data = sameData ? old!.node.data : merged
        node = old?.base === base && data === old.node.data && old.node.selected === isSelected && old.node.draggable === draggable && old.node.measured === measured
          ? old.node : { ...base, data, selected: isSelected, draggable, measured }
      }
      nextEntries.set(base.id, { base, floorData, node })
      return node
    })
    entries = nextEntries
    if (previous.length === next.length && next.every((node, i) => node === previous[i])) return previous
    previous = next
    return next
  }
}
