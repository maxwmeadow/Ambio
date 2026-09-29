import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterRecentProjects,
  navigateProjects,
  handleLauncherKey,
  launcherProjects,
} from './homeScreenModel.ts'

const FIXTURE_PROJECTS = [
  { id: 'p1', name: 'Alpha Service', rootPath: '/Users/dev/repos/alpha-service', openedAt: 1000 },
  { id: 'p2', name: 'Beta Gateway', rootPath: '/Users/dev/repos/beta-gateway', openedAt: 2000 },
  { id: 'p3', name: 'Gamma Processor', rootPath: '/Users/dev/repos/gamma-proc', openedAt: 3000 },
  { id: 'p4', name: 'Delta CLI', rootPath: '/Users/dev/repos/delta-tool', openedAt: 4000 },
]

test('filterRecentProjects matches against name and rootPath case-insensitively', () => {
  assert.equal(filterRecentProjects(FIXTURE_PROJECTS, '').length, 4)
  assert.equal(filterRecentProjects(FIXTURE_PROJECTS, '   ').length, 4)

  const byName = filterRecentProjects(FIXTURE_PROJECTS, 'beta')
  assert.equal(byName.length, 1)
  assert.equal(byName[0].id, 'p2')

  const byPath = filterRecentProjects(FIXTURE_PROJECTS, 'gamma-proc')
  assert.equal(byPath.length, 1)
  assert.equal(byPath[0].id, 'p3')

  const caseInsensitive = filterRecentProjects(FIXTURE_PROJECTS, 'DELTA')
  assert.equal(caseInsensitive.length, 1)
  assert.equal(caseInsensitive[0].id, 'p4')

  const noMatch = filterRecentProjects(FIXTURE_PROJECTS, 'nonexistent')
  assert.equal(noMatch.length, 0)
})

test('navigateProjects cycles through project indices with bounds wrapping', () => {
  assert.equal(navigateProjects('down', 0, null), null)
  assert.equal(navigateProjects('up', 0, null), null)

  // Initial step from null
  assert.equal(navigateProjects('down', 3, null), 0)
  assert.equal(navigateProjects('up', 3, null), 2)

  // Step down
  assert.equal(navigateProjects('down', 3, 0), 1)
  assert.equal(navigateProjects('down', 3, 1), 2)
  assert.equal(navigateProjects('down', 3, 2), 0) // wrap to 0

  // Step up
  assert.equal(navigateProjects('up', 3, 0), 2) // wrap to 2
  assert.equal(navigateProjects('up', 3, 2), 1)
  assert.equal(navigateProjects('up', 3, 1), 0)
})

test('handleLauncherKey keyboard dispatcher routes keys properly', () => {
  let prevented = false
  const makeEvent = (key, targetTag = 'body') => ({
    key,
    target: { tagName: targetTag },
    preventDefault: () => { prevented = true },
  })

  // '/' focuses search when outside an input
  prevented = false
  const slashAction = handleLauncherKey(makeEvent('/'), {
    isSearchFocused: false,
    hasQuery: false,
    totalProjects: 4,
    activeIndex: null,
  })
  assert.equal(slashAction.type, 'FOCUS_SEARCH')
  assert.equal(prevented, true)

  // '/' does nothing special when already inside an input
  prevented = false
  const slashInInputAction = handleLauncherKey(makeEvent('/', 'input'), {
    isSearchFocused: true,
    hasQuery: false,
    totalProjects: 4,
    activeIndex: null,
  })
  assert.equal(slashInInputAction.type, 'NOOP')
  assert.equal(prevented, false)

  // Enter on a focused launcher button must activate that button, not a
  // previously highlighted recent project.
  assert.equal(handleLauncherKey(makeEvent('Enter', 'button'), {
    isSearchFocused: false,
    hasQuery: false,
    totalProjects: 4,
    activeIndex: 1,
  }).type, 'NOOP')

  assert.equal(handleLauncherKey(makeEvent('Enter', 'input'), {
    isSearchFocused: false,
    hasQuery: false,
    totalProjects: 4,
    activeIndex: 1,
  }).type, 'NOOP')

  // ArrowDown selects next
  const downAction = handleLauncherKey(makeEvent('ArrowDown'), {
    isSearchFocused: false,
    hasQuery: false,
    totalProjects: 4,
    activeIndex: 1,
  })
  assert.equal(downAction.type, 'NAVIGATE')
  assert.equal(downAction.nextIndex, 2)

  // Enter triggers OPEN if activeIndex is valid
  const enterAction = handleLauncherKey(makeEvent('Enter'), {
    isSearchFocused: false,
    hasQuery: false,
    totalProjects: 4,
    activeIndex: 2,
  })
  assert.equal(enterAction.type, 'OPEN')
  assert.equal(enterAction.nextIndex, 2)

  // Escape clears search
  const escAction = handleLauncherKey(makeEvent('Escape'), {
    isSearchFocused: true,
    hasQuery: true,
    totalProjects: 4,
    activeIndex: 2,
  })
  assert.equal(escAction.type, 'CLEAR_SEARCH')
})

