import { archdApi } from '../archdEndpoint.ts'
import { useSheetStore } from '../store/sheetStore.ts'
import { raiseFailure, raiseNotice } from '../store/interruptionStore.ts'

/**
 * Split System… on the Floor (canvas contract: changes that need code start
 * from the right-click menu as a sheet). Splitting moves code, so it is drawn,
 * not done: a "Split <name>" sheet with the system as context and two new
 * systems to name and fill, ready to send to an agent.
 */
export function splitSheetSpec(system: { name: string; path: string }): string {
  return [
    `# Split ${system.name}`,
    '',
    `${system.name} does more than one job. Name the parts, move what belongs to each, then send this sheet to an agent.`,
    '',
    '## Context',
    `- system \`${system.path}\``,
    '',
    '## Add',
    `- system \`${system.name}: first part\` - <what it is responsible for>`,
    `- system \`${system.name}: second part\` - <what it is responsible for>`,
    '',
  ].join('\n')
}

/** "Parent/Child", the way the sheet format names a system unambiguously. */
export function systemPath(systemId: string, systems: Array<{ id: string; name: string; parentId: string | null }>): string {
  const byId = new Map(systems.map(system => [system.id, system]))
  const names: string[] = []
  const seen = new Set<string>()
  for (let id: string | null = systemId; id && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
    seen.add(id)
    const system = byId.get(id)
    if (!system) break
    names.unshift(system.name)
  }
  return names.join('/')
}

export async function startSplitSheet(workspaceId: string, system: { name: string; path: string }): Promise<void> {
  try {
    const response = await fetch(`${archdApi()}/api/sheet-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, markdown: splitSheetSpec(system), createdBy: 'user' }),
    })
    if (!response.ok) throw new Error(await response.text())
    const { sheet } = await response.json() as { sheet: { id: string } }
    const store = useSheetStore.getState()
    await store.fetchSheets(workspaceId)
    await store.openSheet(workspaceId, sheet.id)
    raiseNotice('split-system', `Split ${system.name} drawn on a sheet`,
      'Name the two parts and drag what belongs to each into them, then send the sheet with ↗ in the sheet rail.')
  } catch (error) {
    raiseFailure('split-system', `Could not start splitting ${system.name}`, error instanceof Error ? error.message : String(error))
  }
}
