/**
 * "New Sheet from Selection": what is selected on the Floor becomes the new
 * sheet's members - systems, files and infrastructure alike - so a sheet can
 * start from what you are looking at. Agents do the same with
 * `edit_sheet create` and `members`. Planned nodes and anything the map no
 * longer has are left out; a file inside a selected system is kept, since you
 * picked it too.
 */
export type SheetMember = { fileId: string } | { systemId: string } | { infraId: string }

export function sheetMembersFor(
  ids: Iterable<string>,
  map: { systems: Array<{ id: string }>; files: Array<{ id: string }>; infraNodes: Array<{ id: string }> },
): SheetMember[] {
  const systems = new Set(map.systems.map(system => system.id))
  const files = new Set(map.files.map(file => file.id))
  const infra = new Set(map.infraNodes.map(node => node.id))
  const members: SheetMember[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (systems.has(id)) members.push({ systemId: id })
    else if (files.has(id)) members.push({ fileId: id })
    else if (infra.has(id)) members.push({ infraId: id })
  }
  // Systems first, then files, then infrastructure: the order they are laid out.
  const rank = (member: SheetMember) => ('systemId' in member ? 0 : 'fileId' in member ? 1 : 2)
  return members.sort((a, b) => rank(a) - rank(b))
}

/** "3 systems and 2 files" - what the dialog says it will put on the sheet. */
export function describeSheetMembers(members: SheetMember[]): string {
  const count = (kind: 'systemId' | 'fileId' | 'infraId') => members.filter(member => kind in member).length
  const parts = [
    [count('systemId'), 'system', 'systems'],
    [count('fileId'), 'file', 'files'],
    [count('infraId'), 'infrastructure node', 'infrastructure nodes'],
  ] as const
  const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  if (said.length === 0) return 'nothing'
  return said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`
}
