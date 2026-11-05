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
  /** The project the open tabs belong to. */
  workspaceId: string | null
  tabs: SourceTab[]
  active: string | null
  /**
   * Whether the editor is in front. Closing the editor only hides it: its
   * tabs, and their unsaved edits, stay open for the next file opened.
   */
  visible: boolean
  /** Tab ids, most recently shown last: where focus goes when a tab closes. */
  recent: string[]
  /** Tabs with unsaved changes, as their editors report them. */
  dirty: Record<string, boolean>
  /**
   * A close waiting on the person to decide about unsaved changes in that
   * tab; the rest of the tabs being closed with it ask next.
   */
  closing: { tabId: string; rest: string[] } | null
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
  /** Close these tabs: those without unsaved changes at once, then each of the others asks in turn. */
  requestClose: (tabIds: string[]) => void
  /** The person decided (saved or discarded): close the tab, and ask in the next one being closed. */
  closeTab: (tabId: string) => void
  /** The person chose to keep editing: stop closing. */
  cancelClose: () => void
  /** Put the editor away, keeping every tab open. */
  hide: () => void
  /** Close every tab without asking, and forget them. */
  close: () => void
}

type State = Pick<SourcePreviewStore, 'workspaceId' | 'tabs' | 'active' | 'visible' | 'recent' | 'dirty' | 'closing' | 'history'>

let opened = 0

/** A project's open tabs, kept across restarts. Unsaved edits are kept separately, as drafts. */
interface SavedTabs { tabs: Array<{ request: SourcePreviewRequest; path?: string }>; active: string | null }
const savedKey = (workspaceId: string) => `ambio.sourceTabs.${workspaceId}`
function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}
function readSaved(workspaceId: string): Partial<State> {
  let saved: SavedTabs | null = null
  try { saved = JSON.parse(storage()?.getItem(savedKey(workspaceId)) ?? 'null') as SavedTabs | null } catch { saved = null }
  const tabs = (Array.isArray(saved?.tabs) ? saved.tabs : [])
    .filter(tab => tab?.request?.workspaceId === workspaceId && typeof tab.request.fileId === 'string')
    .slice(0, MAX_SOURCE_TABS)
    .map(tab => ({ id: sourceTabId(tab.request), request: tab.request, path: tab.path, openedAt: ++opened }))
  const active = tabs.some(tab => tab.id === saved?.active) ? saved!.active : tabs[tabs.length - 1]?.id ?? null
  return { workspaceId, tabs, active, recent: tabs.map(tab => tab.id).filter(id => id !== active).concat(active ? [active] : []), dirty: {}, closing: null, history: [] }
}
function writeSaved(state: State) {
  if (!state.workspaceId) return
  try {
    if (!state.tabs.length) storage()?.removeItem(savedKey(state.workspaceId))
    else storage()?.setItem(savedKey(state.workspaceId), JSON.stringify({ tabs: state.tabs.map(tab => ({ request: tab.request, path: tab.path })), active: state.active } satisfies SavedTabs))
  } catch { /* storage full or refused: the tabs last until the app closes */ }
}

function show(current: State, request: SourcePreviewRequest): Partial<State> {
  // Another project's file: that project's tabs come back, and this one's are put away.
  const state = current.workspaceId === request.workspaceId ? current : { ...current, ...readSaved(request.workspaceId) }
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
  return { ...state, tabs, recent, active: id, visible: true }
}

function without(state: State, tabId: string): State {
  const tabs = state.tabs.filter(tab => tab.id !== tabId)
  const recent = state.recent.filter(id => id !== tabId)
  const { [tabId]: _closed, ...dirty } = state.dirty
  if (!tabs.length) return { ...state, tabs, recent, dirty, active: null, visible: false, closing: null, history: [] }
  return { ...state, tabs, recent, dirty, active: state.active === tabId ? recent[recent.length - 1] ?? tabs[0].id : state.active }
}

/** Close the tabs without unsaved changes; the first with them asks, in front. */
function closing(current: State, tabIds: string[]): State {
  let state = current
  const unsaved: string[] = []
  for (const id of tabIds) {
    if (!state.tabs.some(tab => tab.id === id)) continue
    if (state.dirty[id]) unsaved.push(id)
    else state = without(state, id)
  }
  if (!unsaved.length) return { ...state, closing: null }
  const [first, ...rest] = unsaved
  return { ...state, active: first, visible: true, recent: [...state.recent.filter(id => id !== first), first], closing: { tabId: first, rest } }
}

export const useSourcePreviewStore = create<SourcePreviewStore>(set => ({
  workspaceId: null,
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
  setPath: (tabId, path) => set(state => state.tabs.some(tab => tab.id === tabId && tab.path !== path)
    ? { tabs: state.tabs.map(tab => tab.id === tabId ? { ...tab, path } : tab) }
    : state),
  requestClose: tabIds => set(state => closing(state, tabIds)),
  closeTab: tabId => set(state => {
    const rest = state.closing?.tabId === tabId ? state.closing.rest : []
    return closing({ ...without(state, tabId), closing: null }, rest)
  }),
  cancelClose: () => set({ closing: null }),
  hide: () => set({ visible: false, closing: null }),
  close: () => set({ tabs: [], recent: [], dirty: {}, active: null, visible: false, closing: null, history: [] }),
}))

// Which files are open is kept per project, so they are there after a restart.
useSourcePreviewStore.subscribe((state, previous) => {
  if (state.tabs !== previous.tabs || state.active !== previous.active) writeSaved(state)
})
