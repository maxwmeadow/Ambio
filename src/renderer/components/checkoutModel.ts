import type { BranchCollision, CheckoutStatus, CheckoutsSnapshot, RepositoryStatus } from '../../shared/types'
import type { BranchListing } from '../canvas/arcdApi'

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
export function checkoutState(checkout: Pick<CheckoutStatus, 'headState' | 'headCommit' | 'error' | 'changedFiles' | 'ahead' | 'behind' | 'upstream'>): string {
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
  /** A folder holding several repositories. */
  repositories: number
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
  visible: false, plain: false, repositories: 0, label: '', dirty: false, ahead: 0, behind: 0,
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
  const repositories = list(snapshot.repositories)
  if (snapshot.vcs === 'repos') {
    const dirty = repositories.filter(repository => repository.changedFiles > 0)
    return {
      ...HIDDEN,
      visible: true,
      repositories: repositories.length,
      label: `${repositories.length} repos`,
      dirty: dirty.length > 0,
      title: repositories.map(repository => `${repository.folder} on ${checkoutName(repository)}${repository.changedFiles ? ` (${repository.changedFiles} uncommitted)` : ''}`).join('. '),
    }
  }
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
    repositories: 0,
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
  /** "+2 ~1 files": what it changes on its branch, drawn on the Floor. */
  overlay: string
  tint: string
  /** Whether "Show on the Floor" applies. */
  canShow: boolean
  /** Whether "Review this branch" applies: a branch with commits. */
  canReview: boolean
  /** A worktree Ambio made for an agent run: Apply or Discard. */
  ambioRun: boolean
  /** Whether "Switch branch…" applies: the Floor's own checkout, in Git. */
  canSwitch: boolean
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
    overlay: checkout.isFocused ? '' : overlaySummary(checkout),
    tint: overlayTint(snapshot, checkout.rootId),
    canShow: !checkout.isFocused && checkout.headState !== 'none',
    canReview: checkout.headState === 'commit' || checkout.headState === 'detached',
    ambioRun: !!checkout.isAmbioRun && !checkout.isFocused,
    canSwitch: checkout.isFocused && checkout.headState !== 'none',
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

/** Which other checkouts the Floor draws (docs/GIT_AND_PROJECT_SHAPES.md Q5). */
export type OverlayLens = 'off' | 'agents' | 'all'
export const DEFAULT_OVERLAY_LENS: OverlayLens = 'agents'

/** One tint per other checkout, in a stable order, none of them the agent teal
 *  or the collision rust. */
const OVERLAY_TINTS = ['#7b5ea7', '#2f7d9a', '#9a3b5c', '#5b7f2a', '#a0632a']

export interface OverlayMark {
  rootId: string
  name: string
  tint: string
  change: 'modified' | 'deleted'
}

export interface OverlayArrival {
  rootId: string
  name: string
  tint: string
  paths: string[]
}

export interface CanvasOverlay {
  /** Floor files another checkout changes or deletes. */
  byFile: Map<string, OverlayMark[]>
  /** New files another checkout adds, by the system that owns their folder. */
  arrivals: Map<string, OverlayArrival[]>
  /** New files no Floor system owns a folder of. */
  unplaced: number
  /** Checkouts drawn, after the lens. */
  shown: CheckoutStatus[]
}

export function overlayTint(snapshot: CheckoutsSnapshot | null, rootId: string): string {
  const others = list(snapshot?.checkouts).filter(checkout => !checkout.isFocused).map(checkout => checkout.rootId).sort()
  const index = others.indexOf(rootId)
  return index < 0 ? OVERLAY_TINTS[0] : OVERLAY_TINTS[index % OVERLAY_TINTS.length]
}

export function buildCanvasOverlay(snapshot: CheckoutsSnapshot | null, lens: OverlayLens): CanvasOverlay {
  const overlay: CanvasOverlay = { byFile: new Map(), arrivals: new Map(), unplaced: 0, shown: [] }
  if (lens === 'off') return overlay
  const others = list(snapshot?.checkouts).filter(checkout => !checkout.isFocused).map(checkout => checkout.rootId).sort()
  const tints = new Map(others.map((id, index) => [id, OVERLAY_TINTS[index % OVERLAY_TINTS.length]]))
  for (const checkout of list(snapshot?.checkouts)) {
    if (checkout.isFocused) continue
    if (lens === 'agents' && list(checkout.agents).length === 0) continue
    overlay.shown.push(checkout)
    const name = checkoutName(checkout)
    const tint = tints.get(checkout.rootId) ?? OVERLAY_TINTS[0]
    const arrivals = new Map<string, string[]>()
    for (const file of list(checkout.overlay)) {
      if (file.change === 'added') {
        if (!file.systemId) { overlay.unplaced += 1; continue }
        const paths = arrivals.get(file.systemId)
        if (paths) paths.push(file.path)
        else arrivals.set(file.systemId, [file.path])
      } else if (file.fileId) {
        const mark: OverlayMark = { rootId: checkout.rootId, name, tint, change: file.change }
        const marks = overlay.byFile.get(file.fileId)
        if (marks) marks.push(mark)
        else overlay.byFile.set(file.fileId, [mark])
      }
    }
    for (const [systemId, paths] of arrivals) {
      const arrival = { rootId: checkout.rootId, name, tint, paths }
      const rails = overlay.arrivals.get(systemId)
      if (rails) rails.push(arrival)
      else overlay.arrivals.set(systemId, [arrival])
    }
  }
  return overlay
}

/** "+2 ~1 −1": what a checkout's overlay holds, or '' when it is empty. */
export function overlaySummary(checkout: CheckoutStatus): string {
  const counts = { added: 0, modified: 0, deleted: 0 }
  for (const file of list(checkout.overlay)) counts[file.change] += 1
  const parts = [
    counts.added ? `+${counts.added}` : '',
    counts.modified ? `~${counts.modified}` : '',
    counts.deleted ? `−${counts.deleted}` : '',
  ].filter(Boolean)
  const more = checkout.overlayTruncated ? ` (+${checkout.overlayTruncated} more)` : ''
  return parts.length ? `${parts.join(' ')} files${more}` : ''
}

export interface RepositoryRow {
  folder: string
  name: string
  state: string
}

/** Repositories inside the Floor's folder, for the Checkouts popover. */
export function buildRepositoryRows(snapshot: CheckoutsSnapshot | null): RepositoryRow[] {
  return list<RepositoryStatus>(snapshot?.repositories).map(repository => ({
    folder: repository.folder,
    name: checkoutName(repository),
    state: checkoutState(repository),
  }))
}

/**
 * Where an earlier turn of this conversation is working, when that is not the
 * project's own checkout: the worktree's branch, else its folder.
 */
export function conversationWorkplace(runs: Array<{ rootPath: string; startedAt: number } | undefined>, rootPath: string, checkouts: CheckoutStatus[] | undefined): string {
  const trim = (path: string) => path.replace(/[\\/]+$/, '')
  const away = runs.filter((run): run is { rootPath: string; startedAt: number } => !!run && !!run.rootPath && trim(run.rootPath) !== trim(rootPath))
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!away) return ''
  const checkout = list(checkouts).find(item => trim(item.path) === trim(away.rootPath))
  if (checkout?.isPrimary) return ''
  return `in ${checkout?.branch || trim(away.rootPath).split(/[\\/]/).pop()}`
}

