import { create } from 'zustand'

/**
 * The one source viewer anything in the app can open at a line: a chat
 * reply's code reference, a symbol row, a search result. Shown by
 * SourcePreviewHost, one tab per file.
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

/** An open file. Opening it again points the same tab somewhere new, so its edits stay. */
export interface SourceTab {
  id: string
  request: SourcePreviewRequest
  /** Bumped on every open, so pointing at the same lines again still shows them. */
  openedAt: number
  /** The file's path, once loaded: what the tab is labelled. */
  path?: string
}

/** Past this, opening a file closes the least recently used tab without unsaved changes. */
export const MAX_SOURCE_TABS = 12

export const sourceTabId = (request: Pick<SourcePreviewRequest, 'fileId' | 'workspaceId'>) => `${request.workspaceId}:${request.fileId}`

interface SourcePreviewStore {
  tabs: SourceTab[]
  active: string | null
  /**
   * False while the editor has stepped aside (to show the map, or the agent
   * a question): its tabs, and their unsaved edits, wait for the next open.
   */
  visible: boolean
  /** Tab ids, most recently shown last: where focus goes when a tab closes. */
  recent: string[]
  /** Tabs with unsaved changes, as their editors report them. */
  dirty: Record<string, boolean>
  /**
   * A close waiting on the person to decide about unsaved changes in that tab;
   * `all` carries on to the next tab once they have.
   */
  closing: { tabId: string; all: boolean } | null
  /** Where Ctrl+click came from, newest last, for Back. */
  history: SourcePreviewRequest[]
  open: (request: SourcePreviewRequest) => void
  /** Go to a definition, remembering where it was followed from. */
  follow: (request: SourcePreviewRequest, from: SourcePreviewRequest) => void
  back: () => void
  activate: (tabId: string) => void
  /** Show the next (1) or previous (-1) tab, wrapping. */
  cycle: (direction: 1 | -1) => void
  setDirty: (tabId: string, dirty: boolean) => void
  setPath: (tabId: string, path: string) => void
  /** Close a tab, asking first in it when it has unsaved changes. */
  requestCloseTab: (tabId: string) => void
  /** Close the editor: every tab, asking in turn about each with unsaved changes. */
  requestCloseAll: () => void
  /** The person decided (saved or discarded): close the tab, and carry on closing if closing all. */
  closeTab: (tabId: string) => void
  /** The person chose to keep editing: stop closing. */
  cancelClose: () => void
  hide: () => void
  close: () => void
}

type State = Pick<SourcePreviewStore, 'tabs' | 'active' | 'visible' | 'recent' | 'dirty' | 'closing' | 'history'>

let opened = 0

function show(state: State, request: SourcePreviewRequest): Partial<State> {
  const id = sourceTabId(request)
  const tab: SourceTab = { id, request, openedAt: ++opened }
  let tabs = state.tabs.some(existing => existing.id === id)
    ? state.tabs.map(existing => existing.id === id ? { ...tab, path: existing.path } : existing)
    : [...state.tabs, tab]
  let recent = [...state.recent.filter(other => other !== id), id]
  while (tabs.length > MAX_SOURCE_TABS) {
    const spare = recent.find(other => other !== id && !state.dirty[other])
    if (!spare) break
    tabs = tabs.filter(existing => existing.id !== spare)
    recent = recent.filter(other => other !== spare)
  }
  return { tabs, recent, active: id, visible: true }
}

function without(state: State, tabId: string): Partial<State> {
  const tabs = state.tabs.filter(tab => tab.id !== tabId)
  const recent = state.recent.filter(id => id !== tabId)
  const { [tabId]: _closed, ...dirty } = state.dirty
  if (!tabs.length) return { tabs, recent, dirty, active: null, closing: null, history: [] }
  return { tabs, recent, dirty, active: state.active === tabId ? recent[recent.length - 1] ?? tabs[0].id : state.active }
}

/** The next step of closing everything: the next tab with unsaved changes asks, or all close. */
function closeAllFrom(state: State): Partial<State> {
  const unsaved = state.tabs.find(tab => state.dirty[tab.id])
  if (!unsaved) return { tabs: [], recent: [], dirty: {}, active: null, closing: null, history: [] }
  return { active: unsaved.id, recent: [...state.recent.filter(id => id !== unsaved.id), unsaved.id], closing: { tabId: unsaved.id, all: true } }
}

export const useSourcePreviewStore = create<SourcePreviewStore>(set => ({
  tabs: [],
  active: null,
  visible: false,
  recent: [],
  dirty: {},
  closing: null,
  history: [],
  open: request => set(state => ({ ...show(state, request), history: [], closing: null })),
  follow: (request, from) => set(state => ({ ...show(state, request), history: [...state.history.slice(-19), from] })),
  back: () => set(state => state.history.length
    ? { ...show(state, state.history[state.history.length - 1]), history: state.history.slice(0, -1) }
    : state),
  activate: tabId => set(state => state.tabs.some(tab => tab.id === tabId)
    ? { active: tabId, recent: [...state.recent.filter(id => id !== tabId), tabId] }
    : state),
  cycle: direction => set(state => {
    const index = state.tabs.findIndex(tab => tab.id === state.active)
    if (index < 0 || state.tabs.length < 2) return state
    const next = state.tabs[(index + direction + state.tabs.length) % state.tabs.length].id
    return { active: next, recent: [...state.recent.filter(id => id !== next), next] }
  }),
  setDirty: (tabId, dirty) => set(state => !!state.dirty[tabId] === dirty ? state : { dirty: { ...state.dirty, [tabId]: dirty } }),
  setPath: (tabId, path) => set(state => ({ tabs: state.tabs.map(tab => tab.id === tabId && tab.path !== path ? { ...tab, path } : tab) })),
  requestCloseTab: tabId => set(state => state.dirty[tabId]
    ? { active: tabId, recent: [...state.recent.filter(id => id !== tabId), tabId], closing: { tabId, all: false } }
    : without(state, tabId)),
  requestCloseAll: () => set(state => closeAllFrom(state)),
  closeTab: tabId => set(state => {
    const all = state.closing?.tabId === tabId && state.closing.all
    const next = { ...state, ...without(state, tabId), closing: null }
    return all ? { ...next, ...closeAllFrom(next) } : next
  }),
  cancelClose: () => set({ closing: null }),
  hide: () => set({ visible: false, closing: null }),
  close: () => set({ tabs: [], recent: [], dirty: {}, active: null, closing: null, history: [] }),
}))
