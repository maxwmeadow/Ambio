import type { BranchCollision, CheckoutStatus, CheckoutsSnapshot } from '../../shared/types'

/**
 * The branch chip, the Checkouts popover and the collision marks on systems
 * are all projections of one GET /api/checkouts snapshot. Keeping them pure
 * makes the wording - the part users read - testable
 * (docs/GIT_AND_PROJECT_SHAPES.md "The experience").
 */

/** The snapshot arrives over HTTP; a list is absent until proven otherwise. */
function list<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : []
}

function text(value: string | undefined | null): string {
  return typeof value === 'string' ? value : ''
}

export function shortCommit(commit: string | undefined): string {
  return text(commit).slice(0, 7)
}

/** What a checkout has checked out, in words. */
export function checkoutName(checkout: Pick<CheckoutStatus, 'branch' | 'headCommit' | 'headState'>): string {
  switch (checkout.headState) {
    case 'none': return 'No Git'
    case 'detached': return `${shortCommit(checkout.headCommit) || 'unknown'} (detached)`
    default: return text(checkout.branch) || shortCommit(checkout.headCommit) || 'unknown'
  }
}

/** The one-line state under a checkout's name, or '' when there is nothing to say. */
export function checkoutState(checkout: CheckoutStatus): string {
  if (checkout.headState === 'none') return 'History still works from Ambio’s own record.'
  if (checkout.headState === 'unborn') return 'No commits yet: branch comparisons start after your first commit.'
  if (checkout.headState === 'detached') return `Detached at ${shortCommit(checkout.headCommit)}.`
  if (checkout.error) return 'Git could not read this checkout.'
  const parts: string[] = []
  if (checkout.changedFiles > 0) parts.push(`${checkout.changedFiles} uncommitted`)
  if (checkout.ahead > 0) parts.push(`${checkout.ahead} ahead`)
  if (checkout.behind > 0) parts.push(`${checkout.behind} behind`)
  if (parts.length > 0 && checkout.upstream) parts.push(`of ${checkout.upstream}`)
  return parts.join(' · ')
}

export interface BranchChipModel {
  visible: boolean
  plain: boolean
  label: string
  dirty: boolean
  ahead: number
  behind: number
  /** Checkouts other than the Floor's: other worktrees of the repository. */
  others: number
  agents: number
  collisions: number
  title: string
}

const HIDDEN: BranchChipModel = {
  visible: false, plain: false, label: '', dirty: false, ahead: 0, behind: 0,
  others: 0, agents: 0, collisions: 0, title: '',
}

export function focusedCheckout(snapshot: CheckoutsSnapshot | null): CheckoutStatus | undefined {
  const checkouts = list(snapshot?.checkouts)
  return checkouts.find(checkout => checkout.isFocused) ?? checkouts[0]
}

export function buildBranchChip(snapshot: CheckoutsSnapshot | null): BranchChipModel {
  const focused = focusedCheckout(snapshot)
  if (!snapshot || !focused) return HIDDEN
  const checkouts = list(snapshot.checkouts)
  const agents = checkouts.reduce((count, checkout) => count + list(checkout.agents).length, 0)
  const collisions = list(snapshot.collisions).length
  const plain = snapshot.vcs === 'none'
  const label = checkoutName(focused)
  const titleParts = [plain ? 'This folder is not a Git repository' : `The Floor shows ${label}`]
  const state = checkoutState(focused)
  if (!plain && state) titleParts.push(state)
  if (checkouts.length > 1) titleParts.push(`${checkouts.length} checkouts`)
  if (collisions > 0) titleParts.push(`${collisions} system${collisions === 1 ? '' : 's'} changing on more than one branch`)
  return {
    visible: true,
    plain,
    label,
    dirty: focused.changedFiles > 0,
    ahead: focused.ahead,
    behind: focused.behind,
    others: Math.max(0, checkouts.length - 1),
    agents,
    collisions,
    title: titleParts.join('. '),
  }
}

export interface CheckoutRow {
  rootId: string
  name: string
  state: string
  path: string
  focused: boolean
  primary: boolean
  agents: Array<{ id: string; name: string; goal: string }>
  touchedSystems: number
  collidingSystems: number
}

export function buildCheckoutRows(snapshot: CheckoutsSnapshot | null): CheckoutRow[] {
  return list(snapshot?.checkouts).map(checkout => ({
    rootId: checkout.rootId,
    name: checkoutName(checkout),
    state: checkoutState(checkout),
    path: checkout.path,
    focused: checkout.isFocused,
    primary: checkout.isPrimary,
    agents: list(checkout.agents).map(agent => ({ id: agent.sessionId, name: agent.agent || 'Agent', goal: agent.goal })),
    touchedSystems: checkout.touchedSystems,
    collidingSystems: checkout.collidingSystems,
  }))
}

export interface SystemCollisionBranch {
  rootId: string
  name: string
  focused: boolean
  files: string[]
  claim: string
}

/**
 * Systems more than one checkout is changing, keyed by system ID: the badge
 * on a system and the "Changing on other branches" section of its Properties.
 */
export function collisionsBySystem(snapshot: CheckoutsSnapshot | null): Map<string, SystemCollisionBranch[]> {
  const byRoot = new Map(list(snapshot?.checkouts).map(checkout => [checkout.rootId, checkout]))
  const result = new Map<string, SystemCollisionBranch[]>()
  for (const collision of list<BranchCollision>(snapshot?.collisions)) {
    result.set(collision.systemId, list(collision.branches).map(branch => {
      const checkout = byRoot.get(branch.rootId)
      const files = [...list(branch.files)]
      return {
        rootId: branch.rootId,
        name: checkout ? checkoutName(checkout) : text(branch.branch) || 'unknown',
        focused: checkout?.isFocused ?? false,
        files,
        claim: list(branch.claims).find(claim => !claim.internal)?.title
          ?? `${files.length} changed file${files.length === 1 ? '' : 's'}`,
      }
    }))
  }
  return result
}