export type SyncState = 'behind' | 'ahead' | 'current' | 'diverged' | 'unpublished' | 'local' | 'other'

export interface SyncModel {
  /** Which of the branch's situations this is; each has its own symbol. */
  state: SyncState
  /** The situation in a few words: "3 commits to pull", "Up to date". */
  headline: string
  /** What it means, when the headline is not enough on its own. */
  detail?: string
  /** The remote branch it tracks, or where it would be published. */
  remote?: string
  ahead: number
  behind: number
  /** The one action the state calls for. */
  action?: { kind: 'pull' | 'push' | 'publish'; label: string }
  /** Whether the remote can be checked at all (Check for updates). */
  canCheck: boolean
  /** "Checked 2 min ago", "Not checked yet"; empty with no remote. */
  checked: string
  /** Files changed and not committed. */
  uncommitted: number
}

const commits = (count: number) => `${count} commit${count === 1 ? '' : 's'}`

/** How long ago, in a few words: "just now", "4 min ago", "3 h ago", "2 days ago". */
export function timeAgo(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The Floor's branch against its remote, for the top of the branch menu
 * (docs/GIT_WORKFLOW.md "The branch popover"): the situation and the action it
 * calls for. Diverged branches get no action: that is a merge, not a pull.
 */
export function buildSync(checkout: CheckoutStatus | undefined, now = Date.now()): SyncModel {
  const blank: SyncModel = { state: 'other', headline: '', ahead: 0, behind: 0, canCheck: false, checked: '', uncommitted: 0 }
  if (!checkout) return blank
  const uncommitted = checkout.changedFiles
  if (checkout.headState !== 'commit' || checkout.error) return { ...blank, headline: checkoutState(checkout), uncommitted }
  const upstream = checkout.upstream
  const canCheck = !!upstream || !!checkout.publishRemote
  const checked = !canCheck ? '' : checkout.fetchedAt ? `Checked ${timeAgo(checkout.fetchedAt, now)}` : 'Not checked yet'
  const { ahead, behind } = checkout
  const base = { ahead, behind, canCheck, checked, uncommitted }
  if (!upstream) {
    return checkout.publishRemote
      ? { ...base, state: 'unpublished', headline: 'Not published yet', remote: checkout.publishRemote,
          detail: `${checkout.branch} is only on this computer.`,
          action: { kind: 'publish', label: `Publish to ${checkout.publishRemote}` } }
      : { ...base, state: 'local', headline: 'No remote', detail: 'This repository has no remote to sync with.' }
  }
  if (ahead > 0 && behind > 0) {
    return { ...base, state: 'diverged', headline: 'Diverged from the remote', remote: upstream,
      detail: `${commits(behind)} to pull and ${commits(ahead)} to push, so this needs a merge. Merge in your editor or terminal for now; merging in Ambio is coming.` }
  }
  if (behind > 0) return { ...base, state: 'behind', headline: `${commits(behind)} to pull`, remote: upstream, action: { kind: 'pull', label: `Pull ${commits(behind)}` } }
  if (ahead > 0) return { ...base, state: 'ahead', headline: `${commits(ahead)} to push`, remote: upstream, action: { kind: 'push', label: `Push ${commits(ahead)}` } }
  return { ...base, state: 'current', headline: 'Up to date', detail: `Nothing to pull from or push to ${upstream}.`, remote: upstream }
}

/** A path with the home folder written as ~, as terminals show it. */
export function homePath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/, '~')
}

