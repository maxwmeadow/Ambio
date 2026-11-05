import { useSourcePreviewStore } from '../store/sourcePreviewStore'

/** Open a whole file in Ambio's code editor: from a double-click or the right-click menu. */
export function openFileCode(workspaceId: string, file: { id: string; relPath: string }): void {
  useSourcePreviewStore.getState().open({
    fileId: file.id,
    workspaceId,
    name: file.relPath.replace(/\\/g, '/'),
    lineStart: 1,
    wholeFile: true,
  })
}
