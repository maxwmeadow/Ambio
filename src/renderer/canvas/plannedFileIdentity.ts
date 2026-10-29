interface PlannedFileIdentity { name: string; declaredPath?: string | null }

export function plannedFilename(node: PlannedFileIdentity): string {
  const path = node.declaredPath || node.name
  return path.split(/[\\/]/).pop() || node.name
}

/** A file header edits its filename; the architecture's descriptive name and
 * containing directory survive unless they already represented the filename. */
export function renamePlannedFile(node: PlannedFileIdentity, filename: string) {
  const path = node.declaredPath || node.name
  const directory = path.match(/^.*[\\/]/)?.[0] ?? ''
  const declaredPath = /[\\/]/.test(filename) ? filename : directory + filename
  const name = node.name === path ? declaredPath
    : node.name === plannedFilename(node) ? plannedFilename({ name: declaredPath }) : node.name
  return { name, declaredPath }
}
