import { create } from 'zustand'

interface Preference { title?: string; readAt?: number }
const storageKey = 'ambio:conversation-presentation'
function load(): Record<string, Preference> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item && typeof item === 'object').map(([key, item]) => {
      const saved = item as Preference
      return [key, { title: typeof saved.title === 'string' ? saved.title.slice(0, 120) : undefined, readAt: typeof saved.readAt === 'number' && Number.isFinite(saved.readAt) ? Math.max(0, saved.readAt) : 0 }]
    }))
  } catch { return {} }
}
export const conversationKey = (workspace: string, id: string) => JSON.stringify([workspace, id])
export const useConversationPreferences = create<{ requested: { workspaceId: string; threadId: string } | null; items: Record<string, Preference>; attention: Record<string, number>; forget: (workspace: string, id: string) => void; update: (workspace: string, id: string, patch: Preference) => void; setAttention: (workspace: string, count: number) => void }>((set, get) => ({
  requested: null, items: load(), attention: {},
  update: (workspace, id, patch) => {
    const key = conversationKey(workspace, id)
    const previous = get().items[key] ?? {}
    const next = { ...previous, ...patch, readAt: Math.max(previous.readAt ?? 0, patch.readAt ?? 0) }
    if (next.title === previous.title && next.readAt === previous.readAt) return
    const items = { ...get().items, [key]: next }
    try { localStorage.setItem(storageKey, JSON.stringify(items)) } catch { /* retained in this session */ }
    set({ items })
  },
  forget: (workspace, id) => {
    const items = { ...get().items }
    delete items[conversationKey(workspace, id)]
    try { localStorage.setItem(storageKey, JSON.stringify(items)) } catch { /* retained in this session */ }
    set({ items })
  },
  setAttention: (workspace, count) => { if (get().attention[workspace] !== count) set({ attention: { ...get().attention, [workspace]: count } }) },
}))
