import { languageFromFilename } from './languageDefinitions.ts'
import type { PlannedNodeMetadata } from '../store/sheetStore'

interface PlannedFileIdentity { name: string; declaredPath?: string | null; notes?: string }

export function plannedFilename(node: PlannedFileIdentity): string {
  const path = node.declaredPath || node.name
  return path.split(/[\\/]/).pop() || node.name
}

/** One displayed identity for old agent plans and newly authored files. Legacy
 * descriptive names are not a second filename; responsibility is description. */
export function plannedFileProperties(node: PlannedFileIdentity, metadata: PlannedNodeMetadata) {
  return { filename: plannedFilename(node), language: languageFromFilename(node.declaredPath || node.name)?.id || metadata.language || '',
    description: metadata.description ?? node.notes ?? '' }
}

export function plannedFileSymbols(metadata: PlannedNodeMetadata, members: Array<{ signature: string }> = []) {
  const symbols = metadata.symbols ?? metadata.exports?.map(name => ({ name, kind: 'variable' }))
    ?? members.map(member => ({ name: member.signature, kind: 'function' }))
  return symbols.map(symbol => ({ ...symbol, lineStart: 0, lineEnd: 0 }))
}

export function fileSymbolTab(kind: string): 'functions' | 'variables' | 'classes' {
  const value = (kind || '').toLowerCase()
  return ['function', 'method'].includes(value) ? 'functions'
    : ['class', 'interface', 'type'].includes(value) ? 'classes' : 'variables'
}

/** Preserve location while editing the single real filename. */
export function renamePlannedFile(node: PlannedFileIdentity, filename: string) {
  const path = node.declaredPath || node.name
  const directory = path.match(/^.*[\\/]/)?.[0] ?? ''
  const declaredPath = /[\\/]/.test(filename) ? filename : directory + filename
  return { name: plannedFilename({ name: declaredPath }), declaredPath }
}
