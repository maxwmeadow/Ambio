// Onboarding progress - where this project sits in the reverse-sync →
// forward-sync loop, and whether the guide is currently welcome on screen.
//
// This used to live as loose localStorage reads inside OnboardingGuide, which
// made it unreadable to anything else. It needs a store because dismissal has
// to be recoverable: Help offers the guide back, and it can only do
// that if "I hid it" is reactive state rather than a string in web storage.
import { create } from 'zustand'

export interface GuideProgress {
  startedAt: number
  /** The sheet the guide is following. Adopted, not necessarily created here. */
  sheetId?: string
  plannedId?: string
  dispatched?: boolean
  /** Hidden by the user. Recoverable from Help → Setup Guide. */
  dismissed?: boolean
  /** The loop was closed. The guide does not come back on its own. */
  completed?: boolean
}

const KEY = (projectId: string) => `onboarding_progress_${projectId}`
const LEGACY_COMPLETED_KEY = (projectId: string) => `onboarding_completed_${projectId}`

function read(projectId: string): GuideProgress {
  let progress: GuideProgress = { startedAt: Date.now() }
  try {
    const raw = localStorage.getItem(KEY(projectId))
    if (raw) progress = JSON.parse(raw) as GuideProgress
    // Completion used to be its own key. Fold it in so upgrading users are not
    // walked back through a loop they already closed.
    if (localStorage.getItem(LEGACY_COMPLETED_KEY(projectId)) === 'true') {
      progress.completed = true
    }
  } catch {
    // A damaged local hint must never block the workbench.
  }
  return progress
}

function write(projectId: string, progress: GuideProgress) {
  try {
    localStorage.setItem(KEY(projectId), JSON.stringify(progress))
  } catch {
    // Storage full or blocked: the guide degrades to session-scoped memory.
  }
}

interface OnboardingState {
  visible: boolean
  projectId: string | null
  progress: GuideProgress
  /** Point the store at a project, loading its stored progress. */
  enterProject: (projectId: string) => void
  patch: (patch: Partial<GuideProgress>) => void
  dismiss: () => void
  reveal: () => void
  complete: () => void
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  visible: false,
  projectId: null,
  progress: { startedAt: Date.now() },

  enterProject: (projectId) => {
    if (get().projectId === projectId) return
    set({ projectId, progress: read(projectId), visible: false })
  },

  patch: (patch) => set(state => {
    if (!state.projectId) return state
    const progress = { ...state.progress, ...patch }
    write(state.projectId, progress)
    return { progress }
  }),

  dismiss: () => { set({ visible: false }); get().patch({ dismissed: true }) },
  reveal: () => { set({ visible: true }); get().patch({ dismissed: false }) },
  complete: () => { set({ visible: false }); get().patch({ completed: true, dismissed: true }) },
}))
