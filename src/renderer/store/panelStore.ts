import { create } from 'zustand'

/**
 * Which panels are shown (View → Panels ▸). Remembered per machine, so a
 * person who hides a panel does not get it back on every launch.
 * Storage can be missing or refuse writes; panels then simply start shown.
 */
export interface PanelVisibility {
  sheetRail: boolean
  detailPanel: boolean
}

const KEY = 'ambio.panels'
const ALL_SHOWN: PanelVisibility = { sheetRail: true, detailPanel: true }

function load(): PanelVisibility {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PanelVisibility>
    return {
      sheetRail: stored.sheetRail !== false,
      detailPanel: stored.detailPanel !== false,
    }
  } catch {
    return ALL_SHOWN
  }
}

interface PanelStore extends PanelVisibility {
  toggle: (panel: keyof PanelVisibility) => void
}

export const usePanelStore = create<PanelStore>((set, get) => ({
  ...(typeof localStorage === 'undefined' ? ALL_SHOWN : load()),
  toggle: panel => {
    set({ [panel]: !get()[panel] } as Partial<PanelVisibility>)
    const { sheetRail, detailPanel } = get()
    try { localStorage.setItem(KEY, JSON.stringify({ sheetRail, detailPanel })) } catch { /* not remembered */ }
  },
}))

/** The panel a View → Panels command shows or hides, for its check mark. */
export const PANEL_COMMANDS = {
  'view.panelSheetRail': 'sheetRail',
  'view.panelDetail': 'detailPanel',
} as const
