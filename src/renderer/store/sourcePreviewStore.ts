import { create } from 'zustand'

/**
 * The one source viewer anything in the app can open at a line: a chat
 * reply's code reference, a symbol row, a search result. Shown by
 * SourcePreviewHost.
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
  /** The file itself was opened (double-clicked), not lines in it: nothing is highlighted. */
  wholeFile?: boolean
}

interface SourcePreviewStore {
  request: SourcePreviewRequest | null
  /** Where Ctrl+click came from, newest last, for Back. */
  history: SourcePreviewRequest[]
  open: (request: SourcePreviewRequest) => void
  /** Go to a definition, remembering where it was followed from. */
  follow: (request: SourcePreviewRequest, from: SourcePreviewRequest) => void
  back: () => void
  close: () => void
}

export const useSourcePreviewStore = create<SourcePreviewStore>(set => ({
  request: null,
  history: [],
  open: request => set({ request, history: [] }),
  follow: (request, from) => set(state => ({ request, history: [...state.history.slice(-19), from] })),
  back: () => set(state => state.history.length
    ? { request: state.history[state.history.length - 1], history: state.history.slice(0, -1) }
    : state),
  close: () => set({ request: null, history: [] }),
}))
