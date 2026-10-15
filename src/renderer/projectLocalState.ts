/**
 * Everything the renderer remembers about a project, in one place, so that
 * deleting a project deletes it.
 *
 * Removing a project used to drop it from the recent list and delete its
 * database, and leave every local-storage hint keyed to its id behind. Those
 * hints outlive the data they describe. Older releases reused project ids for
 * the same path, so reopening a deleted project could resurrect completed
 * setup. Project ids now name lifetimes, but old browser hints still need
 * removal when a project is deleted.
 *
 * Every project-scoped key belongs in KEYS. A new one added elsewhere and not
 * registered here is a new way for a deleted project to haunt the next one.
 */

import type { ProjectConfig } from '../shared/types'

const AGENT_SETUP_KEY = (id: string) => `agent_setup_completed_${id}`
const LEGACY_REVIEW_KEY = (id: string) => `review_completed_${id}`
const DELIVERY_HOST_KEY = (id: string) => `delivery_host_${id}`
const SETUP_STEP_KEY = (id: string) => `agent_setup_step_${id}`

const KEYS = [
  AGENT_SETUP_KEY,
  LEGACY_REVIEW_KEY,
  DELIVERY_HOST_KEY,
  SETUP_STEP_KEY,
  // Removed in favor of ProjectConfig.creationSource. Keep deleting the old
  // key so projects made by previous builds do not leave stale local state.
  (id: string) => `project_created_blank_${id}`,
  (id: string) => `onboarding_progress_${id}`,
  (id: string) => `onboarding_completed_${id}`,
] as const

/**
 * One release recorded New Project only in local storage. Promote that hint
 * into the persisted project config the next time the project opens. Projects
 * without the old hint safely retain the historical Open Codebase behavior.
 */
export function migrateLegacyProjectCreationSource(config: ProjectConfig): ProjectConfig {
  if (config.creationSource) return config
  let creationSource: ProjectConfig['creationSource'] = 'open-codebase'
  try {
    if (localStorage.getItem(`project_created_blank_${config.id}`) === 'true') {
      creationSource = 'new-project'
    }
  } catch { /* storage may be unavailable */ }
  return { ...config, creationSource }
}

/** One-time promotion of the old browser hints into the durable registry. */
export function migrateLegacyProjectLifecycle(config: ProjectConfig): ProjectConfig {
  const migrated = migrateLegacyProjectCreationSource(config)
  try {
    if (!migrated.reviewCompletedAt && localStorage.getItem(LEGACY_REVIEW_KEY(config.id)) === 'true') {
      return { ...migrated, workbenchOpenedAt: migrated.workbenchOpenedAt || migrated.openedAt || Date.now(), reviewCompletedAt: Date.now() }
    }
    if (!migrated.agentSetupCompletedAt && localStorage.getItem(AGENT_SETUP_KEY(config.id)) === 'true') {
      return { ...migrated, workbenchOpenedAt: migrated.workbenchOpenedAt || migrated.openedAt || Date.now(), agentSetupCompletedAt: Date.now() }
    }
  } catch { /* the backend's indexed status can still recover older projects */ }
  return migrated
}

/** Forget everything this machine remembers about one project. */
export function clearProjectLocalState(projectId: string): void {
  if (!projectId) return
  for (const key of KEYS) {
    try { localStorage.removeItem(key(projectId)) } catch { /* storage may be unavailable */ }
  }
  // Anything else that happens to be namespaced to this project id - including
  // keys written by code that forgot to register above - goes too. Deleting is
  // deleting.
  try {
    const orphans: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && key.includes(projectId)) orphans.push(key)
    }
    for (const key of orphans) localStorage.removeItem(key)
  } catch { /* storage may be unavailable */ }
}

/** Where this project's last request was sent; null when never chosen. */
export function rememberedDeliveryHost(projectId: string): string | null {
  try { return localStorage.getItem(DELIVERY_HOST_KEY(projectId)) } catch { return null }
}

export function rememberDeliveryHost(projectId: string, hostId: string): void {
  try { localStorage.setItem(DELIVERY_HOST_KEY(projectId), hostId) } catch { /* storage may be unavailable */ }
}

/** The agent setup step this project was last on, so reopening returns to it. */
export function rememberedSetupStep(projectId: string): number | null {
  try {
    const step = Number(localStorage.getItem(SETUP_STEP_KEY(projectId)))
    return Number.isInteger(step) && step >= 1 ? step : null
  } catch { return null }
}

export function rememberSetupStep(projectId: string, step: number): void {
  try { localStorage.setItem(SETUP_STEP_KEY(projectId), String(step)) } catch { /* storage may be unavailable */ }
}