test('screen-level keyboard interaction flow: search, arrow navigation, and enter selection', () => {
  // Simulate the HomeScreen component's internal state machine
  class MockHomeScreenSession {
    projects = FIXTURE_PROJECTS
    searchQuery = ''
    activeIndex = null
    openedProject = null
    searchFocused = false

    get filteredProjects() {
      return filterRecentProjects(this.projects, this.searchQuery)
    }

    sendKey(key, targetTag = 'body') {
      let defaultPrevented = false
      const event = {
        key,
        target: { tagName: targetTag },
        preventDefault: () => { defaultPrevented = true },
      }

      const action = handleLauncherKey(event, {
        isSearchFocused: this.searchFocused,
        hasQuery: this.searchQuery.length > 0,
        totalProjects: this.filteredProjects.length,
        activeIndex: this.activeIndex,
      })

      switch (action.type) {
        case 'FOCUS_SEARCH':
          this.searchFocused = true
          break
        case 'NAVIGATE':
          this.activeIndex = action.nextIndex ?? null
          break
        case 'OPEN':
          if (this.activeIndex !== null && this.filteredProjects[this.activeIndex]) {
            this.openedProject = this.filteredProjects[this.activeIndex]
          }
          break
        case 'CLEAR_SEARCH':
          this.searchQuery = ''
          this.searchFocused = false
          this.activeIndex = null
          break
        case 'NOOP':
          break
      }
      return { action, defaultPrevented }
    }

    typeSearch(text) {
      this.searchQuery = text
      // Auto-adjust or reset activeIndex if out of range
      if (this.activeIndex !== null && this.activeIndex >= this.filteredProjects.length) {
        this.activeIndex = this.filteredProjects.length > 0 ? 0 : null
      }
    }
  }

  const session = new MockHomeScreenSession()

  // 1. Initial state: no project selected, search not focused
  assert.equal(session.activeIndex, null)
  assert.equal(session.openedProject, null)
  assert.equal(session.searchFocused, false)

  // 2. User presses '/' from somewhere on the screen
  const slashStep = session.sendKey('/')
  assert.equal(slashStep.action.type, 'FOCUS_SEARCH')
  assert.equal(session.searchFocused, true)

  // 3. User types "gate" to filter down to Beta Gateway
  session.typeSearch('gate')
  assert.equal(session.filteredProjects.length, 1)
  assert.equal(session.filteredProjects[0].name, 'Beta Gateway')

  // 4. User presses ArrowDown to highlight the result
  session.sendKey('ArrowDown', 'input')
  assert.equal(session.activeIndex, 0)
  assert.equal(session.filteredProjects[session.activeIndex].id, 'p2')

  // 5. User presses Enter while on the search input
  session.sendKey('Enter', 'input')
  assert.notEqual(session.openedProject, null)
  assert.equal(session.openedProject.name, 'Beta Gateway')
  assert.equal(session.openedProject.id, 'p2')

  // 6. Reset session and test multi-item arrow navigation without query
  const session2 = new MockHomeScreenSession()
  assert.equal(session2.filteredProjects.length, 4)

  // ArrowDown -> project 0 (Alpha)
  session2.sendKey('ArrowDown')
  assert.equal(session2.activeIndex, 0)

  // ArrowDown -> project 1 (Beta)
  session2.sendKey('ArrowDown')
  assert.equal(session2.activeIndex, 1)

  // ArrowDown -> project 2 (Gamma)
  session2.sendKey('ArrowDown')
  assert.equal(session2.activeIndex, 2)

  // ArrowUp -> back to project 1 (Beta)
  session2.sendKey('ArrowUp')
  assert.equal(session2.activeIndex, 1)

  // Enter -> opens project 1 (Beta)
  session2.sendKey('Enter')
  assert.equal(session2.openedProject.id, 'p2')
})

test('launcherProjects lists recent projects newest first and hides the rest behind show all', () => {
  const projects = Array.from({ length: 12 }, (_, index) => ({
    id: `p${index}`, name: `Project ${index}`, rootPath: `/r/${index}`, openedAt: index,
  }))
  projects[11] = { ...projects[11], hiddenFromRecents: true }

  const recent = launcherProjects(projects, '', false, 8)
  assert.equal(recent.mode, 'recent')
  assert.deepEqual(recent.visible.map(project => project.id), ['p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3'])
  assert.equal(recent.notShown, 4)

  const all = launcherProjects(projects, '', true, 8)
  assert.equal(all.visible.length, 12)
  assert.equal(all.visible[0].id, 'p11')

  const search = launcherProjects(projects, 'project 11', false, 8)
  assert.equal(search.mode, 'search')
  assert.deepEqual(search.visible.map(project => project.id), ['p11'])
})
