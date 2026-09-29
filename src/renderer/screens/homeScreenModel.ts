import type { ProjectConfig } from '../../shared/types'

export interface KeyboardNavigationState {
  activeIndex: number | null
}

export function filterRecentProjects(projects: ProjectConfig[], query: string): ProjectConfig[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return projects
  return projects.filter(project => {
    const nameMatch = project.name.toLowerCase().includes(normalized)
    const pathMatch = project.rootPath.toLowerCase().includes(normalized)
    return nameMatch || pathMatch
  })
}

/** How many projects the launcher lists before "Show all". */
export const RECENT_PROJECT_LIMIT = 8

export interface LauncherProjectList {
  /** Rows to render, most recently opened first. */
  visible: ProjectConfig[]
  /** Projects not listed right now; "Show all" reveals them. */
  notShown: number
  mode: 'recent' | 'all' | 'search'
}

/**
 * The launcher shows a short recent list; the registry itself is unlimited.
 * Search always covers every project, hidden ones included, so nothing the
 * user has ever opened is unreachable from here.
 */
export function launcherProjects(
  projects: ProjectConfig[],
  query: string,
  showAll: boolean,
  limit = RECENT_PROJECT_LIMIT,
): LauncherProjectList {
  const byRecency = [...projects].sort((left, right) => (right.openedAt ?? 0) - (left.openedAt ?? 0))
  if (query.trim()) {
    return { visible: filterRecentProjects(byRecency, query), notShown: 0, mode: 'search' }
  }
  if (showAll) return { visible: byRecency, notShown: 0, mode: 'all' }
  const recent = byRecency.filter(project => !project.hiddenFromRecents).slice(0, limit)
  return { visible: recent, notShown: projects.length - recent.length, mode: 'recent' }
}

export function navigateProjects(
  direction: 'up' | 'down',
  total: number,
  currentIndex: number | null,
): number | null {
  if (total <= 0) return null
  if (currentIndex === null || currentIndex < 0 || currentIndex >= total) {
    return direction === 'down' ? 0 : total - 1
  }
  if (direction === 'down') {
    return (currentIndex + 1) % total
  }
  return (currentIndex - 1 + total) % total
}

export interface KeyNavAction {
  type: 'NAVIGATE' | 'OPEN' | 'FOCUS_SEARCH' | 'CLEAR_SEARCH' | 'NOOP'
  nextIndex?: number | null
}

export interface KeyboardEventLike {
  key: string
  target?: EventTarget | null
  defaultPrevented?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  preventDefault?: () => void
}

export function handleLauncherKey(
  event: KeyboardEventLike,
  options: {
    isSearchFocused: boolean
    hasQuery: boolean
    totalProjects: number
    activeIndex: number | null
  },
): KeyNavAction {
  const { isSearchFocused, hasQuery, totalProjects, activeIndex } = options
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return { type: 'NOOP' }
  const target = event.target as HTMLElement | undefined
  const targetTag = target?.tagName?.toLowerCase()
  const isEditable = targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select' || Boolean(target?.isContentEditable)
  const isSearchInput = targetTag === 'input' && isSearchFocused

  // Pressing '/' when not in another input focuses the search box
  if (event.key === '/' && !isEditable) {
    event.preventDefault?.()
    return { type: 'FOCUS_SEARCH' }
  }

  // Native controls keep their own keys. Only the launcher search input uses
  // arrows and Enter to choose a project.
  if (targetTag === 'button' || (isEditable && !isSearchInput)) return { type: 'NOOP' }

  // Arrow navigation
  if (event.key === 'ArrowDown') {
    event.preventDefault?.()
    const nextIndex = navigateProjects('down', totalProjects, activeIndex)
    return { type: 'NAVIGATE', nextIndex }
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault?.()
    const nextIndex = navigateProjects('up', totalProjects, activeIndex)
    return { type: 'NAVIGATE', nextIndex }
  }

  // Enter triggers open on active selection
  if (event.key === 'Enter') {
    if (activeIndex !== null && activeIndex >= 0 && activeIndex < totalProjects) {
      event.preventDefault?.()
      return { type: 'OPEN', nextIndex: activeIndex }
    }
  }

  // Escape clears search or deselects
  if (event.key === 'Escape') {
    if (hasQuery || isSearchFocused) {
      event.preventDefault?.()
      return { type: 'CLEAR_SEARCH', nextIndex: null }
    }
  }

  return { type: 'NOOP' }
}