export interface BranchRow {
  name: string
  /** The Floor is on it. */
  current: boolean
  /** Open in another worktree: choosing it shows that checkout instead. */
  rootId?: string
  upstream?: string
  gone: boolean
  ahead: number
  behind: number
  /** "3 days ago · Fix the retry loop" */
  last: string
}

/**
 * The branch menu's list (docs/GIT_WORKFLOW.md "Switching branches"): the
 * Floor's branch first, then the rest most recently committed first, narrowed
 * by what was typed. What was typed is offered as a new branch unless a branch
 * already has that name; spaces become dashes, as Git allows none.
 */
export function buildBranchRows(
  listing: { current: string; branches: BranchListing[] } | null,
  query: string,
  now = Date.now(),
): { rows: BranchRow[]; create: string | null } {
  if (!listing) return { rows: [], create: null }
  const wanted = query.trim().toLowerCase()
  const rows = listing.branches
    .filter(branch => !wanted || branch.name.toLowerCase().includes(wanted))
    .map((branch): BranchRow => {
      const current = branch.name === listing.current
      return {
        name: branch.name, current, rootId: current ? undefined : branch.rootId,
        upstream: branch.upstream, gone: !!branch.gone, ahead: branch.ahead ?? 0, behind: branch.behind ?? 0,
        last: [branch.committedAt ? timeAgo(branch.committedAt, now) : '', branch.subject ?? ''].filter(Boolean).join(' · '),
      }
    })
    .sort((left, right) => Number(right.current) - Number(left.current))
  const name = query.trim().replace(/\s+/g, '-')
  const create = name && !listing.branches.some(branch => branch.name === name) ? name : null
  return { rows, create }
}
