import { create } from 'zustand'

/** Presentation only; never changes a sheet's architectural intent. */
export const useSheetView = create<{
  allRelationships: boolean
  relationship: string | null
  toggleRelationships: () => void
  focusRelationship: (id: string | null) => void
}>(set => ({
  allRelationships: false, relationship: null,
  toggleRelationships: () => set(state => ({ allRelationships: !state.allRelationships })),
  focusRelationship: relationship => set({ relationship }),
}))

export function relationshipVerb(kind: string): string {
  return ({ DEPENDS_ON: 'uses', CALLS: 'calls', CONTAINS: 'contains', IMPORTS: 'imports from', READS: 'reads from', WRITES: 'writes to', PUBLISHES: 'publishes to', SUBSCRIBES: 'subscribes to' } as Record<string, string>)[kind] ?? 'connects to'
}
