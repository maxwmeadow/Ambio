import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'

export type AgentHostState = 'missing' | 'available' | 'repair' | 'installed' | 'live'

export interface AgentHostPresentation {
  state: AgentHostState
  detail: string
  action: 'none' | 'install' | 'repair' | 'reinstall'
}

export interface AgentFamilyPresentation {
  familyId: string
  familyLabel: string
  state: AgentHostState
  detail: string
  detectedCount: number
  installedCount: number
  totalCount: number
  canBatchInstall: boolean
  batchAction: 'install' | 'reinstall' | 'none'
}

export function connectionCheckPrompt(project: { id: string; name: string; rootPath: string }): string {
  return `Check Ambio access for project "${project.name}" (${project.rootPath}). Call get_inbox with verifyOnly true and expectedWorkspaceId "${project.id}". Do not claim or work on any request. Tell me whether inboxReady is true and the returned workspace ID matches.`
}

/**
 * Intelligent light signal for an individual modality.
 */
export function presentAgentHost(
  host: AgentHostInfo,
  result: AgentInstallResult | undefined,
  connectedNow: boolean,
): AgentHostPresentation {
  if (connectedNow) {
    return {
      state: 'live',
      detail: `${host.modalityLabel || host.label} has an MCP process online for this project. Tool access is checked separately.`,
      action: 'reinstall',
    }
  }

  if (result?.ok || (host.configured && host.workflowInstalled)) {
    return {
      state: 'installed',
      detail: `Ambio MCP, draw-first guidance, and its canvas inbox${host.command ? ` and ${host.command} mapping` : ''} workflow are installed for ${host.modalityLabel || host.label}.`,
      action: 'reinstall',
    }
  }

  if (host.unreadablePaths.length > 0) {
    return {
      state: 'repair',
      detail: `${host.modalityLabel || host.label}'s configuration could not be read safely. Ambio will not overwrite it.`,
      action: 'repair',
    }
  }

  if (host.configured && !host.workflowInstalled) {
    return {
      state: 'repair',
      detail: `Ambio MCP is configured for ${host.modalityLabel || host.label}, but mapping, inbox, or draw-first instructions need repair.`,
      action: 'repair',
    }
  }

  if (!host.detected) {
    return {
      state: 'missing',
      detail: `${host.modalityLabel || host.label} was not found on this machine. Install it before adding Ambio.`,
      action: 'none',
    }
  }

  return {
    state: 'available',
    detail: `${host.modalityLabel || host.label} is installed on this machine, but Ambio has not been added yet.`,
    action: 'install',
  }
}

/**
 * Intelligent light signal aggregating across an entire agent family.
 *
 * A parent light summarises its children, so it has to surface the worst thing
 * underneath rather than the best. A family whose CLI is connected while its
 * desktop app has unreadable configuration is a family that needs attention -
 * showing green there hides the only state the user could act on.
 *
 * Precedence:
 * 1. repair: any modality has broken config or a missing workflow.
 * 2. live: at least one modality is connected right now.
 * 3. installed: at least one modality is configured and ready.
 * 4. available: a modality is detected on disk, ready to install.
 * 5. missing: nothing detected on this machine.
 */
