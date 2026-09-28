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
  const targetTag = (event.target as HTMLElement | undefined)?.tagName?.toLowerCase()
  const isInputTarget = targetTag === 'input' || targetTag === 'textarea'

  // Pressing '/' when not in another input focuses the search box
  if (event.key === '/' && !isInputTarget) {
    event.preventDefault?.()
    return { type: 'FOCUS_SEARCH' }
  }

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
