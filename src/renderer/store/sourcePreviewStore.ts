import { create } from 'zustand'

/**
 * The one source viewer anything in the app can open at a line: a chat
 * reply's code reference today. Shown by SourcePreviewHost.
 */
export interface SourcePreviewRequest {
  fileId: string
  workspaceId: string
  /** What the viewer is about: the symbol's or reference's name. */
  name: string
  /** The symbol's kind, when it is a symbol. */
  kind?: string
  lineStart: number
  lineEnd?: number
}

interface SourcePreviewStore {
  request: SourcePreviewRequest | null
  open: (request: SourcePreviewRequest) => void
  close: () => void
}

export const useSourcePreviewStore = create<SourcePreviewStore>(set => ({
  request: null,
  open: request => set({ request }),
  close: () => set({ request: null }),
}))