export function presentAgentFamily(
  familyId: string,
  familyLabel: string,
  modalities: AgentHostInfo[],
  results: Record<string, AgentInstallResult | undefined>,
  liveHostIds: Set<string>,
): AgentFamilyPresentation {
  const presented = modalities.map(m => presentAgentHost(m, results[m.id], liveHostIds.has(m.id)))

  const isLive = presented.some(p => p.state === 'live')
  const isInstalled = presented.some(p => p.state === 'installed')
  const isRepair = presented.some(p => p.state === 'repair')
  const isAvailable = presented.some(p => p.state === 'available')

  const detectedCount = modalities.filter(m => m.detected).length
  const installedCount = presented.filter(p => p.state === 'installed' || p.state === 'live').length
  const totalCount = modalities.length

  let state: AgentHostState = 'missing'
  let detail = `No ${familyLabel} installations were found on this machine.`

  if (isRepair) {
    const broken = modalities.filter((_, index) => presented[index].state === 'repair')
    const brokenLabels = broken.map(m => m.modalityLabel || m.label).join(', ')
    const healthy = presented.filter(p => p.state === 'live' || p.state === 'installed').length
    state = 'repair'
    detail = healthy > 0
      ? `${brokenLabels} needs repair. The other ${healthy === 1 ? 'modality is' : `${healthy} modalities are`} fine.`
      : `${brokenLabels} needs repair.`
  } else if (isLive) {
    state = 'live'
    detail = `${familyLabel} is connected to this Ambio project right now.`
  } else if (isInstalled) {
    state = 'installed'
    detail = `${familyLabel} is installed and ready (${installedCount} of ${detectedCount || totalCount} modalities configured).`
  } else if (isRepair) {
    state = 'repair'
    detail = `${familyLabel} configuration needs repair.`
  } else if (isAvailable) {
    state = 'available'
    detail = `${familyLabel} is available on this machine (${detectedCount} ${detectedCount === 1 ? 'modality' : 'modalities'} detected).`
  }

  // "Install all detected" acts on the detected modalities, or on everything
  // when nothing is detected yet. Offering it for a single target duplicates
  // the per-modality button sitting next to it, so it appears only when it
  // would genuinely do more.
  const batchTargets = detectedCount > 0 ? modalities.filter(m => m.detected) : modalities
  const canBatchInstall = batchTargets.length > 1
  const hasUnconfiguredDetected = modalities.some((m, index) =>
    m.detected && presented[index].state !== 'installed' && presented[index].state !== 'live')
  const batchAction = hasUnconfiguredDetected ? 'install' : isInstalled ? 'reinstall' : 'none'

  return {
    familyId,
    familyLabel,
    state,
    detail,
    detectedCount,
    installedCount,
    totalCount,
    canBatchInstall,
    batchAction,
  }
}

export function commandKind(
  command: string,
  triggerKind?: string,
): 'slash command' | 'skill command' | 'chat prompt' | 'instruction' {
  if (triggerKind === 'chat prompt') return 'chat prompt'
  if (command.startsWith('/')) return 'slash command'
  if (command.startsWith('$')) return 'skill command'
  return 'instruction'
}

/** The same few words for a state everywhere an agent is listed. */
export const AGENT_STATE_LABEL: Record<AgentHostState, string> = {
  live: 'Connected now',
  installed: 'Installed',
  repair: 'Needs repair',
  available: 'Not installed',
  missing: 'Not found',
}

const FAMILY_ORDER: AgentHostState[] = ['live', 'repair', 'installed', 'available', 'missing']

/**
 * Agents in the order someone setting up wants them: the ones Ambio is
 * already in, then the ones found on this computer, then the rest. The given
 * order is kept within each group.
 */
export function orderAgentFamilies<T extends { id: string; label: string; modalities: AgentHostInfo[] }>(
  families: T[],
  results: Record<string, AgentInstallResult | undefined>,
  liveHostIds: Set<string>,
): Array<{ family: T; presentation: AgentFamilyPresentation }> {
  return families
    .map((family, index) => ({
      family, index,
      presentation: presentAgentFamily(family.id, family.label, family.modalities, results, liveHostIds),
    }))
    .sort((a, b) => FAMILY_ORDER.indexOf(a.presentation.state) - FAMILY_ORDER.indexOf(b.presentation.state) || a.index - b.index)
    .map(({ family, presentation }) => ({ family, presentation }))
}

/** A family's row in a few words; `available` is how many more surfaces could be installed. */
export function familySummary(presentation: AgentFamilyPresentation, available: number): string {
  if (presentation.state === 'installed' && available > 0) return `Installed · ${available} more available`
  if (presentation.state === 'live' && available > 0) return `Connected now · ${available} more available`
  return AGENT_STATE_LABEL[presentation.state]
}

/**
 * What to tell the user after an install or a removal: that it worked and the
 * one thing to do next, or the reason it did not. The installer's own wording
 * is kept only for failures, where its file paths matter.
 */
export function installOutcomeNote(
  host: Pick<AgentHostInfo, 'label' | 'modalityLabel' | 'restartDetail'>,
  action: 'install' | 'remove',
  outcome: { ok: boolean; detail: string },
): { ok: boolean; text: string } {
  if (!outcome.ok) return { ok: false, text: outcome.detail }
  if (action === 'remove') return { ok: true, text: `Removed from ${host.modalityLabel || host.label}.` }
  return { ok: true, text: `Installed. Next: ${host.restartDetail.charAt(0).toLowerCase()}${host.restartDetail.slice(1)}` }
}
