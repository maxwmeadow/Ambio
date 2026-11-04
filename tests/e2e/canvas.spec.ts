import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { skipAgentGuides } from './agentGuides'
import { clipOrthogonalEdge } from '../../src/renderer/canvas/edges/clippedEdgeGeometry'
import { canvasViewportSettled } from './canvasComponentCounts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type Route } from '@playwright/test'

let app: ElectronApplication
let page: Page
let e2eHome: string

/**
 * Every run gets its own home folder: the app's project registry, settings
 * and window state are read from there, so the suite neither depends on nor
 * writes to the developer's real ~/.ambio. The fixture project is registered
 * and has a small real folder for the setup screen to browse.
 */
function isolatedHome(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), 'ambio-e2e-home-'))
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  const root = join(home, 'ambio-e2e')
  for (const dir of ['src/renderer', 'docs', 'electron']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{ "name": "ambio-e2e" }\n')
  writeFileSync(join(root, 'ARCHITECTURE.md'), '# Architecture\n\nThe renderer consumes indexed source only.\n')
  writeFileSync(join(root, 'electron.vite.config.ts'), 'export default {}\n')
  writeFileSync(join(root, 'src/renderer/App.tsx'), 'export const App = () => null\n')
  const project = (id: string, name: string, openedAt: number) => ({
    id, name, rootPath: root, ignoredPaths: [], languageOverrides: {},
    layoutPreferences: { zoom: 1, panX: 0, panY: 0 }, openedAt,
  })
  mkdirSync(join(home, '.ambio'), { recursive: true })
  writeFileSync(join(home, '.ambio', 'projects.json'), JSON.stringify([
    project('demo', 'Ambio Canvas Fixture', 2),
    project('fixture-shopfront', 'shopfront', 1),
  ], null, 2))
  return { home, root }
}

async function expectResizeChrome(nodeId: string) {
  const handles = page.locator(`.ambio-node-resizer[data-node-id="${nodeId}"] .ambio-floating-resize-handle`)
  await expect(handles).toHaveCount(8)
  for (const handle of await handles.all()) {
    const hitBox = await handle.boundingBox()
    const visualBox = await handle.locator('rect').first().boundingBox()
    expect(hitBox?.width).toBeCloseTo(18, 0)
    expect(hitBox?.height).toBeCloseTo(18, 0)
    expect(visualBox?.width).toBeCloseTo(8, 0)
    expect(visualBox?.height).toBeCloseTo(8, 0)
  }
  return handles
}

async function revealFileNode(nodeId: string) {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  if (await node.count() === 0) {
    const relPath = await page.evaluate(id => {
      const graphStore = (window as unknown as {
        __ambioGraphStore: { getState: () => { files: Array<{ id: string; relPath: string }> } }
      }).__ambioGraphStore
      return graphStore.getState().files.find(file => file.id === id)?.relPath ?? null
    }, nodeId)
    expect(relPath, `missing E2E file ${nodeId}`).not.toBeNull()
    await page.keyboard.press('ControlOrMeta+K')
    const search = page.getByRole('textbox', { name: 'Search the map' })
    await search.fill(relPath!)
    await page.getByRole('option').first().click()
    await expect(node).toBeAttached()
  }
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return node
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let index = 0; index < 15; index += 1) {
    if (!await node.evaluate(element => element.classList.contains('ambio-node-hidden'))) break
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(30)
  }
  await expect(node).not.toHaveClass(/ambio-node-hidden/)
  // Wheel zoom is smoothed with requestAnimationFrame. The semantic class can
  // flip before the camera reaches its target, so interaction measurements
  // must wait for that final frame.
  await page.waitForTimeout(900)
  return node
}

test.beforeEach(async () => {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const isolated = isolatedHome()
  e2eHome = isolated.home
  app = await electron.launch({
    args: ['.'],
    env: { ...env, AMBIO_E2E: '1', AMBIO_E2E_ROOT: isolated.root, HOME: isolated.home, USERPROFILE: isolated.home, APPDATA: join(isolated.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(isolated.home, 'AppData', 'Local') },
  })
  page = await app.firstWindow()
  await skipAgentGuides(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
    const url = route.request().url()
    const method = route.request().method()
    const newSheet = {
      id: 'sheet_new', workspaceId: 'demo', name: 'New system', purpose: '', kind: 'structure',
      folder: '', createdBy: 'user', revision: 1, createdAt: 2, updatedAt: 2,
    }
    const body = method === 'POST' && /\/api\/sheets$/.test(url.split('?')[0])
      ? newSheet
      : method === 'POST' && /\/api\/sheets\/[^/]+\/removals$/.test(url.split('?')[0])
      ? {
          sheetId: url.split('/api/sheets/')[1].split('/')[0], nodeId: route.request().postDataJSON().nodeId,
          nodeType: 'file', label: route.request().postDataJSON().nodeId, createdBy: 'user', createdAt: 4, done: false,
        }
      : method === 'DELETE' && url.includes('/removals/')
      ? { restored: true }
      : method === 'POST' && url.includes('/api/sheets/sheet_new/planned-edges')
      ? { id: 'edge_new', sheetId: 'sheet_new', ...route.request().postDataJSON() }
      : url.includes('/api/sheets/sheet_new?')
      ? { sheet: newSheet, elements: [], annotations: [], planned: [], plannedEdges: [] }
      : method === 'POST' && url.includes('/api/sheets/sheet_new/planned')
      ? { ...route.request().postDataJSON(), sheetId: 'sheet_new', status: 'planned', createdAt: 3, updatedAt: 3 }
      : url.includes('/api/sheets/sheet_new/layouts/batch')
      ? { revision: 2, layouts: [] }
      : url.includes('/api/investigation/list?')
      ? {
          investigations: [{
            id: 'inv_checkout',
            name: 'Checkout timeout',
            commit: '9fc31ab4470',
            branch: 'fix/checkout',
            createdAt: 1_720_000_000_000,
            durationMs: 3_250,
            eventCount: 2,
          }],
        }
      : url.includes('/api/investigation/inv_checkout?')
        ? {
            id: 'inv_checkout',
            name: 'Checkout timeout',
            commit: '9fc31ab4470',
            branch: 'fix/checkout',
            createdAt: 1_720_000_000_000,
            durationMs: 3_250,
            events: [
              {
                type: 'investigation:note',
                offsetMs: 0,
                payload: { text: 'Checkout stalls after authorization' },
              },
              {
                type: 'runtime:call',
                offsetMs: 250,
                payload: { fileId: 'file_canvas', symbol: 'authorizePayment' },
              },
            ],
          }
      : url.includes('/api/layout/batch')
      ? { revision: 1, layouts: [] }
      : url.includes('/api/architecture/edits')
      ? { changes: [{ op: 'nest', changed: true, eventIds: [1] }] }
      : url.includes('/api/files/file_canvas/symbols?')
        ? [{
            id: 'symbol_render_canvas',
            fileId: 'file_canvas',
            name: 'renderCanvas',
            kind: 'function',
            lineStart: 3,
            lineEnd: 6,
          }]
      : url.includes('/api/files/file_canvas/source?')
        ? {
            fileId: 'file_canvas',
            relPath: 'src/renderer/canvas/AmbioCanvas.tsx',
            language: 'tsx',
            lineCount: 7,
            content: [
              "import React from 'react'",
              '',
              'export function renderCanvas() {',
              '  const ready = true',
              '  const canvas = <Canvas />',
              '  return ready ? canvas : null',
              '}',
            ].join('\n'),
          }
      : url.includes('/api/files/file_docs/source?')
        ? {
            fileId: 'file_docs',
            relPath: 'docs/ARCHITECTURE.md',
            language: 'markdown',
            lineCount: 3,
            content: '# Architecture\n\nThe renderer consumes indexed source only.',
          }
      : url.includes('/api/sheets/sheet_runtime?')
        ? {
            sheet: {
              id: 'sheet_runtime',
              workspaceId: 'demo',
              name: 'Runtime Draft',
              purpose: 'Focused runtime architecture',
              kind: 'structure',
              folder: '',
              createdBy: 'user',
              revision: 1,
              createdAt: 1,
              updatedAt: 1,
            },
            elements: [],
            annotations: [],
            planned: [],
            plannedEdges: [],
          }
      : url.includes('/api/sheets?workspace=')
        ? [{
            id: 'sheet_runtime',
            workspaceId: 'demo',
            name: 'Runtime Draft',
            purpose: 'Focused runtime architecture',
            kind: 'structure',
            folder: '',
            createdBy: 'user',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          }]
      : url.includes('/api/registry/services')
        ? {
            categories: [],
            services: [
              {
                id: 'aws/rds',
                name: 'Amazon RDS',
                category: 'database',
                subtype: 'relational',
                provider: 'aws',
                brand: { icon: '', color: '#d58b2d' },
              },
              {
                id: 'openai/api',
                name: 'OpenAI API',
                category: 'llm',
                provider: 'openai',
                brand: { icon: '', color: '#4f8b79' },
              },
            ],
          }
      : url.includes('/api/canvas/history')
        ? { messages: [], nextCursor: '', availableCount: 0 }
        : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  // Reload after routing so even the fixture's initial layout persistence is
  // deterministic and cannot race a refused localhost request.
  await page.evaluate(() => {
    localStorage.removeItem('ambio:inbox-draft:demo')
    localStorage.removeItem('ambio:inbox-draft:demo:pending')
    localStorage.removeItem('ambio:inbox-draft:demo:sheet')
  })
  await page.reload()
  // Project/view labels were intentionally removed from the title bar. Check
  // the fixture identity in its store rather than requiring that retired text.
  await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore?.getState().currentProject?.name)).toBe('Ambio Canvas Fixture')
  await expect(page.locator('.ambio-toolbar')).toBeVisible()
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  await expect(page.locator('.ambio-canvas-minimap')).toBeVisible()
  // Initial sheet chrome and fitView animations run for 500ms and 400ms.
  // Measure interactions only after both have reached their authored frame.
  await expect(page.locator('.layout-transition')).toHaveCount(0)
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
})

test.afterEach(async () => {
  await app?.close()
  if (e2eHome) rmSync(e2eHome, { recursive: true, force: true })
})

/** The canvas zoom, read from React Flow's viewport transform. */
const canvasZoom = () => page.locator('.react-flow__viewport')
  .evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)

test('renders the deterministic Floor baseline', async () => {
  await expect(page.locator('.react-flow')).toHaveScreenshot('floor-baseline.png')
})

test('WASD follows pointer ownership through stationary overlays and ignores text editing', async () => {
  const canvas = page.locator('[data-ambio-canvas]').first()
  const viewport = canvas.locator('.react-flow__viewport')
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  await page.mouse.move(point.x, point.y)
  const before = await viewport.getAttribute('style')
  await page.keyboard.down('d')
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(before)
  // A nested surface appearing beneath a stationary pointer takes ownership.
  await page.evaluate(point => {
    const overlay = document.createElement('div')
    overlay.id = 'wasd-scope-probe'
    overlay.setAttribute('data-ambio-canvas', 'test-overlay')
    Object.assign(overlay.style, { position: 'fixed', left: `${point.x - 50}px`, top: `${point.y - 50}px`,
      width: '100px', height: '100px', background: '#fff', zIndex: '2147483647' })
    document.body.append(overlay)
  }, point)
  await page.waitForTimeout(100)
  const occluded = await viewport.getAttribute('style')
  await page.waitForTimeout(100)
  expect(await viewport.getAttribute('style')).toBe(occluded)
  await page.evaluate(() => document.getElementById('wasd-scope-probe')!.remove())
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(occluded)
  await page.keyboard.up('d')
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'wasd-editor-probe'
    document.body.append(input)
    input.focus()
  })
  const editing = await viewport.getAttribute('style')
  await page.keyboard.down('d'); await page.waitForTimeout(100); await page.keyboard.up('d')
  expect(await viewport.getAttribute('style')).toBe(editing)
  await page.evaluate(() => document.getElementById('wasd-editor-probe')!.remove())
})

test('clipped dashed routes preserve browser rasterization at ordinary and extreme zoom', async () => {
  const cases = [0.02, 0.5, 1, 2, 100].flatMap(zoom => [true, false].map(nonScaling => {
    const points = [{ x: -157, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 400 },
      { x: 200, y: 400 }, { x: 200, y: 50 }, { x: 220, y: 50 }].map(p => ({ x: p.x / zoom, y: p.y / zoom }))
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('')
    const parts = clipOrthogonalEdge(points, { x: -64 / zoom, y: -64 / zoom, width: 384 / zoom, height: 256 / zoom })
    return { zoom, nonScaling, path, parts }
  }))
  for (const c of cases) {
    await page.evaluate(c => {
      const common = `fill="none" stroke="black" stroke-width="${c.nonScaling ? 2 : 2 / c.zoom}" stroke-dasharray="${c.nonScaling ? '6 4' : `${6 / c.zoom} ${4 / c.zoom}`}" ${c.nonScaling ? 'vector-effect="non-scaling-stroke"' : ''}`
      // Match React Flow's HTML camera transform and overflow-visible SVG,
      // rather than testing only an SVG-internal transform.
      const wrap = (content: string) => `<div style="width:100%;height:100%;transform:scale(${c.zoom});transform-origin:0 0"><svg width="256" height="128" style="overflow:visible">${content}</svg></div>`
      const host = document.createElement('div'); host.dataset.edgeParityHost = 'true'
      const base = 'position:fixed;top:20px;width:256px;height:128px;overflow:hidden;background:white;z-index:2147483000;pointer-events:none'
      host.innerHTML = `<div data-edge-raster="original" style="${base};left:20px">${wrap(`<path d="${c.path}" ${common}/>` )}</div>` +
        `<div data-edge-raster="clipped" style="${base};left:300px">${wrap(c.parts.map(p => `<path d="${p.path}" ${common} stroke-dashoffset="${p.startLength}"/>`).join(''))}</div>`
      document.body.append(host)
    }, c)
    try {
      const original = await page.locator('[data-edge-raster="original"]').screenshot()
      const clipped = await page.locator('[data-edge-raster="clipped"]').screenshot()
      const difference = await app.evaluate(({ nativeImage }, images) => {
        const a = nativeImage.createFromBuffer(Buffer.from(images.original, 'base64')).toBitmap()
        const b = nativeImage.createFromBuffer(Buffer.from(images.clipped, 'base64')).toBitmap()
        if (a.length !== b.length) return { maximum: 255, changed: -1 }
        let maximum = 0, changed = 0
        for (let i = 0; i < a.length; i++) {
          const difference = Math.abs(a[i] - b[i])
          maximum = Math.max(maximum, difference); changed += Number(difference > 1)
        }
        return { maximum, changed }
      }, { original: original.toString('base64'), clipped: clipped.toString('base64') })
      expect(difference.changed, JSON.stringify({ zoom: c.zoom, nonScaling: c.nonScaling, ...difference })).toBe(0)
    } finally {
      await page.evaluate(() => document.querySelector('[data-edge-parity-host]')?.remove())
    }
  }
})

test('autofits complete system names while their contents are covered', async () => {
  const longName = 'Longitudinal Tracking and Trend Persistence'
  const targetId = await page.evaluate(name => {
    const graphStore = (window as any).__ambioGraphStore
    const state = graphStore.getState()
    const target = state.systems.find((system: any) => system.parentId == null) ?? state.systems[0]
    graphStore.getState().applySnapshot({
      workspaceId: state.currentProject.id,
      systems: state.systems.map((system: any) => system.id === target.id
        ? { ...system, name }
        : system),
      files: state.files,
      infraNodes: state.infraNodes,
      dependencies: state.dependencies,
      floorLayouts: state.floorLayouts,
    })
    return target.id
  }, longName)
  const node = page.locator(`.react-flow__node[data-id="${targetId}"]`)
  await expect(node.getByText(longName, { exact: true }).first()).toBeVisible()
  const titles = await node.getByText(longName, { exact: true }).evaluateAll(elements =>
    elements.map(element => {
      const parent = element.parentElement!
      const elementRect = element.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      const parentStyle = getComputedStyle(parent)
      return {
        parentZIndex: parentStyle.zIndex,
        textOverflow: getComputedStyle(element).textOverflow,
        textWidth: elementRect.width,
        availableWidth: parentRect.width
          - Number.parseFloat(parentStyle.paddingLeft)
          - Number.parseFloat(parentStyle.paddingRight),
      }
    }),
  )
  const covered = titles.find(title => title.parentZIndex === '15')
  expect(covered).toBeDefined()
  expect(covered!.textOverflow).not.toBe('ellipsis')
  expect(covered!.textWidth).toBeLessThanOrEqual(covered!.availableWidth + 1)
})

test('defers and virtualizes an 805-file fresh-project overview', async () => {
  const fixture = await page.evaluate(() => {
    const graphStore = (window as any).__ambioGraphStore
    const state = graphStore.getState()
    const baseProject = state.currentProject
    const fileTemplate = state.files[0]
    const systemTemplate = state.systems[0]
    const files = Array.from({ length: 805 }, (_, index) => ({
      ...fileTemplate,
      id: `perf-file-${index}`,
      rootId: 'perf-root',
      relPath: `src/group-${index % 24}/file-${index}.ts`,
      path: `src/group-${index % 24}/file-${index}.ts`,
      systemId: null,
      positionX: 0,
      positionY: 0,
    }))
    const systems = Array.from({ length: 24 }, (_, index) => ({
      ...systemTemplate,
      id: `perf-system-${index}`,
      workspaceId: 'perf-large',
      name: `Group ${index}`,
      parentId: null,
      positionX: 0,
      positionY: 0,
    }))

    state.setCurrentProject({ ...baseProject, id: 'perf-large', name: 'Large Fixture' })
    state.beginIndexing()
    state.applySnapshot({ systems: [], files, infraNodes: [], dependencies: [], floorLayouts: [] })
    return { systems, files }
  })

  await expect(page.getByRole('status')).toContainText('Organizing 805 files')
  await expect(page.locator('.react-flow__node')).toHaveCount(0)

  await page.evaluate(({ systems, files }) => {
    const state = (window as any).__ambioGraphStore.getState()
    state.applyClassification({
      systems,
      files: files.map((file: any, index: number) => ({
        ...file,
        systemId: `perf-system-${index % systems.length}`,
      })),
      infraNodes: [],
      dependencies: [],
      floorLayouts: [],
    })
  }, fixture)

  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.locator('.react-flow__node[data-id="perf-system-0"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    return state.files.length
  })).toBe(805)
  await expect.poll(() => page.locator('.react-flow__node').count()).toBeLessThanOrEqual(24)
  await expect.poll(canvasZoom).toBeLessThanOrEqual(0.12)
})

test('keeps repeated hidden-node flows above every canvas node without clearing the scene', async () => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const baselineNodeCount = await page.locator('.react-flow__node').count()
  const visibleNodeCount = () => page.locator('.react-flow__node').evaluateAll(nodes =>
    nodes.filter(node => {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && Number(getComputedStyle(node).opacity) > 0.1
    }).length
  )
  const baselineVisibleNodeCount = await visibleNodeCount()

  // The demo graph deliberately leaves child positions at (0, 0) for the
  // layout engine. Give this same-system pair distinct authored geometry so
  // the regression exercises a real path as well as the inspection handoff.
  await page.evaluate(() => {
    const graphStore = (window as unknown as {
      __ambioGraphStore: {
        getState: () => {
          files: Array<Record<string, unknown>>
          applyDbPatch: (patch: unknown) => void
        }
      }
    }).__ambioGraphStore
    const state = graphStore.getState()
    for (const [id, positionX, positionY] of [
      ['file_systemnode', 48, 72],
      ['file_filenode', 344, 196],
    ] as const) {
      const file = state.files.find(candidate => candidate.id === id)
      if (!file) throw new Error(`missing E2E living geometry for ${id}`)
      state.applyDbPatch({
        type: 'file:updated',
        payload: {
          file: { ...file, positionX, positionY },
          change: 'updated',
          animate: false,
        },
      })
    }
  })

  const emitUpdate = async (traceId: string, lineCount: number) => {
    await page.evaluate(({ traceId, lineCount }) => {
      const graphStore = (window as unknown as {
        __ambioGraphStore: {
          getState: () => {
            files: Array<Record<string, unknown>>
            applyDbPatch: (patch: unknown) => void
          }
        }
      }).__ambioGraphStore
      const state = graphStore.getState()
      const file = state.files.find(candidate => candidate.id === 'file_systemnode')
      if (!file) throw new Error('missing E2E living target')
      state.applyDbPatch({
        type: 'file:updated',
        payload: {
          file: { ...file, lineCount },
          change: 'updated',
          animate: true,
          traceId,
        },
      })
      state.applyDbPatch({
        type: 'relationship:changed',
        payload: {
          src: 'file_filenode',
          dst: 'file_systemnode',
          originId: 'file_systemnode',
          relationship: 'CALLS',
          change: 'updated',
          callerSymbol: 'FileNode',
          calleeSymbol: 'SystemNode',
          animate: true,
          traceId,
        },
      })
    }, { traceId, lineCount })
  }

  const assertTopFlow = async (traceId: string) => {
    const overlay = page.locator('.ambio-living-flow-overlay')
    const flow = overlay.locator('.ambio-living-flow')
    await expect(flow).toHaveCount(1)
    await expect(flow).toHaveAttribute('data-living-flow-source', 'file_systemnode')
    await expect(flow).toHaveAttribute('data-living-flow-target', 'file_filenode')
    await expect(page.locator('.react-flow')).toBeVisible()
    // The edited file sits inside a collapsed system: the system names it on
    // its lower-right rail instead of popping the card out over its title.
    await expect(page.locator('.ambio-living-window-label[data-living-window-label="file_systemnode"]')).toContainText('EDITED')
    await expect(
      page.locator('.react-flow__node[data-id="file_systemnode"] .ambio-living-file-signal'),
    ).toHaveCount(0)
    await expect.poll(() => overlay.evaluate(element => getComputedStyle(element).zIndex))
      .toBe('2147483000')
    // The route is drawn faintly while the pulse travels it; it leaves with
    // the flow (the flow count returns to zero below), never as wiring.
    await expect(flow.locator('.ambio-living-flow__track')).toHaveCount(1)
    await expect.poll(() => flow.locator('.ambio-living-flow__pulse').evaluate(
      path => (path as SVGGeometryElement).getTotalLength(),
    )).toBeGreaterThan(0)
    const renderedBoundaryHit = await flow.locator('.ambio-living-flow__pulse').evaluate(path => {
      const geometry = path as SVGGeometryElement
      const endpoint = geometry.getPointAtLength(geometry.getTotalLength())
      const screenMatrix = geometry.getScreenCTM()
      if (!screenMatrix) throw new Error('living flow has no screen transform')
      const screenEndpoint = new DOMPoint(endpoint.x, endpoint.y).matrixTransform(screenMatrix)
      const target = document.querySelector<HTMLElement>(
        '.react-flow__node[data-id="file_filenode"]',
      )
      // A semantically hidden target is deliberately absent from the DOM. The
      // overlay still routes to its canonical geometry; unit geometry tests
      // cover that boundary exactly, while this E2E verifies the live route
      // remains painted and identifies the virtualized target.
      if (!target) return { virtualized: true, edgeDistance: null, projectsOntoBoundary: false }
      const rect = target.getBoundingClientRect()
      const edgeDistance = Math.min(
        Math.abs(screenEndpoint.x - rect.left),
        Math.abs(screenEndpoint.x - rect.right),
        Math.abs(screenEndpoint.y - rect.top),
        Math.abs(screenEndpoint.y - rect.bottom),
      )
      const projectsOntoBoundary =
        (screenEndpoint.x >= rect.left - 1 && screenEndpoint.x <= rect.right + 1) ||
        (screenEndpoint.y >= rect.top - 1 && screenEndpoint.y <= rect.bottom + 1)
      return { virtualized: false, edgeDistance, projectsOntoBoundary }
    })
    if (!renderedBoundaryHit.virtualized) {
      expect(renderedBoundaryHit.edgeDistance).toBeLessThanOrEqual(1)
      expect(renderedBoundaryHit.projectsOntoBoundary).toBe(true)
    }
    await expect.poll(() => flow.locator('.ambio-living-flow__pulse').evaluate(path =>
      getComputedStyle(path).animationTimingFunction
    )).toBe('linear')
    await expect.poll(() => page.evaluate(activeTraceId => {
      const diagnostics = (window as unknown as {
        __ambioLivingFlowLog?: Array<{
          traceId: string
          stage: string
          paintAttempt?: number
        }>
      }).__ambioLivingFlowLog ?? []
      const trace = diagnostics.filter(entry => entry.traceId === activeTraceId)
      return {
        scheduled: trace.filter(entry => entry.stage === 'renderer-scheduled').length,
        paintStarts: trace.filter(entry => entry.stage === 'paint-start').length,
        attempts: trace
          .filter(entry => entry.stage === 'paint-start')
          .map(entry => entry.paintAttempt),
      }
    }, traceId)).toEqual({
      scheduled: 1,
      paintStarts: 1,
      attempts: [1],
    })
    await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThanOrEqual(baselineNodeCount)
    await expect(page.getByText('This view hit an error and stopped drawing.')).toHaveCount(0)
    expect(pageErrors, `page errors after ${traceId}`).toEqual([])
  }

  await emitUpdate('E2E-LIVING-1', 156)
  await assertTopFlow('E2E-LIVING-1')
  const continuousInspectionLayer = page.locator('.ambio-living-inspection-layer').first()
  await expect(continuousInspectionLayer).toBeVisible()
  await continuousInspectionLayer.evaluate(element => {
    element.setAttribute('data-choreography-instance', 'origin-window')
  })
  await expect(
    page.locator('.ambio-living-window-label[data-living-window-label="file_filenode"]'),
  ).toContainText('IMPACT', { timeout: 2_500 })
  await expect(continuousInspectionLayer).toHaveAttribute(
    'data-choreography-instance',
    'origin-window',
  )
  await expect(page.locator('.ambio-living-window-label[data-living-window-label="file_systemnode"]')).toHaveCount(0)
  await expect(continuousInspectionLayer).toHaveAttribute(
    'data-choreography-instance',
    'origin-window',
  )
  await expect(page.locator('.ambio-living-flow')).toHaveCount(0, { timeout: 4_000 })
  await expect(page.locator('.react-flow')).toBeVisible()

  await emitUpdate('E2E-LIVING-2', 155)
  await assertTopFlow('E2E-LIVING-2')
  await expect(
    page.locator('.ambio-living-window-label[data-living-window-label="file_filenode"]'),
  ).toContainText('IMPACT', { timeout: 2_500 })
  await expect(page.locator('.ambio-living-flow')).toHaveCount(0, { timeout: 4_000 })
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect.poll(() => page.locator('.react-flow__node').count()).toBe(baselineNodeCount)

  // Simulate a delayed JavaScript expiry timer. CSS animations may finish
  // independently, but an active signal must never go blank or leave its
  // inspection system visually empty while state is still active.
  await expect(page.locator('.ambio-living-window-label')).toHaveCount(0, { timeout: 3_000 })
  await page.evaluate(() => {
    const graphStore = (window as unknown as {
      __ambioGraphStore: {
        setState: (state: unknown) => void
      }
    }).__ambioGraphStore
    graphStore.setState({
      nodeFx: {
        file_systemnode: {
          kind: 'edit',
          key: 99_001,
          traceId: 'E2E-DELAYED-EXPIRY',
        },
      },
    })
  })
  const delayedSignal = page.locator('.ambio-living-window-label[data-living-window-label="file_systemnode"]')
  await expect(delayedSignal).toContainText('EDITED')
  await page.waitForTimeout(1_700)
  await expect(delayedSignal).toBeVisible()
  await expect.poll(() => delayedSignal.evaluate(element =>
    Number(getComputedStyle(element.parentElement!).opacity) * Number(getComputedStyle(element).opacity)
  )).toBeGreaterThan(0.9)
  await expect.poll(visibleNodeCount).toBeGreaterThanOrEqual(baselineVisibleNodeCount)
  for (const layer of await page.locator('.ambio-living-inspection-layer').all()) {
    await expect.poll(() => layer.evaluate(element =>
      Number(getComputedStyle(element).opacity)
    )).toBeGreaterThan(0.9)
    await expect.poll(() => layer.locator('xpath=..').locator(
      '.ambio-system-node__shell',
    ).evaluate(element => getComputedStyle(element).filter)).toBe('none')
  }
  await page.evaluate(() => {
    const graphStore = (window as unknown as {
      __ambioGraphStore: {
        setState: (state: unknown) => void
      }
    }).__ambioGraphStore
    graphStore.setState({ nodeFx: {} })
  })
  await expect(delayedSignal).toHaveCount(0)
  await expect.poll(visibleNodeCount).toBe(baselineVisibleNodeCount)
  expect(pageErrors).toEqual([])
})

test('never commits an empty canvas frame during rapid save and resync bursts', async () => {
  const pageErrors: string[] = []
  const integrityErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('[scene-integrity]')) {
      integrityErrors.push(message.text())
    }
  })
  const baselineNodeCount = await page.locator('.react-flow__node').count()
  expect(baselineNodeCount).toBeGreaterThan(0)

  await page.evaluate(() => {
    const monitor = {
      active: true,
      frames: 0,
      blankFrames: 0,
      minimumVisibleNodeCount: Number.POSITIVE_INFINITY,
    }
    ;(window as any).__ambioSceneFrameMonitor = monitor
    const sample = () => {
      if (!monitor.active) return
      const graphStore = (window as any).__ambioGraphStore
      const state = graphStore.getState()
      const canonicalCount = state.systems.length + state.files.length + state.infraNodes.length
      if (canonicalCount > 0) {
        const visibleCount = [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
          .filter(node => {
            const style = getComputedStyle(node)
            return style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              Number(style.opacity) > 0.1
          })
          .length
        monitor.frames++
        monitor.minimumVisibleNodeCount = Math.min(
          monitor.minimumVisibleNodeCount,
          visibleCount,
        )
        if (visibleCount === 0) monitor.blankFrames++
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  for (let index = 0; index < 36; index++) {
    await page.evaluate((iteration) => {
      const graphStore = (window as any).__ambioGraphStore
      const state = graphStore.getState()
      const edited = state.files.find((file: any) => file.id === 'file_systemnode')
      const dependency = state.dependencies.find((item: any) =>
        item.src === 'file_canvas' && item.dst === 'file_systemnode')
      if (!edited || !dependency) throw new Error('missing rapid-save fixture data')

      if (iteration > 0 && iteration % 9 === 0) {
        state.applySnapshot({
          systems: state.systems,
          files: state.files,
          infraNodes: state.infraNodes,
          dependencies: state.dependencies,
          floorLayouts: state.floorLayouts,
        })
        return
      }
      if (iteration > 0 && iteration % 5 === 0) {
        state.applyClassification({
          systems: state.systems,
          files: state.files,
          infraNodes: state.infraNodes,
          dependencies: state.dependencies,
          floorLayouts: state.floorLayouts,
        })
        return
      }

      const traceId = `E2E-SAVE-STRESS-${iteration}`
      state.applyDbPatch({
        type: 'file:updated',
        payload: {
          file: { ...edited, lineCount: 155 + (iteration % 2) },
          change: 'updated',
          animate: true,
          traceId,
        },
      })
      state.applyDbPatch({
        type: 'relationship:changed',
        payload: {
          src: 'file_canvas',
          dst: 'file_systemnode',
          originId: 'file_systemnode',
          relationship: 'CALLS',
          change: 'updated',
          dependency: { ...dependency },
          callerSymbol: 'renderCanvas',
          calleeSymbol: 'SystemNode',
          animate: true,
          traceId,
        },
      })
    }, index)
    await page.waitForTimeout(18)
  }

  await page.waitForTimeout(1_800)
  const monitor = await page.evaluate(() => {
    const value = (window as any).__ambioSceneFrameMonitor
    value.active = false
    return value
  })
  expect(monitor.frames).toBeGreaterThan(20)
  expect(monitor.blankFrames).toBe(0)
  expect(monitor.minimumVisibleNodeCount).toBeGreaterThan(0)
  await expect(page.locator('.react-flow__node')).toHaveCount(baselineNodeCount)
  await expect(page.locator('.react-flow')).toBeVisible()

  // React Flow is an interaction renderer, not the owner of Ambio's semantic
  // nodes. Its default deletion shortcut must never erase the controlled Floor.
  await page.locator('.react-flow__node[data-id="sys_shared"]').click({ force: true })
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(baselineNodeCount)
  expect(integrityErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

test('presents project navigation as a desktop workbench launcher', async () => {
  const launcherUrl = new URL(page.url())
  launcherUrl.searchParams.set('home', '1')
  await page.goto(launcherUrl.toString())

  const launcher = page.locator('.ambio-launcher')
  const titlebar = page.locator('.ambio-launcher__titlebar')
  const body = page.locator('.ambio-launcher__body')
  const openCodebase = page.getByRole('button', { name: 'Open Codebase' })

  await expect(launcher).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ambio', level: 1 })).toBeVisible()
  // The page is the same with projects to open as without: the introduction
  // stays beside the project list.
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible()
  await expect(openCodebase).toBeVisible()
  await expect(page.getByText('Draw it, and your agent builds it')).toBeVisible()
  await expect(page.getByText('Agents show you the plan first')).toBeVisible()
  await expect(page.getByText('Review changes on the map')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open logs' })).toHaveCount(0)
  await expect(page.locator('button button')).toHaveCount(0)

  const [titlebarBox, bodyBox] = await Promise.all([titlebar.boundingBox(), body.boundingBox()])
  expect(titlebarBox?.height).toBeCloseTo(44, 0)
  expect(bodyBox?.width).toBeGreaterThan(900)
  expect(bodyBox?.height).toBeGreaterThan(700)
  const launcherType = await page.evaluate(() => ({
    workspaceHeading: parseFloat(getComputedStyle(document.querySelector('.ambio-launcher__workspace-heading h2')!).fontSize),
    actionLabel: parseFloat(getComputedStyle(document.querySelector('.ambio-launcher__fork-copy strong')!).fontSize),
    actionHeight: document.querySelector('.ambio-launcher__fork')!.getBoundingClientRect().height,
  }))
  expect(launcherType.workspaceHeading).toBeGreaterThanOrEqual(26)
  expect(launcherType.actionLabel).toBeGreaterThanOrEqual(16)
  expect(launcherType.actionHeight).toBeGreaterThanOrEqual(78)
  await expect.poll(() => openCodebase.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      display: style.display,
      background: style.backgroundImage,
      border: style.borderStyle,
    }
  })).toEqual({
    display: 'grid',
    background: expect.stringContaining('linear-gradient'),
    border: 'solid',
  })
})

test('navigates recent projects via search and keyboard flow', async () => {
  const launcherUrl = new URL(page.url())
  launcherUrl.searchParams.set('home', '1')
  await page.goto(launcherUrl.toString())

  const searchBox = page.locator('.ambio-launcher__search-box input')
  await expect(page.locator('.ambio-launcher__recent-item').first()).toBeVisible()

  // Pressing '/' brings up search (hidden while there are only a few
  // projects) and focuses it
  await page.keyboard.press('/')
  await expect(searchBox).toBeFocused()

  // Read first project name dynamically from the rendered list
  const firstProjectName = (await page.locator('.ambio-launcher__project-copy strong').first().textContent())?.trim() ?? 'shopfront'

  // Typing filters recent projects
  await searchBox.fill(firstProjectName)
  await expect(page.locator('.ambio-launcher__recent-item')).toHaveCount(1)
  await expect(page.locator('.ambio-launcher__project-copy strong')).toHaveText(firstProjectName)

  // ArrowDown navigates and highlights active item
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.ambio-launcher__recent-item--active')).toHaveCount(1)

  // Escape clears search query and restores list
  await page.keyboard.press('Escape')
  await expect(searchBox).toHaveValue('')
  const totalCount = await page.locator('.ambio-launcher__recent-item').count()
  expect(totalCount).toBeGreaterThanOrEqual(1)

  // A highlighted recent project must not steal Enter from a focused action.
  await page.keyboard.press('ArrowDown')
  await page.locator('.ambio-launcher__fork--new').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Create a model from scratch' })).toBeVisible()
})

test('chooses project sources in a folder-first file browser', async () => {
  const setupUrl = new URL(page.url())
  setupUrl.searchParams.set('setup', '1')
  await page.goto(setupUrl.toString())

  await expect(page.getByRole('heading', { name: 'Set up your project' })).toBeVisible()
  await expect(page.getByText(/Ambio reads what is checked below/)).toBeVisible()
  const sourceTree = page.getByRole('tree', { name: 'Project files and folders' })
  await expect(sourceTree).toBeVisible()
  // What Ambio cannot read is one line until asked for, not a row per file.
  await expect(sourceTree.getByText('package.json', { exact: true })).toHaveCount(0)
  await sourceTree.getByRole('button', { name: /skipped automatically/ }).first().click()
  await expect(sourceTree.getByText('package.json', { exact: true })).toBeVisible()

  const startIndexing = page.getByRole('button', { name: /Index this project/ })
  await expect(startIndexing).toBeEnabled()
  const projectName = page.getByRole('textbox', { name: 'Project name' })
  await expect(projectName).toHaveValue('Ambio Canvas Fixture')
  await projectName.fill('   ')
  await expect(startIndexing).toBeDisabled()
  await projectName.fill('  My architecture  ')
  await expect(startIndexing).toBeEnabled()

  const rootKinds = await sourceTree.locator(':scope > .ambio-setup-tree__branch').evaluateAll(branches =>
    branches.map(branch => branch.getAttribute('data-kind')),
  )
  const firstNonFolder = rootKinds.findIndex(kind => kind !== 'folder')
  expect(firstNonFolder).toBeGreaterThan(0)
  expect(rootKinds.slice(0, firstNonFolder).every(kind => kind === 'folder')).toBe(true)
  expect(rootKinds.slice(firstNonFolder).every(kind => kind !== 'folder')).toBe(true)

  // A file Ambio never reads has no checkbox to puzzle over.
  const packageRow = sourceTree.locator('.ambio-setup-tree__row').filter({ has: page.getByText('package.json', { exact: true }) })
  await expect(packageRow.locator('.ambio-setup-tree__detail')).toHaveText('Never read')
  await expect(page.getByLabel('Include package.json', { exact: true })).toHaveCount(0)

  const documentCheckbox = page.getByLabel('Include ARCHITECTURE.md', { exact: true })
  const documentRow = documentCheckbox.locator('xpath=ancestor::div[contains(@class, "ambio-setup-tree__row")]')
  await expect(documentRow.locator('.ambio-setup-tree__detail')).toHaveText('Document')
  await expect(documentCheckbox).toBeChecked()

  const sourceCheckbox = page.getByLabel('Include electron.vite.config.ts', { exact: true })
  const sourceRow = sourceCheckbox.locator('xpath=ancestor::div[contains(@class, "ambio-setup-tree__row")]')
  await expect(sourceRow.locator('.ambio-setup-tree__detail')).toHaveText('')
  await sourceCheckbox.click()
  await expect(sourceCheckbox).not.toBeChecked()
  await expect(sourceRow.locator('.ambio-setup-tree__detail')).toHaveText('Not read')

  const screenBox = await page.locator('.ambio-source-setup').boundingBox()
  expect(screenBox?.width).toBeGreaterThan(1200)
  expect(screenBox?.height).toBeGreaterThan(780)
  const setupScale = await page.evaluate(() => ({
    bodyCopy: parseFloat(getComputedStyle(document.querySelector('.ambio-source-setup__description')!).fontSize),
    treeLabel: parseFloat(getComputedStyle(document.querySelector('.ambio-setup-tree__name')!).fontSize),
    rowHeight: document.querySelector('.ambio-setup-tree__row')!.getBoundingClientRect().height,
    checkboxSize: document.querySelector('.ambio-setup-tree__check')!.getBoundingClientRect().width,
    primaryHeight: document.querySelector('.ambio-source-setup__submit')!.getBoundingClientRect().height,
  }))
  expect(setupScale.bodyCopy).toBeGreaterThanOrEqual(14)
  expect(setupScale.treeLabel).toBeGreaterThanOrEqual(15)
  expect(setupScale.rowHeight).toBeGreaterThanOrEqual(52)
  expect(setupScale.checkboxSize).toBeGreaterThanOrEqual(18)
  expect(setupScale.primaryHeight).toBeGreaterThanOrEqual(58)
  await expect(page.locator('button button')).toHaveCount(0)

  const rootPath = await page.locator('.ambio-source-setup__path').textContent()
  await startIndexing.click()
  await expect.poll(() => page.evaluate(async () => {
    const projects = await window.ambio.listRecentProjects()
    return projects.find(project => project.id === 'demo')?.name
  })).toBe('My architecture')
  // Opening the folder again must keep its display name and directory.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path!] })
  }, rootPath)
  const reopened = await page.evaluate(() => window.ambio.openProjectDialog())
  expect(reopened).toMatchObject({ id: 'demo', name: 'My architecture', rootPath })
})

test('keeps documentation in its library and off the architecture canvas', async () => {
  await page.evaluate(() => {
    const graphStore = (window as any).__ambioGraphStore
    const state = graphStore.getState()
    const template = state.files[0]
    graphStore.getState().applySnapshot({
      workspaceId: state.currentProject.id,
      systems: state.systems,
      files: [
        ...state.files,
        {
          ...template,
          id: 'file_docs',
          path: '/ambio-e2e/docs/ARCHITECTURE.md',
          relPath: 'docs/ARCHITECTURE.md',
          language: 'markdown',
          systemId: null,
          lineCount: 3,
        },
      ],
      infraNodes: state.infraNodes,
      dependencies: state.dependencies,
      floorLayouts: state.floorLayouts,
    })
  })

  await expect(page.locator('.react-flow__node[data-id="file_docs"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Project documents' }).click()
  const documents = page.getByRole('region', { name: 'Documents' })
  await expect(documents).toBeVisible()

  // The reader opens on its list rather than on whatever sorts first; a
  // document is shown because it was chosen.
  await documents.getByRole('button', { name: /ARCHITECTURE\.md/ }).click()

  // Markdown is rendered, not printed: the heading is a heading, and the prose
  // is prose.
  await expect(documents.getByRole('heading', { name: 'Architecture' })).toBeVisible()
  await expect(documents.getByText('The renderer consumes indexed source only.')).toBeVisible()
})

test('uses two-step agent setup for blank projects without changing codebase setup', async () => {
  let agentConnected = true
  let agentVerified = false
  await page.route(/\/api\/agent\/presence\?/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      connected: agentConnected,
      connections: agentConnected
        ? [{ connectionId: 'connection-e2e', hostId: 'codex', lastSeenAt: Date.now(), lastToolAt: agentVerified ? Date.now() : 0 }]
        : [],
    }),
  }))
  const connectUrl = new URL(page.url())
  connectUrl.searchParams.set('connect', '1')
  connectUrl.searchParams.set('blank', '1')
  await page.goto(connectUrl.toString())

  const card = page.locator('.ambio-connect__card')
  await expect(card).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Bring an agent into Ambio' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Choose your agent' })).toBeVisible()
  const steps = page.getByRole('tablist', { name: 'Agent setup steps' }).getByRole('tab')
  await expect(steps).toHaveCount(2)
  await expect(steps.nth(0)).toHaveAttribute('aria-selected', 'true')

  // Three connection types share one selection; details open over the mascot.
  const agents = page.getByRole('radiogroup', { name: 'Agents' })
  await expect(agents.getByRole('heading')).toHaveText(['Ambio chat', 'Ambio runs it', 'In another app'])
  await expect(agents.getByRole('radio', { name: /Ambio chat/ })).toBeVisible()
  const showNotFound = agents.getByRole('button', { name: /not found on this computer/ })
  if (await showNotFound.count()) await showNotFound.click()
  await expect(agents.getByRole('radio', { checked: true })).toHaveCount(1)
  await expect(page.locator('.ambio-choose__sidebar')).toHaveCount(0)
  await agents.getByRole('radio', { checked: true }).click()
  await expect(page.locator('.ambio-choose__footer .ambio-connect__primary, .ambio-choose__footer .ambio-connect__secondary')).toHaveCount(1)
  const mascot = page.locator('.ambio-connect__mascot .ambio-final-gemini')
  await expect(mascot).toHaveAttribute('data-state', 'connected')

  const readStableFrame = () => page.evaluate(() => {
    const screen = document.querySelector('.ambio-connect')!
    const card = document.querySelector('.ambio-connect__card')!.getBoundingClientRect()
    const stage = document.querySelector('.ambio-connect__workspace')!.getBoundingClientRect()
    return {
      cardWidth: Math.round(card.width),
      cardHeight: Math.round(card.height),
      stageHeight: Math.round(stage.height),
      hasPageScrollbar: screen.scrollHeight > screen.clientHeight,
    }
  })
  const firstFrame = await readStableFrame()
  expect(firstFrame.hasPageScrollbar).toBe(false)

  await steps.getByText('Connect').click()
  await expect(page.getByRole('heading', { name: /Connect/ })).toBeVisible()
  expect(await readStableFrame()).toEqual(firstFrame)
  await expect(page.getByText('Waiting for the agent to verify Ambio tools')).toBeVisible()
  const openCanvas = page.getByRole('button', { name: /Open canvas/ })
  await expect(openCanvas).toBeDisabled()
  await page.getByRole('button', { name: 'Copy check' }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('verifyOnly true')
  const checkPrompt = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(checkPrompt).toContain('verifyOnly true')
  expect(checkPrompt).toContain('expectedWorkspaceId "demo"')
  agentVerified = true
  await expect(page.getByText('Inbox access verified')).toBeVisible({ timeout: 5_000 })
  await expect(openCanvas).toBeEnabled()
  await openCanvas.click()
  await expect(page.locator('button button')).toHaveCount(0)

  const cardBox = await card.boundingBox()
  expect(cardBox?.width).toBeGreaterThan(900)
  expect(cardBox?.height).toBeLessThanOrEqual(820)

  agentConnected = false
  await expect(mascot).toHaveAttribute('data-state', 'sleeping', { timeout: 5_000 })
  await expect(openCanvas).toBeDisabled()

  agentConnected = true
  const codebaseUrl = new URL(page.url())
  codebaseUrl.searchParams.delete('blank')
  await page.goto(codebaseUrl.toString())
  const codebaseSteps = page.getByRole('tablist', { name: 'Agent setup steps' }).getByRole('tab')
  await expect(codebaseSteps).toHaveCount(3)
  await expect(codebaseSteps.getByText('Map project')).toBeVisible()
  await expect(codebaseSteps.getByText('Review')).toBeVisible()
})

test('reviews the proposed system hierarchy in the unified workbench workflow', async () => {
  const indexedSnapshot = await page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    return {
      workspaceId: state.currentProject.id,
      systems: state.systems,
      files: state.files,
      infraNodes: state.infraNodes,
      dependencies: state.dependencies,
      floorLayouts: state.floorLayouts,
    }
  })
  const proposalBody = {
    id: 'proposal-e2e',
    workspaceId: 'demo',
    currentRevision: 1,
    createdAt: Date.now(),
    round: {
      rationale: 'Group the rendering pipeline by responsibility.',
      evidenceSummary: 'Entry points, imports, and shared state agree on these boundaries.',
      systems: [
        {
          systemKey: 'canvas', name: 'Living Canvas', description: 'Owns the interactive architecture Floor.',
          parentRefType: 'scope', parentRefId: null, depth: 0, decision: 'pending',
          fileCount: 2, affectedFileCount: 2,
        },
        {
          systemKey: 'zoom', name: 'Semantic Zoom', description: 'Controls progressive detail and visibility.',
          parentRefType: 'proposed_system', parentRefId: 'canvas', depth: 1, decision: 'pending',
          fileCount: 1, affectedFileCount: 1,
        },
      ],
      memberships: [
        {
          id: 'member-a', fileId: 'file_canvas', rootId: 'root_demo', filePath: 'src/renderer/canvas/AmbioCanvas.tsx',
          targetSystemKey: 'canvas', disposition: 'assign', rationale: '',
        },
        {
          id: 'member-b', fileId: 'file_layerzoom', rootId: 'root_demo', filePath: 'src/renderer/canvas/hooks/useLayerZoom.ts',
          targetSystemKey: 'zoom', disposition: 'assign', rationale: '',
        },
      ],
      layouts: [],
    },
  }
  await page.route('http://127.0.0.1:7743/api/architecture-proposals?workspace=demo', route =>
    route.fulfill({ json: [{ id: 'proposal-e2e' }] }),
  )
  await page.route(/http:\/\/127\.0\.0\.1:7743\/api\/architecture-proposals\/proposal-e2e\?workspace=demo/, route =>
    route.fulfill({ json: proposalBody }),
  )
  let proposalLayoutSaves = 0
  let proposalFinalizations = 0
  const proposalLayoutWriteKeys: string[][] = []
  let deferNextLayoutResponse = false
  let releaseDeferredLayoutResponse: (() => void) | null = null
  await page.route('http://127.0.0.1:7743/api/architecture-proposals/proposal-e2e/layouts', async route => {
    const request = route.request()
    const payload = request.postDataJSON() as { layouts: typeof proposalBody.round.layouts }
    proposalLayoutSaves += 1
    proposalLayoutWriteKeys.push((payload.layouts as Array<{ nodeType: string; nodeKey: string }>)
      .map(layout => `${layout.nodeType}:${layout.nodeKey}`))
    proposalBody.round.layouts = [
      ...proposalBody.round.layouts.filter(previous => !payload.layouts.some(layout =>
        layout.nodeType === previous.nodeType && layout.nodeKey === previous.nodeKey)),
      ...payload.layouts,
    ]
    if (deferNextLayoutResponse) {
      deferNextLayoutResponse = false
      await new Promise<void>(resolve => { releaseDeferredLayoutResponse = resolve })
      releaseDeferredLayoutResponse = null
    }
    await route.fulfill({ json: proposalBody })
  })
  await page.route('http://127.0.0.1:7743/api/architecture-proposals/proposal-e2e/finalize', async route => {
    proposalFinalizations += 1
    const request = route.request().postDataJSON() as {
      workspaceId: string
      revision: number
      decidedBy: string
      establishDeltaBaseline: boolean
    }
    expect(request).toEqual({
      workspaceId: 'demo',
      revision: 1,
      decidedBy: 'user',
      establishDeltaBaseline: true,
    })
    const materialized = new Map([
      ['canvas', 'committed-canvas'],
      ['zoom', 'committed-zoom'],
    ])
    proposalBody.round.systems = proposalBody.round.systems.map(system => ({
      ...system,
      decision: 'approved',
      materializedSystemId: materialized.get(system.systemKey),
    }))
    const systemTemplate = indexedSnapshot.systems[0]
    const committedSystems = proposalBody.round.systems.map(system => ({
      ...systemTemplate,
      id: materialized.get(system.systemKey)!,
      workspaceId: 'demo',
      name: system.name,
      description: system.description,
      source: 'agent',
      parentId: system.parentRefType === 'proposed_system'
        ? materialized.get(system.parentRefId ?? '') ?? null
        : null,
      depth: system.depth,
    }))
    const fileAssignments = new Map([
      ['file_canvas', 'committed-canvas'],
      ['file_layerzoom', 'committed-zoom'],
    ])
    const nodeId = (layout: { nodeType: string; nodeKey: string }) => layout.nodeType === 'system'
      ? materialized.get(layout.nodeKey)!
      : layout.nodeKey === 'member-a' ? 'file_canvas' : 'file_layerzoom'
    const reviewedLayouts = proposalBody.round.layouts as Array<{
      nodeType: 'system' | 'file'
      nodeKey: string
      parentRefType: 'scope' | 'live_system' | 'proposed_system'
      parentRefId: string
      positionX: number
      positionY: number
      width: number
      height: number
      scale: number
      interiorScale: number
    }>
    const committedLayouts = reviewedLayouts.map(layout => {
      const parentNodeId = layout.parentRefType === 'proposed_system'
        ? materialized.get(layout.parentRefId) ?? null
        : null
      return {
        workspaceId: 'demo',
        nodeId: nodeId(layout),
        nodeType: layout.nodeType,
        parentNodeId,
        parentNodeType: parentNodeId ? 'system' : null,
        containmentKind: parentNodeId ? 'part_of' : 'root',
        positionX: layout.positionX,
        positionY: layout.positionY,
        width: layout.width,
        height: layout.height,
        scale: layout.scale,
        interiorScale: layout.interiorScale,
        updatedAt: Date.now(),
      }
    })
    await route.fulfill({ json: {
      proposal: proposalBody,
      deltaBaselineAt: Date.now(),
      snapshot: {
        ...indexedSnapshot,
        systems: committedSystems,
        files: indexedSnapshot.files.map(file => ({
          ...file,
          systemId: fileAssignments.get(file.id) ?? null,
        })),
        floorLayouts: committedLayouts,
      },
    } })
  })
  const reviewUrl = new URL(page.url())
  reviewUrl.searchParams.set('review', '1')
  await page.goto(reviewUrl.toString())

  await expect(page.getByRole('heading', { name: 'Review the architecture your agent found' })).toBeVisible()
  await expect(page.getByText('STEP 04 / REVIEW THE MAP')).toBeVisible()
  const proposalPanel = page.getByRole('complementary', { name: 'Proposed architecture' })
  await expect(proposalPanel).toBeVisible()
  await expect(proposalPanel.getByText('Living Canvas', { exact: true })).toBeVisible()
  await expect(proposalPanel.getByText('Semantic Zoom', { exact: true })).toBeVisible()
  // Review uses the Floor's semantic zoom: the overview shows the proposed
  // system closed with its name, and its files stay unmounted until zoomed in.
  await expect(page.locator('.ambio-review__canvas .react-flow__node-system').filter({ hasText: 'Living Canvas' })).toBeVisible()
  await expect(page.locator('.ambio-review__canvas').getByText('AmbioCanvas.tsx', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Done Reviewing' })).toBeVisible()
  await expect(page.locator('.ambio-review__canvas .react-flow')).toBeVisible()
  await expect(page.locator('.ambio-review__canvas .react-flow__background')).toHaveCount(1)
  await expect(page.locator('.ambio-review__canvas .ambio-canvas-review')).toHaveCount(1)
  // Nothing floats over the review canvas; the minimap owns that corner.
  await expect(page.getByText('PROPOSED SYSTEM FLOOR')).toHaveCount(0)
  // A review starts by freezing the same complete generated frame that the
  // live Floor freezes. No gesture may be the first sparse layout write.
  await expect.poll(() => proposalLayoutSaves).toBe(1)
  await expect(page.locator('.ambio-review__canvas .ambio-canvas-review-ready')).toHaveCount(1)
  await expect(page.locator('.ambio-review__canvas .react-flow__handle')).toHaveCount(0)
  expect(new Set(proposalLayoutWriteKeys[0]))
    .toEqual(new Set(['system:canvas', 'system:zoom', 'file:member-a', 'file:member-b']))

  const panelBox = await page.locator('.ambio-review__panel').boundingBox()
  const canvasBox = await page.locator('.ambio-review__canvas').boundingBox()
  expect(panelBox?.width).toBeGreaterThanOrEqual(560)
  expect(canvasBox?.width).toBeGreaterThan(760)
  const reviewScale = await page.evaluate(() => ({
    heading: parseFloat(getComputedStyle(document.querySelector('.ambio-review__heading h1')!).fontSize),
    purpose: parseFloat(getComputedStyle(document.querySelector('.ambio-proposal__purpose')!).fontSize),
    systemName: parseFloat(getComputedStyle(document.querySelector('.ambio-proposal__name')!).fontSize),
    decisionHeight: document.querySelector('.ambio-proposal__approve')!.getBoundingClientRect().height,
  }))
  // The heading is brief so the tree gets the room; every row carries its
  // own approve and send-back controls.
  expect(reviewScale.heading).toBeGreaterThanOrEqual(20)
  expect(reviewScale.purpose).toBeGreaterThanOrEqual(14)
  expect(reviewScale.systemName).toBeGreaterThanOrEqual(15)
  expect(reviewScale.decisionHeight).toBeGreaterThanOrEqual(28)
  await expect(proposalPanel.getByRole('button', { name: 'Approve Semantic Zoom' })).toBeVisible()
  await expect(proposalPanel.getByRole('button', { name: 'Send back Semantic Zoom' })).toBeVisible()
  await expect(proposalPanel.getByText('3 files in branch', { exact: true })).toBeVisible()

  await proposalPanel.getByRole('button', { name: 'Collapse Living Canvas' }).click()
  await expect(proposalPanel.getByText('Semantic Zoom', { exact: true })).toHaveCount(0)
  await proposalPanel.getByRole('button', { name: 'Expand Living Canvas' }).click()
  await expect(proposalPanel.getByText('Semantic Zoom', { exact: true })).toBeVisible()

  // A row in the list opens its nested system and flies to it, as search does.
  await proposalPanel.getByText('Semantic Zoom', { exact: true }).click()
  await expect(page.locator('.ambio-review__canvas').getByText('AmbioCanvas.tsx', { exact: true }).first()).toBeVisible()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  // A candidate card has its own node id but shows the indexed file's symbols.
  await expect(page.locator('.ambio-review__canvas .react-flow__node[data-id="proposal-file:proposal-e2e:member-a"]')
    .getByText('renderCanvas')).toBeVisible()

  await page.locator('.ambio-review__canvas .react-flow__node-system')
    .filter({ hasText: 'Semantic Zoom' }).click({ position: { x: 10, y: 10 } })
  await expect(proposalPanel.locator('.ambio-proposal__item').filter({ hasText: 'Semantic Zoom' }))
    .toHaveAttribute('data-active', 'true')
  // Search's framing leaves Semantic Zoom closed: its one file stays unmounted.
  await expect(page.locator('.ambio-review__canvas .react-flow__node')).toHaveCount(3)
  await expect(page.locator('.ambio-review__canvas .react-flow__node[data-id="proposal-file:proposal-e2e:member-b"]')).toHaveCount(0)

  // Review uses AmbioCanvas itself. Persisting a node drag must update only the
  // proposal geometry; it must not refit the camera or relayout its siblings.
  const draggedNode = page.locator('.ambio-review__canvas .react-flow__node[data-id="proposal-file:proposal-e2e:member-a"]')
  const nestedSystem = page.locator('.ambio-review__canvas .react-flow__node[data-id="proposal:proposal-e2e:zoom"]')
  const viewport = page.locator('.ambio-review__canvas .react-flow__viewport')
  const stableNodes = page.locator(
    '.ambio-review__canvas .react-flow__node:not([data-id="proposal-file:proposal-e2e:member-a"])',
  )
  const [dragBox, nestedLocalBefore, stableGeometryBefore, cameraBefore] = await Promise.all([
    draggedNode.boundingBox(),
    nestedSystem.evaluate(element => (element as HTMLElement).style.transform),
    stableNodes.evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute('data-id'),
      transform: (element as HTMLElement).style.transform,
      width: (element as HTMLElement).style.width,
      height: (element as HTMLElement).style.height,
    }))),
    viewport.getAttribute('style'),
  ])
  expect(dragBox).not.toBeNull()
  const pointerStart = await draggedNode.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const id = element.getAttribute('data-id')
    for (let y = rect.top + 4; y < rect.bottom - 4; y += 6) {
      for (let x = rect.left + 4; x < rect.right - 4; x += 6) {
        const target = document.elementFromPoint(x, y) as HTMLElement | null
        if (target?.closest('.react-flow__node')?.getAttribute('data-id') === id &&
            !target.closest('.nodrag')) {
          return { x, y }
        }
      }
    }
    return null
  })
  expect(pointerStart).not.toBeNull()
  await draggedNode.evaluate(element => {
    const state = window as typeof window & {
      __ambioReviewDragTransforms?: string[]
      __ambioReviewDragObserver?: MutationObserver
    }
    state.__ambioReviewDragTransforms = [(element as HTMLElement).style.transform]
    state.__ambioReviewDragObserver?.disconnect()
    state.__ambioReviewDragObserver = new MutationObserver(() => {
      state.__ambioReviewDragTransforms!.push((element as HTMLElement).style.transform)
    })
    state.__ambioReviewDragObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })
  await page.mouse.move(pointerStart!.x, pointerStart!.y)
  await page.mouse.down()
  await page.mouse.move(pointerStart!.x + 42, pointerStart!.y + 28, { steps: 12 })
  const [dragSamples, liveDragBox] = await Promise.all([
    draggedNode.evaluate(() => {
      const state = window as typeof window & {
        __ambioReviewDragTransforms?: string[]
        __ambioReviewDragObserver?: MutationObserver
      }
      state.__ambioReviewDragObserver?.disconnect()
      return (state.__ambioReviewDragTransforms ?? []).flatMap(transform => {
        const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
        return match ? [{ x: Number(match[1]), y: Number(match[2]) }] : []
      })
    }),
    draggedNode.boundingBox(),
  ])
  await expect(viewport).toHaveAttribute('style', cameraBefore ?? '')
  expect(liveDragBox).not.toBeNull()
  expect(dragSamples.length).toBeGreaterThan(2)
  for (let index = 1; index < dragSamples.length; index++) {
    // A controlled scene rebuild used to restore the persisted position on
    // alternating frames. A deliberate right/down drag may never move back.
    expect(dragSamples[index].x).toBeGreaterThanOrEqual(dragSamples[index - 1].x - 0.5)
    expect(dragSamples[index].y).toBeGreaterThanOrEqual(dragSamples[index - 1].y - 0.5)
  }
  expect(liveDragBox!.x).toBeGreaterThan(dragBox!.x + 25)
  expect(liveDragBox!.y).toBeGreaterThan(dragBox!.y + 15)
  deferNextLayoutResponse = true
  await page.mouse.up()
  await expect.poll(() => proposalLayoutSaves).toBe(2)
  await expect.poll(() => releaseDeferredLayoutResponse !== null).toBe(true)
  await expect.poll(() => viewport.getAttribute('style')).toBe(cameraBefore)
  await expect.poll(() => nestedSystem.evaluate(element => (element as HTMLElement).style.transform))
    .toBe(nestedLocalBefore)
  await expect.poll(() => stableNodes.evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute('data-id'),
    transform: (element as HTMLElement).style.transform,
    width: (element as HTMLElement).style.width,
    height: (element as HTMLElement).style.height,
  })))).toEqual(stableGeometryBefore)

  // A held resize is also a controlled React Flow interaction. The fixed
  // opposite edge may not oscillate while proposal state is being previewed.
  const resizedSystem = page.locator(
    '.ambio-review__canvas .react-flow__node[data-id="proposal:proposal-e2e:canvas"]',
  )
  await resizedSystem.click({ position: { x: 18, y: 18 }, force: true })
  await expect(resizedSystem).toHaveClass(/selected/)
  const rightResizeHandle = resizedSystem.locator('[data-resize-direction="right"]')
  await expect(rightResizeHandle).toBeVisible()
  const [systemBoxBefore, resizeHandleBox] = await Promise.all([
    resizedSystem.boundingBox(),
    rightResizeHandle.boundingBox(),
  ])
  expect(systemBoxBefore).not.toBeNull()
  expect(resizeHandleBox).not.toBeNull()
  await resizedSystem.evaluate(element => {
    const state = window as typeof window & {
      __ambioReviewResizeFrames?: Array<{
        left: number
        right: number
        width: number
        bodyRight: number
        outlineRight: number
      }>
      __ambioReviewResizeObserver?: MutationObserver
    }
    const sample = () => {
      const rect = element.getBoundingClientRect()
      const body = element.querySelector<SVGElement>('.ambio-system-node__shell > svg')?.getBoundingClientRect()
      const outline = element.querySelector<HTMLElement>('.ambio-node-resizer')?.getBoundingClientRect()
      state.__ambioReviewResizeFrames!.push({
        left: rect.left,
        right: rect.right,
        width: rect.width,
        bodyRight: body?.right ?? Number.NaN,
        outlineRight: outline?.right ?? Number.NaN,
      })
    }
    state.__ambioReviewResizeFrames = []
    sample()
    state.__ambioReviewResizeObserver?.disconnect()
    state.__ambioReviewResizeObserver = new MutationObserver(sample)
    state.__ambioReviewResizeObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })
  await page.mouse.move(
    resizeHandleBox!.x + resizeHandleBox!.width / 2,
    resizeHandleBox!.y + resizeHandleBox!.height / 2,
  )
  await page.mouse.down()
  for (let step = 1; step <= 16; step++) {
    await page.mouse.move(
      resizeHandleBox!.x + resizeHandleBox!.width / 2 + step * 3,
      resizeHandleBox!.y + resizeHandleBox!.height / 2,
    )
    await page.waitForTimeout(18)
    if (step === 8) {
      releaseDeferredLayoutResponse?.()
      await page.waitForTimeout(80)
    }
  }
  const resizeFrames = await resizedSystem.evaluate(() => {
    const state = window as typeof window & {
      __ambioReviewResizeFrames?: Array<{
        left: number
        right: number
        width: number
        bodyRight: number
        outlineRight: number
      }>
      __ambioReviewResizeObserver?: MutationObserver
    }
    state.__ambioReviewResizeObserver?.disconnect()
    return state.__ambioReviewResizeFrames ?? []
  })
  expect(resizeFrames.length).toBeGreaterThan(2)
  for (let index = 1; index < resizeFrames.length; index++) {
    expect(resizeFrames[index].left).toBeCloseTo(resizeFrames[0].left, 0)
    expect(resizeFrames[index].width).toBeGreaterThanOrEqual(resizeFrames[index - 1].width - 0.5)
    expect(resizeFrames[index].right).toBeGreaterThanOrEqual(resizeFrames[index - 1].right - 0.5)
    expect(resizeFrames[index].outlineRight).toBeCloseTo(resizeFrames[index].right, 0)
    expect(resizeFrames[index].bodyRight).toBeCloseTo(resizeFrames[index].right, 0)
  }
  expect(resizeFrames.at(-1)!.width).toBeGreaterThan(resizeFrames[0].width + 30)
  await page.mouse.up()
  await expect.poll(() => proposalLayoutSaves).toBe(3)
  await expect.poll(() => viewport.getAttribute('style')).toBe(cameraBefore)

  const leftResizeHandle = resizedSystem.locator('[data-resize-direction="left"]')
  const [systemBoxBeforeLeftResize, leftResizeHandleBox] = await Promise.all([
    resizedSystem.boundingBox(),
    leftResizeHandle.boundingBox(),
  ])
  expect(systemBoxBeforeLeftResize).not.toBeNull()
  expect(leftResizeHandleBox).not.toBeNull()
  await resizedSystem.evaluate(element => {
    const state = window as typeof window & {
      __ambioReviewResizeFrames?: Array<{
        left: number
        right: number
        width: number
        bodyRight: number
        outlineRight: number
      }>
      __ambioReviewResizeObserver?: MutationObserver
    }
    const sample = () => {
      const rect = element.getBoundingClientRect()
      const body = element.querySelector<SVGElement>('.ambio-system-node__shell > svg')?.getBoundingClientRect()
      const outline = element.querySelector<HTMLElement>('.ambio-node-resizer')?.getBoundingClientRect()
      state.__ambioReviewResizeFrames!.push({
        left: rect.left,
        right: rect.right,
        width: rect.width,
        bodyRight: body?.right ?? Number.NaN,
        outlineRight: outline?.right ?? Number.NaN,
      })
    }
    state.__ambioReviewResizeFrames = []
    sample()
    state.__ambioReviewResizeObserver?.disconnect()
    state.__ambioReviewResizeObserver = new MutationObserver(sample)
    state.__ambioReviewResizeObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })
  await page.mouse.move(
    leftResizeHandleBox!.x + leftResizeHandleBox!.width / 2,
    leftResizeHandleBox!.y + leftResizeHandleBox!.height / 2,
  )
  await page.mouse.down()
  // Vary pointer velocity within one monotonic gesture. The review used to
  // look nearly correct at a slow pace while its secondary geometry stream
  // became visibly farther behind during these faster samples.
  const westResizeOffsets = [2, 4, 6, 10, 18, 30, 33, 36, 39, 42, 45, 48]
  for (const offset of westResizeOffsets) {
    await page.mouse.move(
      leftResizeHandleBox!.x + leftResizeHandleBox!.width / 2 - offset,
      leftResizeHandleBox!.y + leftResizeHandleBox!.height / 2,
    )
    await page.waitForTimeout(8)
  }
  const westResizeFrames = await resizedSystem.evaluate(() => {
    const state = window as typeof window & {
      __ambioReviewResizeFrames?: Array<{
        left: number
        right: number
        width: number
        bodyRight: number
        outlineRight: number
      }>
      __ambioReviewResizeObserver?: MutationObserver
    }
    state.__ambioReviewResizeObserver?.disconnect()
    return state.__ambioReviewResizeFrames ?? []
  })
  expect(westResizeFrames.length).toBeGreaterThan(2)
  for (let index = 1; index < westResizeFrames.length; index++) {
    expect(westResizeFrames[index].right).toBeCloseTo(westResizeFrames[0].right, 0)
    expect(westResizeFrames[index].width).toBeGreaterThanOrEqual(westResizeFrames[index - 1].width - 0.5)
    expect(westResizeFrames[index].left).toBeLessThanOrEqual(westResizeFrames[index - 1].left + 0.5)
    // Interaction chrome is written straight onto the node frame, so it has to
    // match exactly - it never trailed even once across 18 instrumented runs.
    expect(westResizeFrames[index].outlineRight).toBeCloseTo(westResizeFrames[index].right, 0)
    // The body is allowed to sit at most ONE pointer sample behind on an
    // isolated frame: React can land the node's props and the wrapper's style
    // in separate frames under load, which shows up as a single 3px blip.
    // The regression this guards is different in kind - a gap that grew with
    // pointer speed and persisted, so a west resize visibly dragged the edge
    // it was supposed to pin. Bounding the lag by the current pointer step
    // still catches that; demanding pixel equality every frame only added
    // flake.
    const westStep = westResizeFrames[index].width - westResizeFrames[index - 1].width
    const westBodyLag = Math.abs(westResizeFrames[index].bodyRight - westResizeFrames[index].right)
    expect(westBodyLag).toBeLessThanOrEqual(westStep + 0.5)
  }
  expect(westResizeFrames.at(-1)!.width).toBeGreaterThan(westResizeFrames[0].width + 30)
  // ...and catches up exactly once the pointer stops. A lag that persists or
  // accumulates never closes; a slow frame on a loaded machine does.
  await expect.poll(() => resizedSystem.evaluate(element => {
    const right = element.getBoundingClientRect().right
    const body = element.querySelector<SVGElement>('.ambio-system-node__shell > svg')?.getBoundingClientRect()
    return Math.abs((body?.right ?? Number.NaN) - right)
  }), { timeout: 1000 }).toBeLessThan(0.5)
  await page.mouse.up()
  await expect.poll(() => proposalLayoutSaves).toBe(4)
  await expect.poll(() => viewport.getAttribute('style')).toBe(cameraBefore)

  // Selecting a proposal file keeps that exact canvas node selected even
  // though the review panel follows the containing semantic branch.
  await draggedNode.click({ position: { x: 12, y: 12 }, force: true })
  await expect(draggedNode).toHaveClass(/selected/)
  await expect(resizedSystem).not.toHaveClass(/selected/)
  await expect(draggedNode.locator('[data-resize-direction="right"]')).toBeVisible()

  await nestedSystem.click({ position: { x: 12, y: 12 }, force: true })
  await expect(nestedSystem).toHaveClass(/selected/)
  const nestedWestHandle = nestedSystem.locator('[data-resize-direction="left"]')
  const nestedHandleBox = await nestedWestHandle.boundingBox()
  expect(nestedHandleBox).not.toBeNull()
  await nestedSystem.evaluate(element => {
    const state = window as typeof window & {
      __ambioReviewResizeFrames?: Array<{ left: number; right: number; width: number }>
      __ambioReviewResizeObserver?: MutationObserver
    }
    const sample = () => {
      const rect = element.getBoundingClientRect()
      state.__ambioReviewResizeFrames!.push({ left: rect.left, right: rect.right, width: rect.width })
    }
    state.__ambioReviewResizeFrames = []
    sample()
    state.__ambioReviewResizeObserver?.disconnect()
    state.__ambioReviewResizeObserver = new MutationObserver(sample)
    state.__ambioReviewResizeObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })
  const nestedHandleCenter = {
    x: nestedHandleBox!.x + nestedHandleBox!.width / 2,
    y: nestedHandleBox!.y + nestedHandleBox!.height / 2,
  }
  await page.mouse.move(nestedHandleCenter.x, nestedHandleCenter.y)
  await page.mouse.down()
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(nestedHandleCenter.x - step * 2, nestedHandleCenter.y)
    await page.waitForTimeout(18)
  }
  const nestedWestFrames = await nestedSystem.evaluate(() => {
    const state = window as typeof window & {
      __ambioReviewResizeFrames?: Array<{ left: number; right: number; width: number }>
      __ambioReviewResizeObserver?: MutationObserver
    }
    state.__ambioReviewResizeObserver?.disconnect()
    return state.__ambioReviewResizeFrames ?? []
  })
  expect(nestedWestFrames.length).toBeGreaterThan(2)
  for (let index = 1; index < nestedWestFrames.length; index++) {
    expect(nestedWestFrames[index].right).toBeCloseTo(nestedWestFrames[0].right, 0)
    expect(nestedWestFrames[index].width).toBeGreaterThanOrEqual(nestedWestFrames[index - 1].width - 0.5)
    expect(nestedWestFrames[index].left).toBeLessThanOrEqual(nestedWestFrames[index - 1].left + 0.5)
  }
  await page.mouse.up()
  await expect.poll(() => proposalLayoutSaves).toBe(5)
  await expect(page.locator('.ambio-review__canvas .react-flow__handle')).toHaveCount(0)

  const beforePan = await viewport.getAttribute('style')
  await page.keyboard.down('d')
  await page.waitForTimeout(80)
  await page.keyboard.up('d')
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan)
  await expect(page.locator('button button')).toHaveCount(0)

  // Review completion is the canonical commit, not a local navigation flag.
  // The exact daemon snapshot returned by finalization must be installed before
  // the live Floor mounts, including semantic nesting, memberships, and layout.
  await page.getByRole('button', { name: 'Done Reviewing' }).click()
  await expect.poll(() => proposalFinalizations).toBe(1)
  await expect(page.locator('.ambio-toolbar')).toBeVisible()
  const committed = await page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    return {
      systems: state.systems.map((system: any) => ({ id: system.id, name: system.name, parentId: system.parentId })),
      memberships: state.files
        .filter((file: any) => file.id === 'file_canvas' || file.id === 'file_layerzoom')
        .map((file: any) => ({ id: file.id, systemId: file.systemId })),
      layoutNodeIds: state.floorLayouts.map((layout: any) => layout.nodeId),
    }
  })
  expect(committed.systems).toEqual([
    { id: 'committed-canvas', name: 'Living Canvas', parentId: null },
    { id: 'committed-zoom', name: 'Semantic Zoom', parentId: 'committed-canvas' },
  ])
  expect(committed.memberships).toEqual([
    { id: 'file_canvas', systemId: 'committed-canvas' },
    { id: 'file_layerzoom', systemId: 'committed-zoom' },
  ])
  expect(committed.layoutNodeIds).toEqual(expect.arrayContaining([
    'committed-canvas',
    'committed-zoom',
    'file_canvas',
    'file_layerzoom',
  ]))
})

test('preserves tokenized app chrome geometry and toolbar interaction states', async () => {
  const toolbar = page.locator('.ambio-toolbar')
  const rail = page.locator('.ambio-sheet-rail')
  const [toolbarBox, railBox] = await Promise.all([toolbar.boundingBox(), rail.boundingBox()])

  expect(toolbarBox?.height).toBeCloseTo(82, 0)
  expect(railBox?.width).toBeCloseTo(176, 0)
  // Quiet project chrome (decision 2026-10-20): no footer with daemon health,
  // graph counts or index state.
  await expect(page.locator('.ambio-status-bar')).toHaveCount(0)

  const lasso = page.getByRole('button', { name: 'Lasso Select' })
  await lasso.hover()
  await expect.poll(() => lasso.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })).toEqual({ background: 'rgb(238, 242, 236)', color: 'rgb(31, 57, 51)' })

  await lasso.click()
  const active = page.getByRole('button', { name: 'Lasso Active' })
  await expect.poll(() => active.evaluate(element => {
    const style = getComputedStyle(element)
    return { border: style.borderColor, color: style.color }
  })).toEqual({ border: 'rgb(52, 106, 98)', color: 'rgb(36, 93, 85)' })
})

test('searches the project index and navigates to a keyboard-selected file', async () => {
  await page.getByRole('button', { name: 'Search' }).click()

  const searchDialog = page.getByRole('dialog', { name: 'Search the map' })
  const searchInput = searchDialog.getByRole('textbox', { name: 'Search the map' })
  const searchWindow = searchDialog
  await expect(searchDialog).toBeVisible()
  await expect(searchInput).toBeFocused()
  await expect(searchDialog).toContainText('Search the project index')

  await expect.poll(() => searchWindow.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    width: '620px',
  })
  await expect.poll(() => searchInput.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })).toEqual({ background: 'rgb(255, 254, 248)', color: 'rgb(24, 37, 31)' })

  await searchInput.fill('not-a-real-indexed-path')
  await expect(searchDialog).toContainText('No matches')

  await searchInput.fill('src/renderer')
  const results = searchDialog.getByRole('option')
  await expect(results).not.toHaveCount(0)
  await expect(results.first()).toHaveAttribute('aria-selected', 'true')
  await expect(results.first().locator('mark').first()).toHaveText('src/renderer')

  await searchInput.press('ArrowDown')
  await expect(results.nth(1)).toHaveAttribute('aria-selected', 'true')
  const resultId = await results.nth(1).getAttribute('id')
  expect(resultId).toBeTruthy()
  const fileId = resultId!.replace('ambio-search-result-', '')
  await searchInput.press('Enter')

  await expect(searchDialog).toHaveCount(0)
  const selectedNode = page.locator(`.react-flow__node[data-id="${fileId}"]`)
  await expect(selectedNode).toBeVisible()
  await expect(selectedNode).toHaveClass(/selected/)

  await page.keyboard.press('ControlOrMeta+K')
  await expect(page.getByRole('dialog', { name: 'Search the map' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Search the map' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search the map' })).toHaveCount(0)
})

test('⌘K finds systems, infrastructure and symbols, and a symbol opens its source', async () => {
  await page.route(/\/api\/symbols\/search\?/, route => route.fulfill({ json: { symbols: [{
    id: 'symbol_render_canvas', fileId: 'file_canvas', name: 'renderCanvas', kind: 'function',
    lineStart: 3, lineEnd: 6, relPath: 'src/renderer/canvas/AmbioCanvas.tsx',
  }] } }))
  await page.keyboard.press('ControlOrMeta+K')
  const searchDialog = page.getByRole('dialog', { name: 'Search the map' })
  const searchInput = searchDialog.getByRole('textbox', { name: 'Search the map' })
  await searchInput.fill('mcp')
  const results = searchDialog.getByRole('option')
  await expect(results.first()).toContainText('MCP Server')
  await expect(searchDialog).toContainText('Infrastructure')
  await expect(searchDialog.getByRole('option', { name: /MCP Protocol/ })).toBeVisible()
  await searchInput.press('Enter')
  await expect(searchDialog).toHaveCount(0)
  await expect(page.locator('.react-flow__node[data-id="sys_mcp"]')).toHaveClass(/selected/)

  await page.keyboard.press('ControlOrMeta+K')
  await searchInput.fill('renderCanv')
  const symbol = searchDialog.getByRole('option', { name: /renderCanvas/ })
  await expect(symbol).toContainText('function')
  await symbol.click()
  const source = page.getByRole('dialog', { name: /^renderCanvas in / })
  await expect(source).toBeVisible()
  await expect(source).toContainText('export function renderCanvas()')
  await expect(page.locator('.react-flow__node[data-id="file_canvas"]')).toBeAttached()
  await source.getByRole('button', { name: 'Close source preview' }).click()
  await expect(source).toHaveCount(0)
})

test('opens saved investigations and controls replay through the workbench transport', async () => {
  const openInvestigations = async () => {
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Tools', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Saved Investigations…', exact: true }).click()
  }
  await openInvestigations()

  const menu = page.getByRole('dialog', { name: 'Saved investigations' })
  const capture = menu.getByRole('button', { name: /^Checkout timeout/ })
  await expect(menu).toBeVisible()
  await expect(capture).toBeVisible()
  await expect(capture).toContainText('2 events')
  await expect(capture).toContainText('fix/checkout@9fc31ab')

  const toolbarBox = await page.locator('.ambio-toolbar').boundingBox()
  const menuBox = await menu.boundingBox()
  expect(menuBox?.y).toBeGreaterThan(toolbarBox!.height - 12)
  // Sized to its one capture: the whole row shows, with no dead space under it.
  const captureBox = await capture.boundingBox()
  expect(captureBox!.y + captureBox!.height).toBeLessThanOrEqual(menuBox!.y + menuBox!.height)
  expect(menuBox!.y + menuBox!.height - (captureBox!.y + captureBox!.height)).toBeLessThan(4)
  await expect.poll(() => menu.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    width: '380px',
  })
  await expect(menu.getByRole('button', { name: 'Delete Checkout timeout' })).toBeAttached()

  await capture.click()
  await expect(menu).toHaveCount(0)

  const replay = page.getByRole('region', { name: 'Investigation replay: Checkout timeout' })
  const timeline = replay.getByRole('slider', { name: 'Investigation timeline' })
  await expect(replay).toBeVisible()
  await expect(replay).toContainText('fix/checkout@9fc31ab4')
  await expect(replay).toContainText('0/2')
  await expect(replay).toContainText('Press Play to watch it unfold')
  await expect(timeline).toHaveValue('-1')
  await expect.poll(() => replay.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    width: '680px',
  })

  await replay.getByRole('button', { name: 'Step' }).click()
  await expect(replay).toContainText('1/2')
  await expect(replay).toContainText('Checkout stalls after authorization')
  await expect(timeline).toHaveValue('0')

  await replay.getByRole('button', { name: 'Restart' }).click()
  await expect(replay).toContainText('0/2')
  await expect(timeline).toHaveValue('-1')

  const play = replay.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await expect(replay.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await replay.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(replay.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await replay.getByRole('button', { name: 'Exit replay' }).click()
  await expect(replay).toHaveCount(0)

  // The toolbar button opens the same popover, hanging from the button.
  const toolbarButton = page.locator('.ambio-toolbar').getByRole('button', { name: 'Investigations', exact: true })
  await toolbarButton.click()
  await expect(page.getByRole('dialog', { name: 'Saved investigations' })).toBeVisible()
  await expect(toolbarButton).toHaveAttribute('aria-expanded', 'true')
  const buttonBox = await toolbarButton.boundingBox()
  const anchoredBox = await page.getByRole('dialog', { name: 'Saved investigations' }).boundingBox()
  expect(Math.abs(anchoredBox!.x - buttonBox!.x)).toBeLessThan(2)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Saved investigations' })).toHaveCount(0)
})

test('keeps canvas utility chrome screen-sized, legible, and interactive', async () => {
  const minimap = page.locator('.ambio-canvas-minimap')
  const infraTab = page.getByRole('button', { name: 'Open infrastructure' })
  const viewport = page.locator('.react-flow__viewport')
  const zoomOf = () => viewport.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)

  // Fit, zoom and tidy moved to the View menu and the keyboard; the canvas
  // keeps only what you act on (docs/INFRA.md, "Canvas chrome").
  await expect(page.locator('.react-flow__controls')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Tidy Layout' })).toHaveCount(0)
  await expect(minimap).toBeVisible()
  await expect(infraTab).toBeVisible()

  const minimapBox = await minimap.boundingBox()
  expect(minimapBox?.width).toBeCloseTo(160, 0)
  expect(minimapBox?.height).toBeCloseTo(100, 0)
  await expect.poll(() => minimap.evaluate(element => getComputedStyle(element).backgroundColor))
    .toBe('rgb(203, 201, 191)')

  await page.locator('.react-flow__pane').click({ position: { x: 400, y: 300 } })
  const initialZoom = await zoomOf()
  await page.keyboard.press('ControlOrMeta+=')
  await expect.poll(zoomOf).toBeGreaterThan(initialZoom)
  await page.keyboard.press('ControlOrMeta+-')
  await page.keyboard.press('ControlOrMeta+-')
  await expect.poll(zoomOf).toBeLessThan(initialZoom)

  await page.keyboard.press('ControlOrMeta+Shift+L')
  await expect(page.locator('.layout-transition')).toHaveCount(0, { timeout: 5_000 })

  await infraTab.click()
  await expect(page.getByRole('complementary', { name: 'Infrastructure' })).toBeVisible()
  await page.getByRole('button', { name: 'Close infrastructure' }).click()
  await expect(infraTab).toBeVisible()
})

test('sheet rows expand independently, toggle extra layers and expose contextual actions', async () => {
  const draft = { id: 'sheet_second', workspaceId: 'demo', name: 'Offline Scene Replay with a readable two line title', purpose: '', kind: 'structure', folder: '', createdBy: 'user', revision: 1, createdAt: 1, updatedAt: 1 }
  let deleted = false
  await page.route(/\/api\/sheets\/sheet_second(?:\?|$)/, async route => {
    const method = route.request().method()
    if (method === 'PUT') {
      draft.name = route.request().postDataJSON().name; draft.revision++
      await route.fulfill({ json: draft }); return
    }
    if (method === 'DELETE') { deleted = true; await route.fulfill({ json: { ok: true } }); return }
    await route.fulfill({ json: { sheet: draft, planned: [], plannedEdges: [], elements: [], annotations: [], layouts: [], removals: [] } })
  })
  await page.evaluate(sheet => (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'sheet:upserted', payload: sheet }), draft)
  const rail = page.getByRole('complementary', { name: 'Drawings' })
  const runtime = rail.getByRole('button', { name: 'Runtime Draft', exact: true })
  const second = rail.getByRole('button', { name: draft.name, exact: true })
  await rail.getByRole('button', { name: `Expand ${draft.name}`, exact: true }).click()
  await expect(rail.getByRole('button', { name: /^The Floor/ })).toHaveAttribute('aria-current', 'page')
  await expect(rail.getByRole('group', { name: `Contents of ${draft.name}`, exact: true })).toBeVisible()
  await runtime.click()
  await second.click({ modifiers: ['ControlOrMeta'] })
  await expect(runtime).toHaveAttribute('aria-current', 'page')
  await expect(second.locator('..')).toHaveClass(/row--visible/)
  await second.click({ modifiers: ['ControlOrMeta'] })
  await expect(second.locator('..')).not.toHaveClass(/row--visible/)
  await second.click()
  await expect(second).toHaveAttribute('aria-current', 'page')
  await expect(runtime.locator('..')).not.toHaveClass(/row--visible/)
  await runtime.click({ modifiers: ['ControlOrMeta'] })
  await expect(runtime.locator('..')).toHaveClass(/row--visible/)
  await second.click({ modifiers: ['ControlOrMeta'] })
  await expect(runtime).toHaveAttribute('aria-current', 'page')
  // Context menus work by mouse and keyboard without activating the sheet.
  await second.click({ button: 'right' })
  let menu = page.getByRole('menu', { name: `Actions for ${draft.name}`, exact: true })
  await expect(menu.getByRole('menuitem', { name: 'Rename…' })).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: 'Delete sheet…' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await rail.getByRole('button', { name: `Actions for ${draft.name}`, exact: true }).focus()
  await page.keyboard.press('Shift+F10')
  await menu.getByRole('menuitem', { name: 'Rename…' }).click()
  await rail.getByRole('textbox', { name: 'Sheet name', exact: true }).fill('Offline Replay')
  await rail.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(rail.getByRole('button', { name: 'Offline Replay', exact: true })).toBeVisible()
  await expect(rail.getByRole('group', { name: 'Contents of Offline Replay', exact: true })).toBeVisible()
  await expect(runtime).toHaveAttribute('aria-current', 'page')
  await rail.getByRole('button', { name: 'Actions for Offline Replay', exact: true }).click()
  menu = page.getByRole('menu', { name: 'Actions for Offline Replay', exact: true })
  page.once('dialog', dialog => dialog.accept())
  await menu.getByRole('menuitem', { name: 'Delete sheet…' }).click()
  await expect.poll(() => deleted).toBe(true)
  await expect(rail.getByRole('button', { name: 'Offline Replay', exact: true })).toHaveCount(0)
  await expect(runtime).toHaveAttribute('aria-current', 'page')
})

test('preserves sheet rail hierarchy, layer visibility, and Floor navigation', async () => {
  const rail = page.getByRole('complementary', { name: 'Drawings' })
  const floor = rail.getByRole('button', { name: /The Floor/ })
  const runtime = rail.getByRole('button', { name: 'Runtime Draft', exact: true })
  const expand = rail.getByRole('button', { name: 'Expand Runtime Draft' })

  await expect(rail.getByText('Live model', { exact: true })).toBeVisible()
  await expect(rail.getByText('Overlay sheets', { exact: true })).toBeVisible()
  await expect(rail.getByText('STR', { exact: true })).toHaveCount(0)
  await expect(floor).toHaveAttribute('aria-current', 'page')
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  await expand.click()
  await expect(floor).toHaveAttribute('aria-current', 'page')
  await expect(rail.getByRole('group', { name: 'Contents of Runtime Draft' })).toBeVisible()

  await runtime.click()
  await expect(runtime).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => runtime.evaluate(element => parseFloat(getComputedStyle(element).paddingRight))).toBeLessThan(10)
  await expect(page.locator('.ambio-surface-readout')).toContainText('Runtime Draft')
  await expect(runtime.locator('..')).toHaveClass(/row--visible/)
  await expect(page.locator('.ambio-sheet-palette')).toBeVisible()
  await expect(page.locator('.ambio-sheet-palette__item')).toHaveCount(6)

  await floor.click()
  await expect(floor).toHaveAttribute('aria-current', 'page')
  await expect(runtime.locator('..')).not.toHaveClass(/row--visible/)
  await expect(page.locator('.ambio-sheet-palette')).toHaveCount(0)
  await expect.poll(() => runtime.evaluate(element => {
    const style = getComputedStyle(element)
    return { color: style.color, background: getComputedStyle(element.parentElement!).backgroundColor }
  })).toEqual({ color: 'rgb(38, 51, 47)', background: 'rgb(231, 229, 223)' })

  const addSheet = rail.getByRole('button', { name: 'Create new overlay sheet' })
  await addSheet.click()
  const nameInput = rail.getByRole('textbox', { name: 'New sheet name' })
  await expect(nameInput).toBeVisible()
  await expect(nameInput).toBeFocused()
  await expect(nameInput).toHaveValue('New Sheet')
  await expect.poll(() => nameInput.evaluate(input => ({
    start: (input as HTMLInputElement).selectionStart,
    end: (input as HTMLInputElement).selectionEnd,
  }))).toEqual({ start: 0, end: 'New Sheet'.length })
  await expect.poll(() => nameInput.evaluate(element => {
    const style = getComputedStyle(element)
    return { color: style.color, background: style.backgroundColor }
  })).toEqual({ color: 'rgb(23, 36, 31)', background: 'rgb(255, 254, 248)' })
  await expect(addSheet).toHaveAttribute('aria-expanded', 'true')
  await nameInput.press('Escape')
  await expect(nameInput).toHaveCount(0)
  await expect(addSheet).toBeEnabled()
  await expect(addSheet).toHaveAttribute('aria-expanded', 'false')
})

test('uses the shared workbench dialog system without dropping form behavior', async () => {
  // Files begin behind collapsed semantic-zoom containers. Navigate to their
  // shared system through the product search path, then create a deliberate
  // multi-file selection without depending on overview DOM materialization.
  const canvasFile = await revealFileNode('file_canvas')
  // Fit their common system so both files are actually in the camera. Fitting
  // each file in turn leaves the first one offscreen once navigation is correct.
  await page.keyboard.press('ControlOrMeta+K')
  await page.getByRole('textbox', { name: 'Search the map' }).fill('Canvas Renderer')
  await page.getByRole('option').first().click()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  const storeFile = page.locator('.react-flow__node[data-id="file_store"]')
  await expect(storeFile).toBeVisible()
  await canvasFile.click({ position: { x: 10, y: 10 } })
  // macOS routes Ctrl+click to the context menu, so the additive modifier has
  // to follow the host. The canvas accepts Meta, Control and Shift alike.
  const additiveModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  // Stay on the card background: its disabled language badge consumes clicks.
  await storeFile.click({ position: { x: 10, y: 10 }, modifiers: [additiveModifier] })

  const selectionActions = page.locator('.ambio-selection-actions')
  await expect(selectionActions).toBeVisible()
  await expect(selectionActions.locator('.ambio-selection-actions__summary')).toContainText(/\d+\s*items selected/i)
  await expect.poll(() => selectionActions.evaluate(element => {
    const style = getComputedStyle(element)
    return { border: style.borderColor, radius: style.borderRadius }
  })).toEqual({ border: 'rgb(98, 109, 104)', radius: '2px' })

  const newSheetButton = page.getByRole('button', { name: 'New Sheet', exact: true })
  await expect(newSheetButton).toBeVisible()
  await newSheetButton.click()
  const backdrop = page.locator('.ambio-dialog-backdrop')
  const surface = page.getByRole('dialog', { name: 'New Sheet' })
  await expect(surface).toBeVisible()
  await expect(surface.getByRole('heading', { name: 'New Sheet' })).toBeVisible()
  await expect(surface.getByRole('textbox', { name: 'Sheet name' })).toBeFocused()
  await expect(surface.getByRole('textbox', { name: /Purpose/ })).toBeVisible()
  await expect(surface).toContainText(/Starting the sheet with \d+ files/)

  const backdropColor = await backdrop.evaluate(element => getComputedStyle(element).backgroundColor)
  const surfaceBox = await surface.boundingBox()
  const surfaceStyle = await surface.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      padding: style.padding,
      borderRadius: style.borderRadius,
    }
  })
  const contentStyle = await surface.locator('.ambio-dialog-content').evaluate(element => {
    const style = getComputedStyle(element)
    return { color: style.color, padding: style.padding }
  })
  expect(backdropColor).toBe('rgba(18, 23, 21, 0.66)')
  expect(surfaceBox?.width).toBeCloseTo(420, 0)
  expect(surfaceStyle).toEqual({
    background: 'rgb(229, 227, 220)',
    padding: '0px',
    borderRadius: '2px',
  })
  expect(contentStyle).toEqual({ color: 'rgb(38, 51, 47)', padding: '18px' })

  await surface.getByRole('button', { name: 'Cancel' }).click()
  await expect(surface).toHaveCount(0)

  await selectionActions.getByRole('button', { name: 'Group into System' }).click()
  const systemDialog = page.getByRole('dialog', { name: 'New System' })
  await expect(systemDialog.getByRole('textbox', { name: 'System name' })).toBeFocused()
  await expect(systemDialog.getByRole('textbox', { name: /Description/ })).toBeVisible()
  await expect(systemDialog).toContainText(/Grouping \d+ selected files/)
  await systemDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(systemDialog).toHaveCount(0)

  await selectionActions.getByRole('button', { name: 'Message agent', exact: true }).click()
  const agentDialog = page.getByRole('complementary', { name: 'Agent inbox' })
  await expect(agentDialog.getByRole('textbox', { name: 'Instruction for your agent' })).toBeVisible()
  // Addressed inbox routing: a send creates a work order the user hands to a
  // chat of their choosing, instead of asking any agent to drain the queue.
  await expect(agentDialog).toContainText('Talk to your agent')
  await expect(agentDialog.getByRole('button', { name: 'Send to inbox' })).toBeDisabled()
  await page.screenshot({path:'test-results/inbox-empty.png'})
  await agentDialog.getByRole('button', { name: 'Close agent inbox' }).click()
  await expect(agentDialog).toHaveCount(0)
})

test('opens the categorized infrastructure browser from the infrastructure sidebar', async () => {
  await expect(page.getByRole('button', { name: 'Add infra' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open infrastructure' }).click()
  await page.getByRole('complementary', { name: 'Infrastructure' }).getByRole('button', { name: '+ Add' }).click()

  const picker = page.getByRole('dialog', { name: 'Choose infrastructure' })
  await expect(picker).toBeVisible()
  const catalogWindow = picker.locator('.ambio-infra-picker__window')
  const catalog = picker.locator('.ambio-infra-picker__catalog')
  const search = picker.getByRole('textbox', { name: 'Search infrastructure catalog' })
  await expect(search).toBeFocused()
  await expect(picker.getByRole('button', { name: 'Database', exact: true })).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Infrastructure type' })).toHaveAttribute('aria-pressed', 'true')
  await expect(picker.getByRole('button', { name: 'Provider' })).toBeVisible()

  await expect.poll(() => catalogWindow.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    width: '960px',
  })
  await expect.poll(() => catalog.evaluate(element => getComputedStyle(element).backgroundColor))
    .toBe('rgb(240, 238, 230)')
  await expect.poll(() => search.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })).toEqual({ background: 'rgb(255, 254, 248)', color: 'rgb(24, 37, 31)' })

  await search.fill('OpenAI')
  await expect(picker.getByRole('button', { name: /OpenAI API/ })).toBeVisible()
  await expect(picker.getByRole('button', { name: /Amazon RDS/ })).toHaveCount(0)
  await search.clear()

  await picker.getByRole('button', { name: 'Database', exact: true }).click()
  await expect(picker.getByRole('button', { name: /Amazon RDS/ })).toBeVisible()
  await expect(picker.getByRole('button', { name: /OpenAI API/ })).toHaveCount(0)

  await picker.getByRole('button', { name: 'Provider' }).click()
  await expect(picker.getByText('aws', { exact: true })).toBeVisible()
  const rdsService = picker.getByRole('button', { name: /Amazon RDS/ })
  await rdsService.click()
  await expect(rdsService).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => rdsService.evaluate(element => getComputedStyle(element).backgroundColor))
    .toBe('rgb(223, 234, 230)')
  await expect(picker.getByRole('textbox', { name: /Name/ })).toHaveAttribute('placeholder', /Primary Amazon RDS/)
  await expect(picker.getByRole('button', { name: 'Add to Canvas' })).toBeEnabled()

  await picker.getByRole('button', { name: 'Close infrastructure picker' }).click()
  await expect(picker).toHaveCount(0)
  await page.getByRole('button', { name: 'Close infrastructure' }).click()
  await expect(page.getByRole('complementary', { name: 'Infrastructure' })).toHaveCount(0)
})

test('double-clicking a file opens its code; its properties are on the right-click menu', async () => {
  const node = await revealFileNode('file_canvas')
  await node.dblclick({ position: { x: 12, y: 12 }, force: true })
  const editor = page.getByRole('dialog', { name: 'src/renderer/canvas/AmbioCanvas.tsx in src/renderer/canvas/AmbioCanvas.tsx' })
  await expect(editor.locator('.cm-content')).toContainText('export function renderCanvas()')
  // The file itself was opened: nothing is highlighted, and it starts at the top.
  await expect(editor.locator('.source-preview-location')).toHaveText('7 lines')
  await expect(editor.locator('.source-preview-line-highlighted')).toHaveCount(0)
  await expect(editor.locator('.source-preview-statusline')).toContainText('Ln 1, Col 1')
  await expect(page.getByRole('complementary', { name: 'File properties' })).toHaveCount(0)
  await expect(node).toHaveClass(/selected/)
  await editor.getByRole('button', { name: 'Close source preview' }).click()
  await expect(editor).toHaveCount(0)

  await node.click({ button: 'right', position: { x: 12, y: 12 }, force: true })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem').first()).toHaveText('Open Code in Ambio')
  await menu.getByRole('menuitem', { name: 'Properties' }).click()
  await expect(page.getByRole('complementary', { name: 'File properties' })).toBeVisible()
  await page.getByRole('complementary', { name: 'File properties' }).getByRole('button', { name: 'Close properties' }).click()

  await node.click({ button: 'right', position: { x: 12, y: 12 }, force: true })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Open Code in Ambio' }).click()
  await expect(editor.locator('.cm-content')).toContainText('export function renderCanvas()')

  // With the whole file open and nothing selected, Ask agent attaches the file itself, once,
  // even though it is also selected on the map.
  await editor.getByRole('button', { name: 'Ask agent' }).click()
  await expect(editor).toHaveCount(0)
  const attachments = page.locator('.ambio-inbox__attachments')
  await expect(attachments.getByRole('button', { name: 'src/renderer/canvas/AmbioCanvas.tsx', exact: true })).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: 'Instruction for your agent' })).toHaveValue('')
  await attachments.getByRole('button', { name: 'src/renderer/canvas/AmbioCanvas.tsx', exact: true }).click()
})

test('opens the workbench properties inspector without changing canvas selection behavior', async () => {
  const node = await revealFileNode('file_canvas')
  await node.click({ button: 'right', position: { x: 12, y: 12 }, force: true })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Properties' }).click()

  const inspector = page.getByRole('complementary', { name: 'File properties' })
  await expect(inspector).toBeVisible()
  await expect(inspector.getByRole('heading', { name: 'AmbioCanvas.tsx' })).toBeVisible()
  await expect(inspector.getByRole('heading', { name: 'General' })).toBeVisible()
  await expect(inspector).toContainText('Language')
  await expect(inspector).toContainText('420')
  await expect(node).toHaveClass(/selected/)

  await expect.poll(() => inspector.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      width: style.width,
      background: style.backgroundColor,
      color: style.color,
    }
  })).toEqual({
    width: '286px',
    background: 'rgb(229, 227, 220)',
    color: 'rgb(38, 51, 47)',
  })

  await inspector.getByRole('button', { name: 'Close properties' }).click()
  await expect(inspector).toHaveCount(0)
  await expect(node).toHaveClass(/selected/)
})

test('opens source symbols in the workbench code preview without losing syntax context', async () => {
  const node = await revealFileNode('file_canvas')
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 15; i += 1) {
    await page.mouse.wheel(0, -100)
  }

  const symbol = node.getByTitle('Open renderCanvas in source')
  await expect(symbol).toBeVisible()
  await symbol.click()

  const preview = page.getByRole('dialog', { name: /renderCanvas in src\/renderer\/canvas\/AmbioCanvas\.tsx/ })
  const code = preview.locator('.source-preview-code')
  await expect(preview).toBeVisible()
  await expect(preview.getByText('function renderCanvas · lines 3–6')).toBeVisible()
  await expect(preview.getByRole('button', { name: 'Close source preview' })).toBeFocused()
  await expect(code).toContainText('const ready = true')
  await expect(code.locator('.source-preview-line-highlighted')).toHaveCount(4)

  await expect.poll(() => preview.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      height: style.height,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    height: '820px',
    width: '1100px',
  })
  await expect.poll(() => code.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      border: style.borderColor,
      margin: style.margin,
    }
  })).toEqual({ border: 'rgb(77, 89, 85)', margin: '6px' })

  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(node).toBeVisible()
})

test('keeps resize chrome screen-sized and attached while resizing', async () => {
  const node = await revealFileNode('file_canvas')
  await node.click({ position: { x: 12, y: 12 }, force: true })
  await expect(node).toHaveClass(/selected/)

  const handles = await expectResizeChrome('file_canvas')

  const initialNode = await node.boundingBox()
  expect(initialNode).not.toBeNull()

  const right = page.locator('[data-resize-direction="right"]')
  const anchor = await right.boundingBox()
  expect(anchor).not.toBeNull()
  if (!anchor || !initialNode) return

  await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2)
  await page.mouse.down()
  await page.mouse.move(anchor.x + anchor.width / 2 + 36, anchor.y + anchor.height / 2, { steps: 12 })
  await page.mouse.up()

  const resizedNode = await node.boundingBox()
  expect(resizedNode).not.toBeNull()
  expect(resizedNode!.x).toBeCloseTo(initialNode.x, 0)
  expect(resizedNode!.y).toBeCloseTo(initialNode.y, 0)
  expect(resizedNode!.width).toBeGreaterThan(initialNode.width + 25)
  expect(resizedNode!.height).toBeCloseTo(initialNode.height, 0)
})

test('supports click, pane deselection, and partial lasso selection', async () => {
  const node = page.locator('.react-flow__node[data-id="sys_shared"]')
  await node.click()
  await expect(node).toHaveClass(/selected/)

  await page.locator('.react-flow__pane').click({ position: { x: 1000, y: 650 } })
  await expect(node).not.toHaveClass(/selected/)

  await page.getByRole('button', { name: 'Lasso Select' }).click()
  await expect(page.getByRole('button', { name: 'Lasso Active' })).toBeVisible()
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x - 8, box.y - 8)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(node).toHaveClass(/selected/)
})

test('drags a root node fluidly and keeps its persisted final frame', async () => {
  const node = page.locator('.react-flow__node[data-id="sys_shared"]')
  const before = await node.boundingBox()
  expect(before).not.toBeNull()
  if (!before) return

  const start = { x: before.x + before.width / 2, y: before.y + before.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 48, start.y + 32, { steps: 12 })
  await page.mouse.up()

  const after = await node.boundingBox()
  expect(after).not.toBeNull()
  expect(after!.x).toBeGreaterThan(before.x + 35)
  expect(after!.y).toBeGreaterThan(before.y + 20)
  await expect(node).toHaveClass(/selected/)
})

test('persists a container reparenting drop as one layout batch', async () => {
  let persistedParent: string | null | undefined
  let recordedNest: unknown
  page.on('request', request => {
    if (request.url().includes('/api/architecture/edits') && request.method() === 'POST') {
      recordedNest = (request.postDataJSON() as { edits?: unknown[] }).edits?.[0]
    }
    if (!request.url().includes('/api/layout/batch') || request.method() !== 'POST') return
    const payload = request.postDataJSON() as { layouts?: Array<{ nodeId: string; parentNodeId: string | null }> }
    const moved = payload.layouts?.find(layout => layout.nodeId === 'sys_shared')
    if (moved) persistedParent = moved.parentNodeId
  })

  const source = page.locator('.react-flow__node[data-id="sys_shared"]')
  const target = page.locator('.react-flow__node[data-id="sys_canvas"]')
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  if (!sourceBox || !targetBox) return

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    targetBox.x + targetBox.width - 20,
    targetBox.y + targetBox.height - 20,
    { steps: 16 },
  )
  await page.mouse.up()

  await expect.poll(() => persistedParent).toBe('sys_canvas')
  // On the Floor, placement is meaning: the nest is recorded as the user's
  // edit before the layout lands (docs/PRODUCT.md §2).
  expect(recordedNest).toEqual({ op: 'nest', systemId: 'sys_shared', parentId: 'sys_canvas' })
})

test('Floor edits to meaning are recorded: Delete ungroups a system, its title renames it', async () => {
  const sent: unknown[] = []
  page.on('request', request => {
    if (request.url().includes('/api/architecture/edits') && request.method() === 'POST') {
      sent.push(...((request.postDataJSON() as { edits?: unknown[] }).edits ?? []))
    }
  })
  const system = page.locator('.react-flow__node[data-id="sys_shared"]')
  await system.click()
  await expect(system).toHaveClass(/selected/)
  await page.keyboard.press('Delete')
  await expect.poll(() => sent).toContainEqual({ op: 'ungroup', systemId: 'sys_shared' })

  // Whichever title the current zoom shows (centred or tab) is the editable one.
  const title = page.locator('.react-flow__node[data-id="sys_canvas"] [data-node-editable="true"]:visible').first()
  await title.dblclick()
  const input = page.locator('.react-flow__node[data-id="sys_canvas"] input')
  await expect(input).toBeVisible()
  await input.fill('Rendering')
  await input.press('Enter')
  await expect.poll(() => sent).toContainEqual({ op: 'rename', systemId: 'sys_canvas', name: 'Rendering' })
})

test('a change that needs code opens a work order instead of happening on the Floor', async () => {
  let proposed: { nodeId?: string } | undefined
  page.on('request', request => {
    if (request.url().includes('/api/sheets/sheet_new/removals') && request.method() === 'POST') {
      proposed = request.postDataJSON() as { nodeId?: string }
    }
  })
  const file = await revealFileNode('file_canvas')
  await file.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete This File…' }).click()
  // The removal is drawn on a new sheet, which goes with the order.
  await expect.poll(() => proposed?.nodeId).toBe('file_canvas')
  const instruction = page.locator('textarea').first()
  await expect(instruction).toBeVisible()
  await expect(instruction).toHaveValue(/^Delete src\/renderer\/canvas\/AmbioCanvas\.tsx\./)
  await expect(page.getByLabel('Removed on this sheet')).toContainText('file_canvas')
})

test('drawing a dependency on the Floor starts a sheet proposing it, ready to send', async () => {
  let edge: { srcLive?: string; dstLive?: string; kind?: string } | undefined
  page.on('request', request => {
    if (request.url().includes('/api/sheets/sheet_new/planned-edges') && request.method() === 'POST') {
      edge = request.postDataJSON() as typeof edge
    }
  })
  const from = page.locator('.react-flow__node[data-id="sys_shared"] .react-flow__handle[data-handleid="source-right"]')
  const to = page.locator('.react-flow__node[data-id="sys_mcp"] .react-flow__handle[data-handleid="target-top"]')
  const start = await from.boundingBox()
  const end = await to.boundingBox()
  expect(start && end).toBeTruthy()
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2)
  await page.mouse.down()
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => edge).toMatchObject({ kind: 'DEPENDS_ON', srcLive: 'sys_shared', dstLive: 'sys_mcp' })
  await expect(page.locator('textarea').first()).toHaveValue(/^Make Shared Types use MCP Server/)
})

test('an agent-drawn sheet cannot go unnoticed, and a rejection can say why', async () => {
  const agentSheet = {
    id: 'sheet_agent', workspaceId: 'demo', name: 'Agent Plan', purpose: '', kind: 'structure',
    folder: '', createdBy: 'agent', revision: 1, createdAt: 9, updatedAt: 9,
  }
  const proposal = {
    id: 'plan_queue', sheetId: 'sheet_agent', workspaceId: 'demo', kind: 'system', name: 'Job Queue',
    declaredPath: '', members: '[]', metadata: '{}', status: 'planned', approvalStatus: 'pending',
    realizedFileId: null, notes: '', shape: '', color: '', positionX: 400, positionY: 300,
    width: 320, height: 200, scale: 1, parentSystemId: null, createdBy: 'agent',
  }
  let decided: { decision?: string } | undefined
  await page.route(/\/api\/sheets\/sheet_agent\?/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ sheet: agentSheet, elements: [], annotations: [], planned: [proposal], plannedEdges: [], layouts: [], removals: [] }),
  }))
  await page.route(/\/api\/sheets\/sheet_agent\/review$/, async route => {
    decided = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sheet: { ...agentSheet, revision: 2 }, planned: [{ ...proposal, approvalStatus: decided?.decision }], plannedEdges: [] }) })
  })
  await page.evaluate(sheet => {
    (window as unknown as { __ambioGraphStore: { getState: () => { applyDbPatch: (patch: unknown) => void } } })
      .__ambioGraphStore.getState().applyDbPatch({ type: 'sheet:upserted', payload: sheet })
  }, agentSheet)

  await expect(page.getByText('An agent drew a sheet: Agent Plan')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agent Plan', exact: true })).toBeVisible()
  await expect(page.locator('.ambio-sheet-rail__new')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open Sheet' }).click()
  const review = page.getByLabel('Agent proposals to review')
  await expect(review).toContainText('Job Queue')
  await expect(page.locator('.react-flow__node[data-id="planned:plan_queue"]')).toHaveAttribute('data-proposal', 'pending')
  await expect(page.locator('.ambio-sheet-rail__new')).toHaveCount(0)
  // Opening the sheet answers the invitation; it does not linger over the sheet.
  await expect(page.getByText('An agent drew a sheet: Agent Plan')).toHaveCount(0)
  // The stencils sit clear of the Infrastructure tab on the left edge.
  const palette = await page.locator('.ambio-sheet-palette').boundingBox()
  const infraTab = await page.locator('.ambio-infra-sidebar-tab').boundingBox()
  expect(palette && infraTab).toBeTruthy()
  expect(palette!.x >= infraTab!.x + infraTab!.width || palette!.y + palette!.height <= infraTab!.y).toBe(true)
  const checkPalette = async () => {
    const canvas = (await page.locator('[data-ambio-canvas]').first().boundingBox())!
    const stencil = (await page.locator('.ambio-sheet-palette').boundingBox())!
    const tab = (await page.locator('.ambio-infra-sidebar-tab').boundingBox())!
    expect(Math.abs((stencil.x - canvas.x) - (stencil.y - canvas.y))).toBeLessThan(1)
    expect(tab.y).toBeGreaterThanOrEqual(stencil.y + stencil.height)
    expect(tab.y + tab.height).toBeLessThanOrEqual(canvas.y + canvas.height)
  }
  await checkPalette()
  await page.setViewportSize({ width: 900, height: 600 })
  await expect.poll(async () => {
    const stencil = (await page.locator('.ambio-sheet-palette').boundingBox())!
    const tab = (await page.locator('.ambio-infra-sidebar-tab').boundingBox())!
    return tab.y >= stencil.y + stencil.height
  }).toBe(true)
  await checkPalette()
  await page.getByRole('button', { name: 'Open infrastructure', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Infrastructure', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close infrastructure', exact: true }).click()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.screenshot({ path: 'test-results/sheet-proposal-review.png' })
  // A proposal's name takes you to it on the sheet.
  await review.getByRole('button', { name: /Job Queue/ }).first().click()
  await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore.getState().selectedNodeId)).toBe('planned:plan_queue')
  await review.getByRole('button', { name: 'Request changes', exact: true }).click()
  await review.getByLabel('What should change?').fill('we already queue through SQS')
  await review.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => decided).toEqual({ workspaceId: 'demo', revision: 1, choices: [{ kind: 'addition', id: 'plan_queue' }], decision: 'rejected', reason: 'we already queue through SQS' })
  await expect(review).toHaveCount(0)
})

test('a nested proposal keeps compressed live context below its title and leaves the Floor intact', async () => {
  const sheet = { id: 'sheet_clearance', workspaceId: 'demo', name: 'Heuristics replay', kind: 'structure', purpose: '', folder: '', createdBy: 'agent', revision: 1, createdAt: 1, updatedAt: 1 }
  const original = await page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    const system = { ...state.systems[0], id: 'sys_heuristics', name: 'Reflex Collision Heuristics', parentId: null, width: 480, height: 360 }
    const neighbor = { ...system, id: 'sys_neighbor', name: 'Neighbor' }
    const distant = { ...system, id: 'sys_distant', name: 'Distant context' }
    const file = { ...state.files[0], id: 'file_heuristics', systemId: system.id, path: '/fixture/heuristics.py', relPath: 'heuristics.py', language: 'python', width: 220, height: 110 }
    const row = (nodeId: string, nodeType: string, parentNodeId: string | null, x: number, y: number, width: number, height: number) => ({ workspaceId: 'demo', nodeId, nodeType, parentNodeId, parentNodeType: parentNodeId ? 'system' : null, containmentKind: parentNodeId ? 'part_of' : 'root', positionX: x, positionY: y, width, height, scale: 1, interiorScale: 1, updatedAt: 0 })
    const snapshot = { systems: [system, neighbor, distant], files: [file], dependencies: [], infraNodes: [], floorLayouts: [row(system.id, 'system', null, 100, 100, 480, 360), row(neighbor.id, 'system', null, 676, 100, 480, 360), row(file.id, 'file', system.id, 12, 34.8, 220, 110), row(distant.id, 'system', null, 12000, 100, 480, 360)] }
    state.applySnapshot(snapshot)
    return snapshot
  })
  const planned = ['tool', 'cli', 'tests', 'fixtures'].map((id, index) => ({ id, sheetId: sheet.id, workspaceId: 'demo', name: index === 0 ? 'Offline Replay Tool' : `${id}.py`, kind: index === 0 ? 'system' : 'file', parentSystemId: index === 0 ? 'sys_heuristics' : 'planned:tool', declaredPath: index === 0 ? '' : `${id}.py`, members: '[]', metadata: '{}', notes: 'Reuse the evaluator offline.', status: 'planned', approvalStatus: 'pending', positionX: 0, positionY: 0, width: index === 0 ? null : 440, height: index === 0 ? null : 220, scale: 1, createdBy: 'agent' }))
  const plannedEdges = [['use_evaluator', 'cli', null, 'file_heuristics'], ['test_cli', 'tests', 'cli', null], ['test_evaluator', 'tests', null, 'file_heuristics'], ['test_fixtures', 'tests', 'fixtures', null]].map(([id, srcPlanned, dstPlanned, dstLive]) => ({ id, srcPlanned, dstPlanned, dstLive, sheetId: sheet.id, workspaceId: 'demo', kind: 'IMPORTS', approvalStatus: 'pending', createdBy: 'agent' }))
  await page.route(/\/api\/sheets\?/, route => route.fulfill({ json: [sheet] }))
  await page.route(/\/api\/sheets\/sheet_clearance\?/, route => route.fulfill({ json: { sheet, planned, plannedEdges, elements: [{ id: 'context_file', fileId: 'file_heuristics', parentSystemId: 'sys_heuristics', positionX: 0, positionY: 0, width: null, height: null }], layouts: [], annotations: [], removals: [] } }))
  await page.evaluate(sheet => (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'sheet:upserted', payload: sheet }), sheet)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    ;(window as any).__pauseSheetMotion = true
    const pause = (event: Event) => {
      const target = event.target as HTMLElement
      if (!(window as any).__pauseSheetMotion || !target.matches('.ambio-sheet-rail__review, .ambio-sheet-entry__contents')) return
      for (const animation of target.getAnimations()) animation.pause()
    }
    document.addEventListener('animationstart', pause)
    document.addEventListener('transitionrun', pause)
  })
  const sampleMotion = (locator: Locator) => locator.evaluate(async element => {
    const animations = element.getAnimations().filter(animation => Number(animation.effect?.getComputedTiming().endTime) > 0)
    if (!animations.length) return []
    for (const animation of animations) animation.pause()
    await Promise.all(animations.map(animation => animation.ready))
    const duration = Math.max(...animations.map(animation => Number(animation.effect!.getComputedTiming().endTime)))
    const samples = [0, .5, 1].map(progress => {
      for (const animation of animations) animation.currentTime = duration * progress
      const box = element.getBoundingClientRect()
      const clip = getComputedStyle(element).clipPath.match(/^inset\(([\d.]+)%/)
      return { height: box.height, visibleHeight: box.height * (1 - Number(clip?.[1] ?? 0) / 100), top: box.top }
    })
    for (const animation of animations) animation.finish()
    return samples
  })
  await page.getByRole('button', { name: 'Open Sheet', exact: true }).click()
  const review = page.locator('.ambio-sheet-rail__review')
  await expect.poll(() => review.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0)
  const reviewMotion = await sampleMotion(review)
  expect(reviewMotion).toHaveLength(3)
  expect(reviewMotion[0].visibleHeight).toBeLessThan(reviewMotion[1].visibleHeight)
  expect(reviewMotion[1].visibleHeight).toBeLessThanOrEqual(reviewMotion[2].visibleHeight)
  expect(reviewMotion[0].top).toBeGreaterThan(reviewMotion[2].top)
  await page.getByRole('button', { name: 'Expand Heuristics replay', exact: true }).click()
  const foldId = await page.getByRole('button', { name: 'Collapse Heuristics replay', exact: true }).getAttribute('aria-controls')
  const fold = page.locator(`[id="${foldId}"]`)
  await expect.poll(() => fold.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0)
  const expansion = await sampleMotion(fold)
  expect(expansion).toHaveLength(3)
  expect(expansion[0].height).toBeLessThan(expansion[1].height)
  expect(expansion[1].height).toBeLessThanOrEqual(expansion[2].height)
  await page.evaluate(() => { (window as any).__pauseSheetMotion = false })
  await page.getByRole('button', { name: 'Collapse Heuristics replay', exact: true }).click()
  expect(await fold.evaluate(element => {
    const button = element.querySelector('button')!
    button.focus()
    return (element as HTMLElement).inert && document.activeElement !== button
  })).toBe(true)
  // Reverse an in-flight close; it must settle at the same full height.
  await page.getByRole('button', { name: 'Expand Heuristics replay', exact: true }).click()
  await fold.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))) })
  expect((await fold.boundingBox())!.height).toBeCloseTo(expansion[2].height, 0)
  await expect(page.getByRole('button', { name: 'Show heuristics.py on sheet', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Collapse Offline Replay Tool', exact: true }).click()
  await page.screenshot({ path: 'test-results/sheet-connections-collapsed.png' })
  await page.getByRole('button', { name: 'Expand Offline Replay Tool', exact: true }).click()
  await page.getByRole('button', { name: 'Connections 4', exact: true }).click()
  await page.getByRole('button', { name: 'cli.py → heuristics.py', exact: true }).click()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  const parent = page.locator('.react-flow__node[data-id="sys_heuristics"]')
  const file = page.locator('.react-flow__node[data-id="file_heuristics"]')
  const checkClearance = async () => {
    const header = await parent.getByText('Reflex Collision Heuristics', { exact: true }).first().boundingBox()
    const child = await file.boundingBox()
    expect(header && child).toBeTruthy()
    expect(child!.y).toBeGreaterThan(header!.y + header!.height + 2)
    const bounds = (await parent.boundingBox())!
    expect(child!.x).toBeGreaterThan(bounds.x)
    expect(child!.x + child!.width).toBeLessThan(bounds.x + bounds.width)
    expect(child!.y + child!.height).toBeLessThan(bounds.y + bounds.height)
  }
  await checkClearance()
  await expect(page.locator('.ambio-system-description-trigger')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/compressed-sheet-clearance.png' })
  for (const key of ['-', '=', '=']) {
    const before = await page.locator('.react-flow__viewport').getAttribute('style')
    await page.keyboard.press(`ControlOrMeta+${key}`)
    await expect.poll(() => page.locator('.react-flow__viewport').getAttribute('style')).not.toBe(before)
    await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
    await checkClearance()
  }
  const links = [['use_evaluator', 'cli.py → heuristics.py'], ['test_cli', 'tests.py → cli.py'], ['test_evaluator', 'tests.py → heuristics.py'], ['test_fixtures', 'tests.py → fixtures.py']]
  const renderedInk = () => page.locator('.react-flow__edge[data-id="pedge:use_evaluator"] .react-flow__edge-path').evaluate(element => {
    const path = element as SVGPathElement, matrix = path.getScreenCTM()!
    const scale = Math.hypot(matrix.a, matrix.b)
    const screen = (value: string) => Number((parseFloat(value) * scale).toFixed(4))
    const style = getComputedStyle(path)
    const edge = path.closest('.react-flow__edge')!
    const halo = getComputedStyle(edge.querySelector('.ambio-sheet-relationship-halo')!)
    const arrow = getComputedStyle(edge.querySelector('.ambio-sheet-relationship-arrow')!)
    return { stroke: style.stroke, width: screen(style.strokeWidth),
      dashes: style.strokeDasharray.split(/[ ,]+/).map(screen),
      outline: halo.stroke, outlineWidth: screen(halo.strokeWidth),
      arrow: arrow.fill, arrowOutline: arrow.stroke }
  })
  let focusedInk: Awaited<ReturnType<typeof renderedInk>> | undefined
  for (const [id, label] of links) {
    await page.evaluate(() => (window as any).__ambioGraphStore.getState().setSelectedNode(null))
    await page.getByRole('button', { name: 'Fit view', exact: true }).click()
    await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
    // At overview zoom both nested files begin below the semantic threshold.
    await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(0\./)
    await page.getByRole('button', { name: label, exact: true }).click()
    const edge = page.locator(`.react-flow__edge[data-id="pedge:${id}"]`)
    await expect(edge.locator('.react-flow__edge-path')).toBeAttached()
    await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
    await expect(edge.locator('.ambio-sheet-relationship-halo')).toBeAttached()
    await expect(edge.locator('.ambio-sheet-relationship-arrow')).toBeAttached()
    const visiblePath = () => edge.locator('.react-flow__edge-path').evaluate(element => {
      const path = element as SVGPathElement, matrix = path.getScreenCTM()!
      const canvas = document.querySelector('[data-ambio-canvas]')!.getBoundingClientRect()
      const palette = document.querySelector('.ambio-sheet-palette')!.getBoundingClientRect()
      const style = getComputedStyle(path)
      if (Number(style.opacity) === 0 || style.stroke === 'none' || path.getTotalLength() <= 0) return false
      for (let sample = 0; sample <= 100; sample++) {
        const p = path.getPointAtLength(path.getTotalLength() * sample / 100)
        const screen = new DOMPoint(p.x, p.y).matrixTransform(matrix)
        if (screen.x <= palette.right || screen.x >= canvas.right || screen.y <= canvas.top || screen.y >= canvas.bottom) return false
      }
      return true
    })
    // The relationship's deferred focus can start after the previous Fit has
    // settled. Wait for the visible route itself, not that earlier camera state.
    await expect.poll(visiblePath, { message: `${label}: the entire selected route is visible` }).toBe(true)
    if (id === 'use_evaluator') {
      focusedInk = await renderedInk()
      await page.screenshot({ path: 'test-results/focused-replay-connection.png' })
    }
  }
  await page.getByRole('button', { name: 'Show All Sheet Relationships', exact: true }).click()
  await page.keyboard.press('ControlOrMeta+K')
  await page.getByRole('textbox', { name: 'Search the map' }).fill('Reflex Collision Heuristics')
  await page.getByRole('option').first().click()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  const closeProperties = page.getByRole('button', { name: 'Close properties', exact: true })
  if (await closeProperties.isVisible()) await closeProperties.click()
  await expect(page.locator('.react-flow__edge[data-id^="pedge:"] .react-flow__edge-path')).toHaveCount(4)
  expect(await renderedInk(), 'connection ink matches individual navigation at a different zoom').toEqual(focusedInk)
  await page.screenshot({ path: 'test-results/replay-connection-gutters.png' })
  const holdReviewExit = () => review.evaluate(element => {
    const observer = new MutationObserver(() => {
      if (element.hasAttribute('data-exiting')) for (const animation of element.getAnimations()) animation.pause()
    })
    observer.observe(element, { attributes: true, attributeFilter: ['data-exiting'] })
    ;(element as any).__exitObserver = observer
  })
  await holdReviewExit()
  await page.getByRole('button', { name: /^The Floor/ }).click()
  await expect(review).toHaveAttribute('data-exiting', 'true')
  expect(await review.evaluate(element => (element as HTMLElement).inert && element.getAttribute('aria-hidden') === 'true' && [...element.querySelectorAll('button')].every(button => button.disabled))).toBe(true)
  await review.evaluate(element => { for (const animation of element.getAnimations()) animation.currentTime = Number(animation.effect!.getComputedTiming().endTime) / 2 })
  await page.screenshot({ path: 'test-results/review-exit-half.png' })
  const exitMotion = await sampleMotion(review)
  expect(exitMotion).toHaveLength(3)
  expect(exitMotion[0].height).toBeGreaterThan(exitMotion[1].height)
  expect(exitMotion[1].height).toBeGreaterThan(exitMotion[2].height)
  expect(exitMotion[0].top).toBeLessThan(exitMotion[2].top)
  await expect(review).toHaveCount(0)
  await page.getByRole('button', { name: 'Heuristics replay', exact: true }).click()
  await review.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))) })
  await holdReviewExit()
  await page.getByRole('button', { name: /^The Floor/ }).click()
  await expect(review).toHaveAttribute('data-exiting', 'true')
  await page.getByRole('button', { name: 'Heuristics replay', exact: true }).click()
  await expect(review).not.toHaveAttribute('data-exiting', 'true')
  await review.evaluate(async element => {
    ;(element as any).__exitObserver.disconnect()
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})))
  })
  expect(await review.evaluate(element => !(element as HTMLElement).inert && element.getBoundingClientRect().height > 100)).toBe(true)
  const other = { ...sheet, id: 'sheet_exit_other', name: 'Other proposal' }
  const otherNode = { ...planned[1], id: 'other_file', sheetId: other.id, name: 'other.py', declaredPath: 'other.py', parentSystemId: null }
  await page.route(/\/api\/sheets\/sheet_exit_other\?/, route => route.fulfill({ json: { sheet: other, planned: [otherNode], plannedEdges: [], elements: [], layouts: [], annotations: [], removals: [] } }))
  await page.evaluate(sheet => (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'sheet:upserted', payload: sheet }), other)
  await page.getByRole('button', { name: /^The Floor/ }).click()
  await page.getByRole('button', { name: 'Other proposal', exact: true }).click()
  await expect(review).toContainText('Add other.py')
  await review.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))) })
  await expect(review).toHaveCount(1)
  await expect(review).not.toContainText('Offline Replay Tool')
  await page.getByRole('button', { name: 'Heuristics replay', exact: true }).click()
  await review.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))) })
  await holdReviewExit()
  await page.getByRole('button', { name: /^The Floor/ }).click()
  await expect(review).toHaveAttribute('data-exiting', 'true')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(review).toHaveCount(0)
  await page.getByRole('button', { name: 'Heuristics replay', exact: true }).click()
  await page.getByRole('button', { name: 'Collapse Heuristics replay', exact: true }).click()
  expect((await fold.boundingBox())!.height).toBe(0)
  await page.getByRole('button', { name: 'Expand Heuristics replay', exact: true }).click()
  expect(await fold.evaluate(element => element.getAnimations().length)).toBe(0)
  await page.getByRole('button', { name: /^The Floor/ }).click()
  await expect(review).toHaveCount(0)
  await page.getByRole('button', { name: 'Heuristics replay', exact: true }).click()
  await expect(review).toBeVisible()
  expect(await review.evaluate(element => element.getAnimations().length)).toBe(0)
  await page.getByRole('button', { name: /^The Floor/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore.getState().floorLayouts)).toEqual(original.floorLayouts)
})

test('compact sheet review retains exact decisions and navigates approved contents from the sheet row', async () => {
  test.setTimeout(90_000)
  const sheet = { id: 'sheet_replay', workspaceId: 'demo', name: 'Offline Replay', purpose: '', kind: 'structure', folder: '', createdBy: 'agent', revision: 12, createdAt: 1, updatedAt: 1 }
  const planned = ['tool', 'cli', 'tests', 'fixtures'].map((id, index) => ({
    id, sheetId: sheet.id, workspaceId: 'demo', kind: index === 0 ? 'system' : 'file', name: index === 0 ? 'Replay Tool' : id === 'cli' ? 'Scene Replay CLI' : id === 'tests' ? 'Scene Replay Verification' : 'Synthetic Replay Scenes',
    declaredPath: index === 0 ? '' : id === 'fixtures' ? 'backend/fixtures/replay_scenes.json' : id === 'cli' ? 'backend/replay_scene.py' : 'backend/tests/test_replay_scene.py', members: '[]', metadata: '{}', notes: 'Replay synthetic input offline. '.repeat(30), status: 'planned', approvalStatus: 'pending',
    positionX: 0, positionY: 0, width: null, height: null, scale: 1, parentSystemId: index === 0 ? 'sys_shared' : 'planned:tool', createdBy: 'agent',
  }))
  const plannedEdges = [
    ['call', 'cli', null, 'file_canvas'], ['test-cli', 'tests', 'cli', null],
    ['test-evaluator', 'tests', null, 'file_canvas'], ['test-fixtures', 'tests', 'fixtures', null],
  ].map(([id, srcPlanned, dstPlanned, dstLive]) => ({ id, sheetId: sheet.id, workspaceId: 'demo', kind: 'IMPORTS', srcPlanned, dstPlanned, dstLive, srcLive: null, approvalStatus: 'pending', createdBy: 'agent' }))
  const context = [{ id: 'context_system', systemId: 'sys_shared', parentSystemId: null, positionX: 0, positionY: 0, width: null, height: null }, { id: 'context_file', fileId: 'file_canvas', parentSystemId: 'sys_canvas', positionX: 0, positionY: 0, width: null, height: null }]
  const layouts = [{ workspaceId: 'demo', nodeId: 'file_canvas', nodeType: 'file', parentNodeId: 'sys_canvas', parentNodeType: 'system', containmentKind: 'part_of', positionX: 120, positionY: 150, width: 220, height: 110, scale: 1, interiorScale: 1, updatedAt: 0 }]
  let reviewed: any
  const edits: any[] = []
  const systemEdits: any[] = []
  await page.route(/\/api\/sheets\?/, route => route.fulfill({ json: [sheet] }))
  await page.route(/\/api\/planned\/(cli|tool)$/, async route => {
    const edit = route.request().postDataJSON()
    if (edit.id === 'tool') systemEdits.push(edit)
    else edits.push(edit)
    Object.assign(planned.find(node => node.id === edit.id)!, edit)
    await route.fulfill({ json: edit })
  })
  await page.route(/\/api\/sheets\/sheet_replay\?/, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sheet, planned, plannedEdges, elements: context, annotations: [], layouts, removals: [] }) }))
  await page.route(/\/api\/sheets\/sheet_replay\/review$/, async route => {
    reviewed = route.request().postDataJSON()
    sheet.revision = 17
    for (const node of planned) node.approvalStatus = 'approved'
    for (const edge of plannedEdges) edge.approvalStatus = 'approved'
    await route.fulfill({ json: { sheet, planned, plannedEdges } })
  })
  await page.evaluate(sheet => (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'sheet:upserted', payload: sheet }), sheet)
  await page.getByRole('button', { name: 'Open Sheet' }).click()
  const review = page.getByLabel('Agent proposals to review')
  await expect(review.getByLabel('1 change to review')).toBeVisible()
  await expect(review.locator('.ambio-sheet-review-group')).toHaveCount(1)
  await expect(review.getByRole('button', { name: 'Confirm replay_scene.py', exact: true })).not.toBeVisible()
  expect((await review.boundingBox())!.height).toBeLessThan(210)
  await expect(review).toContainText('1 system · 3 files · 4 connections')
  await expect(review.locator('details')).toHaveCount(0)
  await review.getByRole('button', { name: 'Inspect changes for Add Replay Tool', exact: true }).click()
  const reviewPanel = page.getByRole('dialog', { name: 'Review Add Replay Tool' })
  await expect(reviewPanel.locator('li[data-kind]')).toHaveCount(8)
  await expect(reviewPanel.getByRole('button', { name: 'Confirm replay_scene.py', exact: true })).toBeVisible()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  await page.screenshot({ path: 'test-results/sheet-review-inspector.png' })
  await reviewPanel.getByRole('button', { name: 'Request changes', exact: true }).click()
  await expect(reviewPanel.getByRole('textbox', { name: 'What should change?' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(reviewPanel.getByRole('textbox', { name: 'What should change?' })).toHaveCount(0)
  await expect(reviewPanel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(reviewPanel).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'Inspect changes for Add Replay Tool', exact: true })).toBeFocused()
  await review.getByRole('button', { name: /^Add Replay Tool/ }).click()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  const assertContained = async () => {
    const tool = page.locator('.react-flow__node[data-id="planned:tool"]')
    const parent = await tool.boundingBox()
    const title = await tool.getByText('Replay Tool', { exact: true }).first().boundingBox()
    expect(parent).not.toBeNull()
    expect(title).not.toBeNull()
    for (const id of ['cli', 'tests', 'fixtures']) {
      const child = await page.locator(`.react-flow__node[data-id="planned:${id}"]`).boundingBox()
      expect(child).not.toBeNull()
      expect(child!.x).toBeGreaterThan(parent!.x)
      expect(child!.y).toBeGreaterThan(title!.y + title!.height)
      expect(child!.x + child!.width).toBeLessThan(parent!.x + parent!.width + 1)
      expect(child!.y + child!.height).toBeLessThan(parent!.y + parent!.height + 1)
      const controls = page.locator(`.react-flow__node[data-id="planned:${id}"]`).getByRole('button', { name: 'Show classes', exact: true })
      const control = await controls.boundingBox()
      expect(control!.y + control!.height).toBeLessThan(child!.y + child!.height + 1)
    }
  }
  await assertContained()
  const systemCard = page.locator('.react-flow__node[data-id="planned:tool"]')
  await expect(systemCard.getByRole('button', { name: 'Description of Replay Tool', exact: true })).toHaveCount(0)
  const inspectSystem = async () => {
    const box = (await systemCard.boundingBox())!
    await systemCard.dblclick({ position: { x: box.width - 12, y: 12 } })
  }
  await inspectSystem()
  const systemInspector = page.getByRole('complementary', { name: /planned system properties/i })
  await expect(systemInspector.getByRole('textbox', { name: 'DESCRIPTION (OPTIONAL)', exact: true })).toHaveValue('Replay synthetic input offline. '.repeat(30))
  await systemInspector.getByRole('textbox', { name: 'DESCRIPTION (OPTIONAL)', exact: true }).fill('Replays scene decisions offline using the existing evaluator.')
  await systemInspector.getByRole('textbox', { name: 'DESCRIPTION (OPTIONAL)', exact: true }).press('Tab')
  await expect.poll(() => systemEdits.at(-1)?.metadata?.description).toBe('Replays scene decisions offline using the existing evaluator.')
  await systemInspector.getByRole('button', { name: 'Close properties' }).click()
  await inspectSystem()
  await expect(systemInspector.getByRole('textbox', { name: 'DESCRIPTION (OPTIONAL)', exact: true })).toHaveValue('Replays scene decisions offline using the existing evaluator.')
  await systemInspector.getByRole('button', { name: 'Close properties' }).click()
  const cli = page.locator('.react-flow__node[data-id="planned:cli"]')
  await expect(cli.locator('[data-node-editable]').first()).toHaveText('replay_scene.py')
  await expect(cli.getByLabel('Python', { exact: true }).first()).toBeVisible()
  const fixtures = page.locator('.react-flow__node[data-id="planned:fixtures"]')
  await expect(fixtures.locator('[data-node-editable]').first()).toHaveText('replay_scenes.json')
  await expect(fixtures.getByLabel('JSON', { exact: true }).first()).toBeVisible()
  await expect(cli.locator('.symbol-scroll')).not.toContainText('Scene Replay CLI')
  await expect(cli.locator('.symbol-scroll')).not.toContainText('backend/replay_scene.py')
  await page.getByRole('button', { name: 'Expand Offline Replay', exact: true }).click()
  await page.getByRole('button', { name: 'Show All Sheet Relationships', exact: true }).click()
  const routedEdge = page.locator('.react-flow__edge[data-id="pedge:test-cli"]')
  await expect(routedEdge.locator('.ambio-sheet-relationship-arrow')).toBeAttached()
  const obstacle = (await fixtures.boundingBox())!
  const crossesFixture = await routedEdge.locator('.react-flow__edge-path').evaluate((element, rect) => {
    const path = element as SVGPathElement
    const matrix = path.getScreenCTM()!
    for (let sample = 0; sample <= 100; sample++) {
      const point = path.getPointAtLength(path.getTotalLength() * sample / 100)
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
      if (screen.x > rect.x + 1 && screen.x < rect.x + rect.width - 1 && screen.y > rect.y + 1 && screen.y < rect.y + rect.height - 1) return true
    }
    return false
  }, obstacle)
  expect(crossesFixture).toBe(false)
  const assertInk = async () => {
    const arrow = (await routedEdge.locator('.ambio-sheet-relationship-arrow').boundingBox())!
    // The 8px arrowhead includes a 1.5px ivory stroke in its painted bounds.
    expect(Math.max(arrow.width, arrow.height)).toBeCloseTo(9.5, 0)
    const width = await routedEdge.locator('.react-flow__edge-path').evaluate(element => parseFloat(getComputedStyle(element).strokeWidth) * (element as SVGPathElement).getScreenCTM()!.a)
    expect(width).toBeCloseTo(1.25, 2)
  }
  await assertInk()
  const description = page.locator('.react-flow__node[data-id="planned:cli"] .symbol-scroll')
  await expect.poll(() => description.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(10)
  const camera = () => page.locator('.react-flow__viewport').getAttribute('style')
  const beforeScroll = await camera()
  await description.hover()
  await page.mouse.wheel(0, 100)
  await expect.poll(() => description.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await description.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.waitForTimeout(300)
  await page.mouse.wheel(0, 100)
  await page.waitForTimeout(350)
  expect(await camera()).toBe(beforeScroll)
  await page.screenshot({ path: 'test-results/compact-sheet-review.png' })
  const zoom = () => page.locator('.react-flow__viewport').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)
  const initialZoom = await zoom()
  for (const [key, presses] of [['-', 6], ['=', 12]] as const) {
    for (let index = 0; index < presses; index++) {
      const previousZoom = await zoom()
      await page.keyboard.press(`ControlOrMeta+${key}`)
      if (key === '-') await expect.poll(zoom).toBeLessThan(previousZoom)
      else await expect.poll(zoom).toBeGreaterThan(previousZoom)
      await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
    }
    if (key === '-') {
      await expect.poll(zoom).toBeLessThan(initialZoom / 2)
      // At overview zoom semantic detail is hidden instead of spilling over titles.
      await expect(page.locator('.react-flow__node[data-id="planned:cli"]')).toHaveCount(0)
    } else {
      await expect.poll(zoom).toBeGreaterThan(initialZoom)
      await assertContained()
      await assertInk()
    }
  }
  // Description and member authoring are both available without losing either.
  await review.getByRole('button', { name: /^Add Replay Tool/ }).click()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  for (const [tab, kind] of [['functions', 'function'], ['variables', 'variable'], ['classes', 'class']]) {
    await cli.getByRole('button', { name: `Show ${tab}`, exact: true }).click()
    const add = cli.getByRole('button', { name: `Add ${kind}`, exact: true })
    await expect(add).toHaveText(`+Add first ${kind}`)
    await expect(cli.locator('.symbol-scroll')).not.toContainText('No symbols')
    if (kind === 'function') {
      await page.screenshot({ path: 'test-results/symbol-empty-add.png' })
      await add.focus()
      await page.keyboard.press('Enter')
    } else await add.click()
    await expect.poll(() => edits.at(-1)?.metadata?.symbols?.some((symbol: any) => symbol.kind === kind)).toBe(true)
  }
  await cli.getByRole('button', { name: 'Show description', exact: true }).click()
  await expect(description).toContainText('Replay synthetic input offline.')

  await cli.dblclick({ position: { x: 12, y: 12 } })
  const inspector = page.getByRole('complementary', { name: /planned file properties/i })
  await expect(inspector.getByLabel('FILE NAME', { exact: true })).toHaveValue('replay_scene.py')
  await expect(inspector.getByRole('textbox', { name: 'DESCRIPTION (OPTIONAL)', exact: true })).toHaveValue('Replay synthetic input offline. '.repeat(30))
  await expect(inspector.getByRole('button', { name: 'Language: Python' })).toBeVisible()
  await expect(inspector.getByLabel('FUNCTION NAME', { exact: true })).toHaveValue('newFunction')
  await expect(inspector.getByLabel('VARIABLE NAME', { exact: true })).toHaveValue('newVariable')
  await expect(inspector.getByLabel('CLASS NAME', { exact: true })).toHaveValue('NewClass')
  await inspector.getByRole('textbox', { name: 'DESCRIPTION (OPTIONAL)', exact: true }).fill('Evaluate scenes without a phone.')
  await inspector.getByRole('textbox', { name: 'DESCRIPTION (OPTIONAL)', exact: true }).press('Tab')
  await expect(description).toHaveText('Evaluate scenes without a phone.')
  await inspector.getByLabel('FUNCTION NAME', { exact: true }).fill('evaluate_scene')
  await inspector.getByLabel('FUNCTION NAME', { exact: true }).press('Tab')
  await cli.getByRole('button', { name: 'Show functions', exact: true }).click()
  await expect(cli.locator('.symbol-row')).toContainText('evaluate_scene')
  await inspector.getByLabel('FILE NAME', { exact: true }).fill('inspected_replay.py')
  await inspector.getByLabel('FILE NAME', { exact: true }).press('Tab')
  await expect(cli.locator('[data-node-editable]').first()).toHaveText('inspected_replay.py')
  await inspector.getByRole('button', { name: 'Close properties' }).click()
  await review.getByRole('button', { name: /^Add Replay Tool/ }).click()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  // Filename edits keep the directory and use a single real name.
  await cli.locator('[data-node-editable]').first().dblclick()
  await cli.getByRole('textbox').fill('renamed_replay.py')
  await cli.getByRole('textbox').press('Enter')
  await expect.poll(() => edits.at(-1)?.declaredPath).toBe('backend/renamed_replay.py')
  expect(edits.at(-1)?.name).toBe('renamed_replay.py')
  await cli.locator('button[title="Choose implementation language"]').first().click()
  const menu = page.getByRole('listbox', { name: 'Implementation language' })
  await expect(menu).toBeVisible()
  expect(await menu.evaluate(element => element.matches(':popover-open'))).toBe(true)
  const json = menu.getByRole('option', { name: /^JSON/ })
  await json.scrollIntoViewIfNeeded()
  const aboveNodes = await json.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })
  expect(aboveNodes).toBe(true)
  await json.click()
  await expect.poll(() => edits.at(-1)?.declaredPath).toBe('backend/renamed_replay.json')
  await cli.locator('button[title="Choose implementation language"]').first().click()
  await menu.getByRole('option', { name: /^TypeScript/ }).click()
  await expect.poll(() => edits.at(-1)?.declaredPath).toBe('backend/renamed_replay.ts')
  expect(edits.at(-1)?.name).toBe('renamed_replay.ts')
  await review.evaluate(element => {
    new MutationObserver(() => {
      if (element.hasAttribute('data-exiting')) for (const animation of element.getAnimations()) animation.pause()
    }).observe(element, { attributes: true, attributeFilter: ['data-exiting'] })
  })
  await review.getByRole('button', { name: 'Approve Add Replay Tool', exact: true }).click()
  await expect.poll(() => reviewed?.choices.length).toBe(8)
  expect(reviewed).toMatchObject({ revision: 12, decision: 'approved' })
  await expect(review).toHaveAttribute('data-exiting', 'true')
  expect(await review.evaluate(element => (element as HTMLElement).inert && [...element.querySelectorAll('button')].every(button => button.disabled))).toBe(true)
  await review.evaluate(element => { for (const animation of element.getAnimations()) animation.finish() })
  await expect(review).toHaveCount(0)
  const contents = page.getByRole('group', { name: 'Contents of Offline Replay', exact: true })
  await expect(contents.getByRole('button', { name: 'Show Shared Types on sheet', exact: true })).toHaveCount(0)
  await expect(contents.getByRole('button', { name: 'Show AmbioCanvas.tsx on sheet', exact: true })).toHaveCount(0)
  await contents.getByRole('button', { name: 'Connections 4', exact: true }).click()
  await expect(contents).toContainText('AmbioCanvas.tsx')
  await contents.getByRole('button', { name: 'Connections 4', exact: true }).click()
  await expect(contents).toBeVisible()
  await expect(contents.getByRole('button', { name: 'Show renamed_replay.ts on sheet', exact: true })).toBeVisible()
  await expect(contents).not.toContainText('To review')
  await expect(contents.getByText('Approved', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Actions for Offline Replay', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Discuss or implement…', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^The Floor/ }).click()
  await contents.getByRole('button', { name: 'Show renamed_replay.ts on sheet', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Offline Replay', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(cli).toBeInViewport()
  await expect(cli.locator('[data-node-editable]').first()).toHaveText('renamed_replay.ts')
  await cli.getByRole('button', { name: 'Show description', exact: true }).click()
  await expect(cli.locator('.symbol-scroll')).toContainText('Evaluate scenes without a phone.')
  await cli.getByRole('button', { name: 'Show functions', exact: true }).click()
  await expect(cli.locator('.symbol-row')).toContainText('evaluate_scene')
  await page.screenshot({ path: 'test-results/approved-sheet-contents.png' })
})

test('a system an agent names stays where the Floor has it, and a proposed move draws the file inside the new system', async () => {
  const { systemId, parentId } = await page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    const file = state.files.find((candidate: { id: string }) => candidate.id === 'file_canvas')
    const system = state.systems.find((candidate: { id: string }) => candidate.id === file.systemId)
    return { systemId: system.id as string, parentId: (system.parentId ?? null) as string | null }
  })
  const floorBox = await page.locator(`.react-flow__node[data-id="${systemId}"]`).boundingBox()
  const agentSheet = {
    id: 'sheet_split', workspaceId: 'demo', name: 'Split Payments', purpose: '', kind: 'structure',
    folder: '', createdBy: 'agent', revision: 1, createdAt: 9, updatedAt: 9,
  }
  // What an agent's draw leaves: members and a proposal with no geometry, and
  // the file it takes over moved under the proposal (db.ProposeSheetMove).
  const unplaced = { positionX: 0, positionY: 0, width: null, height: null, scale: 1, tombstoneAck: 0, ghost: 0, addedBy: 'agent', symbolRef: null, infraId: null }
  const elements = [
    { ...unplaced, id: 'el_system', sheetId: 'sheet_split', systemId, fileId: null, label: 'System', parentSystemId: parentId, proposedName: 'Canvas Platform', renameStatus: 'pending' },
    { ...unplaced, id: 'el_file', sheetId: 'sheet_split', systemId: null, fileId: 'file_canvas', label: 'canvas', parentSystemId: 'planned:plan_split', approvalStatus: 'pending' },
  ]
  const relationship = { id: 'edge_split', sheetId: 'sheet_split', workspaceId: 'demo', kind: 'DEPENDS_ON', srcPlanned: 'plan_split', srcLive: null, dstPlanned: null, dstLive: systemId, note: '', approvalStatus: 'pending', createdBy: 'agent' }
  const proposal = {
    id: 'plan_split', sheetId: 'sheet_split', workspaceId: 'demo', kind: 'system', name: 'Payments Split',
    declaredPath: '', members: '[]', metadata: '{}', status: 'planned', approvalStatus: 'pending',
    realizedFileId: null, notes: '', shape: '', color: '', positionX: 0, positionY: 0,
    width: null, height: null, scale: 1, parentSystemId: null, createdBy: 'agent',
  }
  // A later reload of the sheet list must keep the agent's sheet in the rail.
  const runtimeSheet = { id: 'sheet_runtime', workspaceId: 'demo', name: 'Runtime Draft', purpose: 'Focused runtime architecture', kind: 'structure', folder: '', createdBy: 'user', revision: 1, createdAt: 1, updatedAt: 1 }
  const listSheets = (route: Route) => route.fulfill({ json: [runtimeSheet, agentSheet] })
  await page.route(/\/api\/sheets\?/, listSheets)
  await page.route(/\/api\/sheets\/sheet_split\?/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ sheet: agentSheet, elements, annotations: [], planned: [proposal], plannedEdges: [relationship], layouts: [], removals: [] }),
  }))
  await page.evaluate(sheet => (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'sheet:upserted', payload: sheet }), agentSheet)
  await page.getByRole('button', { name: 'Open Sheet' }).click()
  const review = page.getByLabel('Agent proposals to review')
  await expect(review).toContainText('Payments Split')
  // The relationship is reviewed with the new system; the move and the rename
  // are changes of their own.
  await expect(review.getByLabel('3 changes to review')).toBeVisible()
  await expect(page.locator('.react-flow__edge[data-id="pedge:edge_split"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand Split Payments', exact: true }).click()
  const relationships = page.getByRole('button', { name: 'Show All Sheet Relationships', exact: true })
  await relationships.click()
  await expect(relationships).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.react-flow__edge[data-id="pedge:edge_split"]')).toBeAttached()
  await relationships.click()
  await expect(relationships).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.react-flow__edge[data-id="pedge:edge_split"]')).toHaveCount(0)
  // The named system has not moved or resized.
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  const sheetBox = await page.locator(`.react-flow__node[data-id="${systemId}"]`).boundingBox()
  expect(floorBox && sheetBox).toBeTruthy()
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(sheetBox![key] - floorBox![key])).toBeLessThan(2)
  // It shows the proposed name, the one the map has today, and that it is a proposal.
  const renamedSystem = page.locator(`.react-flow__node[data-id="${systemId}"]`)
  await expect(renamedSystem).toHaveAttribute('data-proposal-kind', 'rename')
  await expect(renamedSystem.locator('.ambio-renamed-from')).toContainText('was ')
  await expect(renamedSystem).toContainText('Canvas Platform')
  await page.screenshot({ path: 'test-results/sheet-proposed-rename.png' })
  // Each change's rows open in its inspector.
  const inspect = async (group: RegExp) => {
    await review.getByRole('button', { name: new RegExp(`^Inspect changes for ${group.source}$`) }).click()
    // Inspecting flies to the change. A camera move that interrupts that
    // flight leaves React Flow's fit-view promise unresolved for good, so let
    // each one land before the next gesture.
    await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
    return page.getByRole('dialog', { name: new RegExp(`^Review ${group.source}$`) })
  }
  let inspector = await inspect(/Add Payments Split/)
  await expect(inspector.locator('li[data-kind]')).toHaveCount(2)
  await expect(inspector.locator('li[data-kind="relationship"]')).toContainText('Payments Split')
  inspector = await inspect(/Move .+ into Payments Split/)
  await expect(inspector.locator('li[data-kind="move"]')).toContainText('into Payments Split')
  inspector = await inspect(/Canvas Renderer/)
  await expect(inspector.locator('li[data-kind="rename"]')).toContainText('to Canvas Platform')
  await page.keyboard.press('Escape')
  await expect(inspector).toHaveCount(0)
  // The file the proposal takes over is drawn inside it.
  await review.getByRole('button', { name: /Payments Split/ }).first().click()
  const plannedNode = page.locator('.react-flow__node[data-id="planned:plan_split"]')
  const fileNode = page.locator('.react-flow__node[data-id="file_canvas"]')
  await expect(fileNode).toBeAttached()
  await expect.poll(async () => {
    const outer = await plannedNode.boundingBox()
    const inner = await fileNode.boundingBox()
    return !!outer && !!inner && inner.x >= outer.x && inner.y >= outer.y
      && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1
  }, { timeout: 5_000 }).toBe(true)
  // The moved file is marked as a proposed move, and the relationship is drawn.
  await expect(fileNode).toHaveAttribute('data-proposal-kind', 'move')
  await expect(fileNode).not.toHaveCSS('outline-style', 'dashed')
  await expect(page.locator('.react-flow__edge[data-id="pedge:edge_split"]')).toBeAttached()
  inspector = await inspect(/Add Payments Split/)
  await inspector.locator('li[data-kind="relationship"]').getByRole('button').first().click()
  await expect(page.getByLabel('Selected relationship')).toContainText('Payments Split uses')
  await expect.poll(async () => {
    const canvas = await page.locator('.react-flow').first().boundingBox()
    const source = await plannedNode.boundingBox()
    const target = await page.locator(`.react-flow__node[data-id="${systemId}"]`).boundingBox()
    return !!canvas && [source, target].every(box => box && box.x >= canvas.x && box.y >= canvas.y && box.x + box.width <= canvas.x + canvas.width && box.y + box.height <= canvas.y + canvas.height)
  }).toBe(true)
  await expect(plannedNode.locator('.ambio-sheet-change-badge')).toHaveText('Added')
  await expect.poll(async () => {
    const size = await plannedNode.locator('.ambio-sheet-change-badge').boundingBox()
    return size?.height ?? 0
  }).toBeLessThan(22)
  await page.evaluate(edge => (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'planned:edge', payload: { ...edge, approvalStatus: 'approved' } }), relationship)
  await expect(inspector.locator('li[data-kind="relationship"]')).toHaveCount(0)
  await page.locator('.react-flow__pane').click({ position: { x: 350, y: 100 } })
  await relationships.click()
  await expect(relationships).toHaveAttribute('aria-pressed', 'true')
  const connection = page.locator('.react-flow__edge[data-id="pedge:edge_split"] .react-flow__edge-interaction')
  const midpoint = await connection.evaluate(element => {
    const path = element as SVGPathElement
    const point = path.getPointAtLength(path.getTotalLength() / 2)
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.click(midpoint.x, midpoint.y)
  await expect(page.getByLabel('Selected relationship')).toContainText('Part of this plan')
  await page.screenshot({ path: 'test-results/sheet-proposed-move.png' })
  await page.unroute(/\/api\/sheets\/sheet_split\?/)
  await page.unroute(/\/api\/sheets\?/, listSheets)
})

test('Edit → Undo and Redo step through map changes made on the Floor', async () => {
  const calls: string[] = []
  page.on('request', request => {
    if (request.method() !== 'POST') return
    if (request.url().includes('/api/architecture/undo')) calls.push(`undo ${JSON.stringify((request.postDataJSON() as { eventIds?: number[] }).eventIds)}`)
    if (request.url().includes('/api/architecture/edits')) calls.push('edit')
  })
  const file = await revealFileNode('file_canvas')
  await file.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Take Out of / }).click()
  await expect.poll(() => calls).toEqual(['edit'])
  await page.locator('.react-flow__pane').click({ position: { x: 420, y: 420 } })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => calls).toEqual(['edit', 'undo [1]'])
  await expect(page.getByText(/^Undid: /)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(() => calls).toEqual(['edit', 'undo [1]', 'edit'])
  // Nothing left to redo: a further press sends nothing.
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await page.waitForTimeout(300)
  expect(calls).toEqual(['edit', 'undo [1]', 'edit'])
})

test('Model Explorer outlines the map, filters it and follows the selection', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+O')
  const explorer = page.getByRole('complementary', { name: 'Model Explorer' })
  await expect(explorer).toBeVisible()
  const tree = explorer.getByRole('tree')
  await expect(tree.getByRole('treeitem', { name: /Canvas Renderer/ })).toBeVisible()

  // Filtering opens the path to every match.
  await explorer.getByLabel('Filter systems, files and symbols').fill('AmbioCanvas')
  const fileRow = tree.getByRole('treeitem', { name: /AmbioCanvas\.tsx/ })
  await expect(fileRow).toBeVisible()

  // Choosing a row selects that node on the canvas.
  await fileRow.click()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __ambioGraphStore: { getState: () => { selectedNodeId: string | null } } })
      .__ambioGraphStore.getState().selectedNodeId)).toBe('file_canvas')
  await expect(fileRow).toHaveAttribute('aria-selected', 'true')

  // Keyboard: the tree answers arrows and Escape closes it.
  await explorer.getByLabel('Filter systems, files and symbols').fill('')
  await tree.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('Escape')
  await expect(explorer).toHaveCount(0)
})

test('Review Changes: undo a map change, make the code match, copy as Markdown', async () => {
  let undone: number[] | undefined
  page.on('request', request => {
    if (request.url().includes('/api/architecture/undo') && request.method() === 'POST') {
      undone = (request.postDataJSON() as { eventIds?: number[] }).eventIds
    }
  })
  const counts = { filesCreated: 0, filesUpdated: 0, filesDeleted: 0, edgesAdded: 0, edgesRemoved: 0, systemsAdded: 0, systemsRemoved: 0, crossBoundary: 0, agentFiles: 0, humanFiles: 0 }
  const moved = {
    id: 'claim:moved', kind: 'meaning.moved', title: 'AmbioCanvas.tsx moved from Canvas Renderer to Shared Types',
    subtitle: 'by you', severity: 3, score: 1, actor: 'human', ts: 2, createsCycle: false, internal: false,
    focusSystemIds: ['sys_shared'], focusFileIds: ['file_canvas'],
    evidence: [{ kind: 'file.moved', label: 'AmbioCanvas.tsx', detail: 'Canvas Renderer → Shared Types', fileIds: ['file_canvas'] }],
    undoEventIds: [41],
    codeFit: [{
      kind: 'folder', fileId: 'file_canvas', filePath: 'src/renderer/canvas/AmbioCanvas.tsx', systemId: 'sys_shared', systemName: 'Shared Types',
      summary: 'AmbioCanvas.tsx belongs to Shared Types, but the rest of Shared Types is in src/shared/',
      ask: 'Move src/renderer/canvas/AmbioCanvas.tsx to src/shared/AmbioCanvas.tsx and update every import of it.',
    }],
  }
  await page.evaluate(summary => {
    const store = (window as unknown as { __ambioGraphStore: { setState: (s: unknown) => void; getState: () => { startDeltaReview: () => void } } }).__ambioGraphStore
    store.setState({ delta: summary })
  }, { since: 1, until: 3, files: [], edges: [], systems: [], claims: [moved], sessions: [], counts, empty: false })
  await expect(page.locator('.ambio-lane')).toHaveCount(0)
  // Further code updates must stay quiet too; review remains explicitly available.
  await page.evaluate(() => {
    const store = (window as any).__ambioGraphStore
    store.setState({ delta: { ...store.getState().delta, until: 4 } })
  })
  await expect(page.locator('.ambio-lane')).toHaveCount(0)
  await page.getByRole('button', { name: 'Review Changes', exact: true }).click()

  const panel = page.getByRole('complementary', { name: 'Reviewing changes' })
  await expect(panel).toContainText('AmbioCanvas.tsx moved from Canvas Renderer to Shared Types')
  await expect(panel).toContainText('the rest of Shared Types is in src/shared/')

  await panel.getByRole('button', { name: 'Copy as Markdown' }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('- AmbioCanvas.tsx moved from Canvas Renderer to Shared Types _(by you)_ - code still disagrees')

  await panel.getByRole('button', { name: 'Make the Code Match…' }).click()
  await expect(page.locator('textarea').first()).toHaveValue(/Move src\/renderer\/canvas\/AmbioCanvas\.tsx to src\/shared/)
  await expect(page.getByText('Ambio checks the code afterwards')).toBeVisible()

  await panel.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => undone).toEqual([41])
})

test('Review Changes narrows by who made a change and hides what you have seen', async () => {
  const counts = { filesCreated: 0, filesUpdated: 0, filesDeleted: 0, edgesAdded: 0, edgesRemoved: 0, systemsAdded: 0, systemsRemoved: 0, crossBoundary: 0, agentFiles: 0, humanFiles: 0 }
  const base = { subtitle: '', severity: 3, score: 1, ts: 2, createsCycle: false, internal: false, evidence: [] }
  const claims = [
    { ...base, id: 'claim:mine', kind: 'meaning.renamed', title: 'Canvas Renderer renamed to Canvas', actor: 'human', focusSystemIds: ['sys_canvas'] },
    { ...base, id: 'claim:agent', kind: 'system.coupling', title: 'MCP Server now depends on Shared Types', actor: 'agent', focusSystemIds: ['sys_mcp', 'sys_shared'] },
  ]
  await page.evaluate(summary => {
    const store = (window as unknown as { __ambioGraphStore: { setState: (s: unknown) => void; getState: () => { startDeltaReview: () => void } } }).__ambioGraphStore
    store.setState({ delta: summary })
    store.getState().startDeltaReview()
  }, { since: 1, until: 4, files: [], edges: [], systems: [], claims, sessions: [], counts, empty: false })

  const panel = page.getByRole('complementary', { name: 'Reviewing changes' })
  const titles = panel.locator('.ambio-delta__claim-title')
  await expect(titles).toHaveCount(2)
  await panel.getByRole('combobox', { name: 'Who filter' }).selectOption({ label: 'Unexplained (1)' })
  await expect(titles).toHaveText(['MCP Server now depends on Shared Types'])
  await expect(panel).toContainText('1 of 2')
  await panel.getByRole('button', { name: 'Clear' }).click()
  await expect(titles).toHaveCount(2)

  await panel.getByRole('button', { name: '1 unexplained' }).click()
  await expect(titles).toHaveText(['MCP Server now depends on Shared Types'])
  await panel.getByRole('button', { name: '1 unexplained' }).click()
  await expect(titles).toHaveCount(2)

  await panel.getByRole('button', { name: 'Mark “Canvas Renderer renamed to Canvas” seen' }).click()
  await panel.getByRole('checkbox', { name: /Hide seen/ }).check()
  await expect(titles).toHaveText(['MCP Server now depends on Shared Types'])
})

test('Zoom to Selection frames what is selected, and the empty-canvas menu offers Tidy Layout', async () => {
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 900, y: 600 } })
  await expect(page.getByRole('menuitem', { name: 'Tidy Layout' })).toBeVisible()
  await page.keyboard.press('Escape')
  const system = page.locator('.react-flow__node[data-id="sys_mcp"]')
  await system.click()
  const before = await canvasZoom()
  const widthBefore = (await system.boundingBox())!.width
  await page.keyboard.press('ControlOrMeta+Shift+0')
  await expect.poll(canvasZoom).not.toBeCloseTo(before, 2)
  const box = (await system.boundingBox())!
  const pane = (await page.locator('.react-flow').boundingBox())!
  expect(box.width).toBeGreaterThan(widthBefore)
  expect(box.x).toBeGreaterThanOrEqual(pane.x)
  expect(box.y).toBeGreaterThanOrEqual(pane.y)
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width)
  expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height)
})

test('a sheet can start from a right-clicked system, with the system on it', async () => {
  let posted: { elements?: unknown[]; createdBy?: string } | null = null
  await page.route(/\/api\/sheets$/, async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    posted = route.request().postDataJSON()
    await route.fulfill({ json: {
      id: 'sheet_from_selection', workspaceId: 'demo', name: 'MCP story', purpose: '', kind: 'structure',
      folder: '', createdBy: 'user', revision: 1, createdAt: 1, updatedAt: 1,
    } })
  })
  await page.locator('.react-flow__node[data-id="sys_mcp"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New Sheet from Selection…' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Sheet' })
  await expect(dialog).toContainText('Starting the sheet with 1 system')
  await dialog.getByRole('textbox', { name: 'Sheet name' }).fill('MCP story')
  await dialog.getByRole('button', { name: 'Create Sheet' }).click()
  await expect.poll(() => posted?.elements).toEqual([expect.objectContaining({ systemId: 'sys_mcp' })])
  expect(posted!.createdBy).toBe('user')
})

test('culls a large planned sheet over a small Floor and retains measurements during zoom', async () => {
  // Keep the compact file and its facing port in clear viewport space. An
  // oversized source that overlaps the Floor is automatically displaced, and
  // a visible sliver of its card does not guarantee a visible clipped line.
  const placement = await page.locator('.react-flow').first().evaluate(root => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(root.querySelector('.react-flow__viewport')!).transform)
    return { x: (root.clientWidth * .12 - matrix.e) / matrix.a, y: (80 - matrix.f) / matrix.a }
  })
  const planned = Array.from({ length: 180 }, (_, i) => ({
    id: `large-planned-${i}`, workspaceId: 'demo', sheetId: 'sheet_runtime', name: `Planned ${i}`,
    kind: i === 0 ? 'file' : 'system', status: 'planned', approvalStatus: 'approved', parentPlannedId: null,
    positionX: i === 0 ? placement.x : 1500 + i * 800, positionY: i === 0 ? placement.y : 1200,
    width: i === 0 ? 220 : 620, height: i === 0 ? 110 : 420, scale: 1,
    metadata: {}, createdBy: 'user', createdAt: 1, updatedAt: 1,
  }))
  await page.route(/\/api\/sheets\/sheet_runtime\?/, route => route.fulfill({ json: {
    sheet: { id: 'sheet_runtime', workspaceId: 'demo', name: 'Runtime Draft', purpose: '', kind: 'structure',
      folder: '', createdBy: 'user', revision: 1, createdAt: 1, updatedAt: 1 },
    elements: [], annotations: [], planned, plannedEdges: [{
      id: 'offscreen-link', sheetId: 'sheet_runtime', srcPlanned: 'large-planned-0', dstPlanned: 'large-planned-179', approvalStatus: 'approved',
    }], layouts: [], removals: [],
  } }))
  await page.getByRole('button', { name: 'Runtime Draft', exact: true }).click()
  const canvas = page.locator('[data-ambio-canvas]').first()
  await expect.poll(() => canvas.locator('.react-flow__node').count()).toBeLessThan(80)
  // A line into off-screen space must retain its endpoint handle geometry.
  await page.getByRole('button', { name: 'Expand Runtime Draft', exact: true }).click()
  await page.getByRole('button', { name: 'Show All Sheet Relationships', exact: true }).click()
  const relationship = canvas.locator('.react-flow__edge[data-id="pedge:offscreen-link"] .react-flow__edge-path')
  await expect(relationship).toBeAttached()
  expect(await relationship.getAttribute('d')).not.toContain('NaN')
  const compactFile = canvas.locator('.react-flow__node[data-id="planned:large-planned-0"]')
  await expect(compactFile.locator('[data-render-tier]')).toBeAttached()
  await expect(compactFile.locator('.ambio-sheet-change-badge')).toHaveText('Added')
  await page.waitForTimeout(650)
  await expect(canvas.locator('.react-flow__node[data-id="planned:large-planned-179"]')).toHaveCount(0)
  await expect(relationship).toBeAttached()
  expect(await relationship.getAttribute('d')).not.toContain('NaN')
  await canvas.evaluate(root => {
    ;(window as any).__sheetMountCount = 0
    ;(window as any).__sheetMountObserver = new MutationObserver(records => {
      for (const record of records) for (const added of record.addedNodes) if (added instanceof Element) {
        ;(window as any).__sheetMountCount += added.querySelectorAll('.react-flow__node').length + Number(added.matches('.react-flow__node'))
      }
    })
    ;(window as any).__sheetMountObserver.observe(root, { childList: true, subtree: true })
  })
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(700)
  expect(await page.evaluate(() => (window as any).__sheetMountCount)).toBeLessThan(80)
  await page.evaluate(() => (window as any).__sheetMountObserver.disconnect())
  await page.unroute(/\/api\/sheets\/sheet_runtime\?/)
})

test('a pasted Markdown spec becomes a draft sheet, and a sheet copies out as Markdown', async () => {
  let imported: { markdown?: string; createdBy?: string } | null = null
  await page.route(/\/api\/sheet-import$/, async route => {
    imported = route.request().postDataJSON()
    await route.fulfill({ json: {
      sheet: { id: 'sheet_runtime', workspaceId: 'demo', name: 'Runtime Draft', purpose: '', kind: 'structure',
        folder: '', createdBy: 'user', revision: 1, createdAt: 1, updatedAt: 1 },
      warnings: ['line 9 not understood: some prose'],
    } })
  })
  await page.route(/\/api\/sheets\/sheet_runtime\/markdown\?/, route => route.fulfill({ json: { markdown: '# Runtime Draft\n' } }))
  const runCommand = async (name: string) => {
    await page.keyboard.press('ControlOrMeta+Shift+P')
    await page.getByRole('textbox', { name: 'Command' }).fill(name)
    await page.keyboard.press('Enter')
  }

  await runCommand('New Sheet from Markdown')
  const dialog = page.getByRole('dialog', { name: 'New Sheet from Markdown' })
  await dialog.getByRole('combobox', { name: 'Start from' }).selectOption({ label: 'Add a queue consumer' })
  await expect(dialog.getByRole('textbox', { name: 'Markdown spec' })).toHaveValue(/^# Consume <topic>/)
  await dialog.getByRole('textbox', { name: 'Markdown spec' }).fill('# Runtime Draft\n\n## Add\n- system `Queue`\n')
  await dialog.getByRole('button', { name: 'Draft Sheet' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => imported?.createdBy).toBe('user')
  expect(imported!.markdown).toContain('- system `Queue`')
  await expect(page.getByText('Runtime Draft drafted, with 1 line left out')).toBeVisible()

  await runCommand('Copy Sheet as Markdown')
  await expect(page.getByText('Sheet copied as Markdown')).toBeVisible()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('# Runtime Draft\n')

  // A Mermaid sketch goes through the same import as a spec.
  await runCommand('New Sheet from Markdown')
  await dialog.getByRole('textbox', { name: 'Markdown spec' }).fill('flowchart LR\n  a["MCP Server"] --> q[Job Queue]\n')
  await dialog.getByRole('button', { name: 'Draft Sheet' }).click()
  await expect.poll(() => imported?.markdown).toContain('- system `Job Queue`')
  expect(imported!.markdown).toContain('## Context\n- system `MCP Server`')

  await runCommand('Copy Map as Mermaid')
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toMatch(/^```mermaid/)
  const diagram = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(diagram).toMatch(/^```mermaid\nflowchart LR\n/)
  expect(diagram).toContain('["MCP Server"]')
})

test('project chrome stays quiet and chat uses the reclaimed footer space', async () => {
  await expect(page.getByRole('contentinfo', { name: 'Application status' })).toHaveCount(0)
  await expect(page.getByText('INDEX CLEAN', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Record investigation', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Agent log', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review Changes', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Message agent/ }).click()
  const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
  await expect.poll(async () => {
    const box = await inbox.boundingBox()
    return Math.abs(page.viewportSize()!.height - box!.y - box!.height)
  }).toBeLessThan(2)
  await page.setViewportSize({ width: 900, height: 600 })
  for (const name of ['Review Changes', 'Search', 'Fit view']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(900)
  }
  await expect.poll(async () => {
    const box = await inbox.boundingBox()
    return Math.abs(600 - box!.y - box!.height)
  }).toBeLessThan(2)
})

test('long project reads expose progress and Stop, then disappear on completion', async () => {
  await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore.getState().connectionStatus)).toBe('connected')
  let stopped: unknown
  await page.route(/\/api\/workspace-index-cancel$/, async route => {
    stopped = route.request().postDataJSON()
    await route.fulfill({ json: { stopped: true } })
  })
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ isIndexing: true, indexingProgress: { indexed: 3, total: 10 } }))
  const progress = page.getByRole('progressbar', { name: 'Reading project progress' })
  await expect(progress).toHaveCount(0)
  await expect(progress).toBeVisible()
  await expect(progress).toHaveAttribute('value', '3')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => stopped).toEqual({ workspaceId: 'demo' })
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ isIndexing: false, indexingProgress: null }))
  await expect(progress).toHaveCount(0)
})

test('short project reads stay quiet', async () => {
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ isIndexing: true }))
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ isIndexing: false }))
  await page.waitForTimeout(1700)
  await expect(page.getByText('Updating your map…', { exact: true })).toHaveCount(0)
})

test('recording starts from Tools and keeps its Stop control visible', async () => {
  let started: any
  let stopped: any
  await page.route(/\/api\/investigation\/start$/, async route => {
    started = route.request().postDataJSON()
    await route.fulfill({ json: { id: 'recording-fixture', name: 'Test capture', commit: '' } })
  })
  await page.route(/\/api\/investigation\/stop$/, async route => {
    stopped = route.request().postDataJSON()
    await route.fulfill({ json: { id: 'recording-fixture', eventCount: 2 } })
  })
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Tools', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Start / Stop Recording', exact: true }).click()
  await expect.poll(() => started?.workspaceId).toBe('demo')
  const stop = page.getByRole('button', { name: /^Recording \d/ })
  await expect(stop).toBeVisible()
  await stop.click()
  await expect.poll(() => stopped).toEqual({ workspaceId: 'demo' })
  await expect(stop).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Saved 2 events - watch it' })).toBeVisible()
})

test('lost live updates warn clearly and clear after reconnecting', async () => {
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ connectionStatus: 'disconnected' }))
  await expect(page.getByText('Your map isn’t updating', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ connectionStatus: 'connected' }))
  await expect(page.getByText('Your map isn’t updating', { exact: true })).toHaveCount(0)
})

test('brief connection gaps do not leave a warning after recovery', async () => {
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ connectionStatus: 'disconnected' }))
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ connectionStatus: 'connected' }))
  await page.waitForTimeout(3300)
  await expect(page.getByText('Your map isn’t updating', { exact: true })).toHaveCount(0)
})

test('a failed Stop stays actionable and clears when the read finishes', async () => {
  await page.route(/\/api\/workspace-index-cancel$/, route => route.fulfill({ status: 500, json: { error: 'Could not stop' } }))
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ isIndexing: true }))
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByText('Could not stop reading the project', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Project Settings', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).__ambioGraphStore.setState({ isIndexing: false }))
  await expect(page.getByText('Could not stop reading the project', { exact: true })).toHaveCount(0)
})

test('unfinished drafts can be dismissed and recovered from the Agent menu', async () => {
  let drafts: unknown[] = [{ sessionId: 'draft-fixture', rationale: 'Map the project', systemCount: 4, chunkCount: 2, updatedAt: Date.now() }]
  await page.route(/\/api\/architecture-proposal-drafts\?/, route => route.fulfill({ json: drafts }))
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:proposal-draft')))
  const title = page.getByText('Your agent is mapping the project…', { exact: true })
  await expect(title).toBeVisible()
  await expect(page.locator('.ambio-lane')).not.toContainText('chunk')
  await page.getByRole('button', { name: 'Hide — reopen from Agent → Architecture Draft' }).click()
  await expect(title).toHaveCount(0)
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Agent', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Architecture Draft…', exact: true }).click()
  await expect(title).toBeVisible()
  drafts = []
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:proposal-draft')))
  await expect(title).toHaveCount(0)
})

test('an old architecture draft explains recovery and can be discarded', async () => {
  let drafts: unknown[] = [{ sessionId: 'old-draft', rationale: 'Map the project', systemCount: 4, chunkCount: 2, updatedAt: Date.now() - 6 * 60_000 }]
  let discarded: unknown
  await page.route(/\/api\/architecture-proposal-drafts\?/, route => route.fulfill({ json: drafts }))
  await page.route(/\/api\/architecture-proposal-drafts\/old-draft\/abort$/, async route => {
    discarded = route.request().postDataJSON()
    drafts = []
    await route.fulfill({ json: { aborted: true } })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:proposal-draft')))
  const title = page.getByText('An architecture draft is unfinished', { exact: true })
  await expect(title).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open chat', exact: true })).toBeVisible()
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Your code and current map will be kept.')
    await dialog.accept()
  })
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
  await expect.poll(() => discarded).toEqual({ workspaceId: 'demo' })
  await expect(title).toHaveCount(0)
})

/** Where a node sits on the canvas, in flow coordinates: unlike its screen
 * box, it does not change when the camera settles or pans. */
async function flowPosition(node: Locator) {
  return node.evaluate(element => {
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec((element as HTMLElement).style.transform)
    return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: NaN, y: NaN }
  })
}

/** Drags a system by its header once the camera has stopped, so the gesture
 * lands where it was aimed. */
async function dragSystem(system: Locator) {
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  const box = (await system.boundingBox())!
  await page.mouse.move(box.x + 24, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x + 54, box.y + 40, { steps: 12 })
  await page.mouse.up()
}

test('Edit → Undo puts a moved system back, and Redo moves it again', async () => {
  const system = page.locator('.react-flow__node[data-id="sys_mcp"]')
  await expect(system).toBeVisible()
  const start = await flowPosition(system)
  await dragSystem(system)
  await expect.poll(async () => (await flowPosition(system)).x - start.x).toBeGreaterThan(15)
  const moved = await flowPosition(system)
  // The move is undoable once saved, which can trail the drop on a slow runner.
  await page.waitForFunction(() => (window as unknown as { __ambioCanUndo: () => boolean }).__ambioCanUndo())
  await page.keyboard.press('ControlOrMeta+Z')
  await expect.poll(async () => Math.abs((await flowPosition(system)).x - start.x)).toBeLessThan(1)
  await expect.poll(async () => Math.abs((await flowPosition(system)).y - start.y)).toBeLessThan(1)
  await page.waitForFunction(() => (window as unknown as { __ambioCanRedo: () => boolean }).__ambioCanRedo())
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect.poll(async () => Math.abs((await flowPosition(system)).x - moved.x)).toBeLessThan(1)
  await expect.poll(async () => Math.abs((await flowPosition(system)).y - moved.y)).toBeLessThan(1)
})

test('Split System… draws the split on a new sheet', async () => {
  let imported: { markdown?: string } | null = null
  await page.route(/\/api\/sheet-import$/, async route => {
    imported = route.request().postDataJSON()
    await route.fulfill({ json: {
      sheet: { id: 'sheet_runtime', workspaceId: 'demo', name: 'Runtime Draft', purpose: '', kind: 'structure',
        folder: '', createdBy: 'user', revision: 1, createdAt: 1, updatedAt: 1 },
      warnings: [],
    } })
  })
  await page.locator('.react-flow__node[data-id="sys_mcp"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Split System…' }).click()
  await expect.poll(() => imported?.markdown).toMatch(/^# Split MCP Server\n/)
  expect(imported!.markdown).toContain('- system `MCP Server: first part`')
  await expect(page.getByText('Split MCP Server drawn on a sheet')).toBeVisible()
})

test('a placed system stays put when files arrive and other systems are renamed', async () => {
  const system = page.locator('.react-flow__node[data-id="sys_mcp"]')
  await expect(system).toBeVisible()
  const start = await flowPosition(system)
  await dragSystem(system)
  await expect.poll(async () => (await flowPosition(system)).x - start.x).toBeGreaterThan(15)
  await page.waitForTimeout(400)
  const placed = await flowPosition(system)

  // What indexing does: a new file appears in another system, a system is
  // renamed, and the snapshot arrives again with fresh objects.
  await page.evaluate(() => {
    const store = (window as any).__ambioGraphStore
    const state = store.getState()
    store.setState({
      files: [...state.files.map((file: object) => ({ ...file })), {
        ...state.files[0], id: 'file_new', relPath: 'src/shared/newHelper.ts', path: '/ambio/src/shared/newHelper.ts', systemId: 'sys_shared',
      }],
      systems: state.systems.map((item: { id: string; name: string }) => ({ ...item, name: item.id === 'sys_canvas' ? 'Canvas' : item.name })),
    })
  })
  await page.waitForTimeout(600)
  const after = await flowPosition(system)
  expect(Math.abs(after.x - placed.x)).toBeLessThan(1)
  expect(Math.abs(after.y - placed.y)).toBeLessThan(1)
})

test('Delete on a sheet proposes removing live code, listed and restorable', async () => {
  let restored = false
  page.on('request', request => {
    if (request.url().includes('/removals/sys_shared') && request.method() === 'DELETE') restored = true
  })
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 900, y: 600 } })
  await page.getByRole('menuitem', { name: 'New System Here…' }).click()
  await expect(page.locator('.react-flow__node[data-id^="planned:"]').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('.react-flow__pane').click({ position: { x: 420, y: 420 } })
  // New System Here fits its new card. Reach the other system through the
  // normal navigation path before testing its removal, rather than clicking
  // a node that is correctly outside the camera after that fit.
  await page.keyboard.press('ControlOrMeta+K')
  await page.getByRole('textbox', { name: 'Search the map' }).fill('Shared Types')
  await page.getByRole('option').filter({ hasText: 'Shared Types' }).first().click()
  await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
  const system = page.locator('.react-flow__node[data-id="sys_shared"]')
  await system.click({ position: { x: 10, y: 10 } })
  await page.keyboard.press('Delete')
  await expect(page.getByText(/proposed for removal/).first()).toBeVisible()
  await expect(system).toBeHidden()
  const removed = page.getByLabel('Removed on this sheet')
  await expect(removed).toContainText('sys_shared')
  await removed.getByRole('button', { name: /^Restore / }).click()
  await expect.poll(() => restored).toBe(true)
  await expect(system).toBeVisible()
})

test('a map change the code disagrees with offers the work order that makes it match', async () => {
  await page.route(/\/api\/architecture\/edits$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      changes: [{ op: 'assign', changed: true, eventIds: [7] }],
      codeFit: [{
        kind: 'folder', fileId: 'file_canvas', filePath: 'src/renderer/canvas/AmbioCanvas.tsx',
        systemId: 'sys_shared', systemName: 'Shared',
        summary: 'AmbioCanvas.tsx belongs to Shared, but the rest of Shared is in src/shared/',
        ask: 'Move src/renderer/canvas/AmbioCanvas.tsx to src/shared/AmbioCanvas.tsx and update every import of it.',
      }],
    }),
  }))
  const file = await revealFileNode('file_canvas')
  await file.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Take Out of / }).click()
  await expect(page.getByText('the rest of Shared is in src/shared/')).toBeVisible()
  await page.getByRole('button', { name: 'Make the Code Match…' }).click()
  const instruction = page.locator('textarea').first()
  await expect(instruction).toBeVisible()
  await expect(instruction).toHaveValue(/make the code match it\.[\s\S]*Move src\/renderer\/canvas\/AmbioCanvas\.tsx to src\/shared\/AmbioCanvas\.tsx/)

  // Ambio keeps the file to check, and shows the check on the sent order.
  await expect(page.getByText('Ambio checks the code afterwards')).toBeVisible()
  let sent: { codeFitFileIds?: string[]; id?: string; note?: string } | undefined
  await page.route(/\/api\/canvas\/send$/, async route => {
    sent = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...sent, workspaceId: 'demo', status: 'queued', createdAt: 5 }) })
  })
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      nextCursor: '', availableCount: 0,
      messages: sent ? [{
        id: sent.id, workspaceId: 'demo', sheetId: null, note: sent.note, selection: '[]', changeSummary: '',
        sheetContext: '', buildSpec: '', status: 'answered', createdAt: 5,
        codeChecks: [{
          state: 'agrees', now: 'src/shared/AmbioCanvas.tsx now lives with the rest of Shared',
          sent: { kind: 'folder', fileId: 'file_canvas', filePath: 'src/renderer/canvas/AmbioCanvas.tsx', systemId: 'sys_shared', systemName: 'Shared', summary: '', ask: '' },
        }],
      }] : [],
    }),
  }))
  await instruction.press('Enter')
  await expect.poll(() => sent?.codeFitFileIds).toEqual(['file_canvas'])
  await expect(page.getByText('Ambio checked the code: it now matches the map.')).toBeVisible()
})

test('the inbox is a conversation: follow-ups stay together and other conversations are a menu away', async () => {
  const turn = (id: string, note: string, status: string, extra = {}) => ({
    id, workspaceId: 'demo', sheetId: null, note, selection: '[]', changeSummary: '',
    sheetContext: '', buildSpec: '', status, createdAt: 5, deliveredTo: null, answerAnnotationId: null, ...extra,
  })
  const messages = [
    turn('old', 'Split the payments module', 'answered', { reply: { agent: 'Codex', body: 'Done.', createdAt: 6 } }),
    turn('q1', 'Where is retry handled?', 'answered', { threadId: 'q1', mode: 'ask', createdAt: 10, reply: { agent: 'Codex', body: 'In the queue worker.', createdAt: 11 } }),
    turn('q2', 'Add a retry queue', 'queued', { threadId: 'q1', mode: 'build', createdAt: 12 }),
  ]
  let cancelled = ''
  await page.route(/\/api\/canvas\/cancel$/, async route => {
    cancelled = route.request().postDataJSON().msgId
    messages[2] = { ...messages[2], status: 'cancelled' }
    await route.fulfill({ json: {} })
  })
  let sent: { threadId?: string; mode?: string; note?: string } | undefined
  await page.route(/\/api\/canvas\/send$/, async route => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { ...sent, workspaceId: 'demo', status: 'queued', createdAt: 20 } })
  })
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({ json: { nextCursor: '', availableCount: 1, messages: [...messages].reverse() } }))
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const inbox = page.getByRole('complementary', { name: 'Agent inbox' })

  // The most recent conversation is open, with both of its turns and what kind each was.
  await expect(inbox.getByRole('button', { name: 'Conversation: Where is retry handled?' })).toBeVisible()
  await expect(inbox.locator('.ambio-inbox__message')).toHaveCount(2)
  await expect(inbox.locator('.ambio-inbox__turn-mode')).toHaveText(['Ask', 'Build'])
  await expect(inbox).not.toContainText('Split the payments module')

  // A turn still waiting holds the message box; Stop withdraws it, and a follow-up continues the conversation.
  await expect(inbox.getByRole('textbox', { name: 'Instruction for your agent' })).toBeDisabled()
  await inbox.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => cancelled).toBe('q2')
  await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Now add a test for it')
  await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).press('Enter')
  await expect.poll(() => sent?.threadId).toBe('q1')

  // The other conversation is in the menu, with where it stands; the title
  // says an answer is waiting elsewhere, and the menu can show only those.
  await expect(inbox.getByRole('button', { name: /^Conversation:/ })).toContainText('1 new reply')
  await inbox.getByRole('button', { name: /^Conversation:/ }).click()
  const menu = inbox.getByRole('menu', { name: 'Conversations' })
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2)
  await expect(menu.getByRole('menuitemradio').nth(1)).toContainText('Needs review')
  await menu.getByText('Filter conversations', { exact: true }).click()
  const stages = menu.getByRole('group', { name: 'Show conversations' })
  // The stage filters sit in one row of chips, and the open title stays readable.
  const chips = await stages.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top))
  expect(new Set(chips.map(Math.round)).size).toBe(1)
  const title = inbox.getByRole('button', { name: /^Conversation:/ }).locator('h2')
  expect(await title.evaluate(element => getComputedStyle(element).color)).toBe('rgb(244, 247, 242)')
  await page.screenshot({ path: 'test-results/conversation-menu.png' })
  // With its waiting build stopped, this conversation's latest turn is an answered
  // question: answered, not waiting for review. Only the other conversation's build is.
  await expect(stages.getByRole('button', { name: 'Answered 1' })).toBeVisible()
  await stages.getByRole('button', { name: 'To review 1' }).click()
  await expect(menu.getByRole('menuitemradio')).toHaveCount(1)
  await stages.getByRole('button', { name: 'All 2' }).click()
  await menu.getByRole('menuitemradio').nth(1).click()
  await expect(inbox).toContainText('Split the payments module')
  await expect(inbox).not.toContainText('Add a retry queue')

  // A new conversation starts empty and sends without a thread to continue.
  await inbox.getByRole('button', { name: 'New conversation' }).click()
  await expect(inbox.locator('.ambio-inbox__message')).toHaveCount(0)
  sent = undefined
  await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Something unrelated')
  await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).press('Enter')
  await expect.poll(() => sent?.note).toBe('Something unrelated')
  expect(sent?.threadId).toBeUndefined()
})

test('an agent\'s question appears on the turn it is working on and is answered in one press', async () => {
  const turn = { id: 'build-1', workspaceId: 'demo', sheetId: null, note: 'Add the retry queue', selection: '[]', changeSummary: '',
    sheetContext: '', buildSpec: '', status: 'delivered', leaseExpiresAt: Date.now() + 600_000, agent: 'claude-code', createdAt: 5,
    deliveredTo: 'conn', answerAnnotationId: null, threadId: 'build-1', mode: 'build' }
  const question = { id: 'perm-1', workspaceId: 'demo', messageId: 'build-1', hostId: 'claude-code', title: 'Use Bash', detail: 'npm install bullmq',
    kind: 'execute', askedAt: Date.now(), expiresAt: Date.now() + 100_000 }
  let pending = [question]
  let decided: { id?: string; decision?: string } | undefined
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({ json: { nextCursor: '', availableCount: 0, messages: [turn] } }))
  await page.route(/\/api\/agent\/permission\?/, route => route.fulfill({ json: { requests: pending } }))
  await page.route(/\/api\/agent\/permission\/decide$/, async route => {
    decided = route.request().postDataJSON()
    pending = []
    await route.fulfill({ json: decided })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
  const card = inbox.getByRole('group', { name: 'Permission request: Use Bash' })
  await expect(card).toContainText('npm install bullmq')
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect.poll(() => decided).toEqual({ workspaceId: 'demo', id: 'perm-1', decision: 'allow' })
  await expect(card).toHaveCount(0)
})

test('asking a question tells the agent not to change anything', async () => {
  let sent: { note?: string } | undefined
  await page.route(/\/api\/canvas\/send$/, async route => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { ...sent, workspaceId: 'demo', status: 'queued', createdAt: 5 } })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
  await inbox.getByRole('button', { name: /^Request type:/ }).click()
  await inbox.getByRole('menuitemradio', { name: 'Ask' }).click()
  await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Why does checkout call the MCP server?')
  await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).press('Enter')
  await expect.poll(() => sent?.note).toMatch(/^This is a question\. .*\n\nWhy does checkout call the MCP server\?$/s)
})

test('New System Here draws a planned system on a new sheet, ready to send', async () => {
  let planned: { kind?: string } | undefined
  page.on('request', request => {
    if (request.url().includes('/api/sheets/sheet_new/planned') && request.method() === 'POST') {
      planned = request.postDataJSON() as { kind?: string }
    }
  })
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 900, y: 600 } })
  await page.getByRole('menuitem', { name: 'New System Here…' }).click()
  await expect.poll(() => planned?.kind).toBe('system')
})

test('wheel zoom continues over revealed file content through 100x', async () => {
  const node = await revealFileNode('file_canvas')
  await node.click({ position: { x: 12, y: 12 }, force: true })
  await expect(node).toHaveClass(/selected/)
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 50; i += 1) {
    await page.mouse.wheel(0, -100)
  }

  await expect.poll(canvasZoom, { timeout: 15_000 }).toBeGreaterThan(99.99)
  await expect(node).toBeVisible()
  await expectResizeChrome('file_canvas')

  // Selection mode is an interaction policy only. Toggling it must not
  // rebuild semantic-zoom visibility or permanently remove the current frame.
  const nodeCount = await page.locator('.react-flow__node').count()
  const beforeToggle = await node.boundingBox()
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.getByRole('button', { name: 'Lasso Select' }).click()
    await expect(page.getByRole('button', { name: 'Lasso Active' })).toBeVisible()
    await page.getByRole('button', { name: 'Lasso Active' }).click()
    await expect(page.getByRole('button', { name: 'Lasso Select' })).toBeVisible()
  }
  await expect(page.locator('.react-flow__node')).toHaveCount(nodeCount)
  await expect(node).toBeVisible()
  await expect(node).toHaveCSS('pointer-events', 'all')
  const afterToggle = await node.boundingBox()
  expect(afterToggle?.x).toBeCloseTo(beforeToggle!.x, 1)
  expect(afterToggle?.y).toBeCloseTo(beforeToggle!.y, 1)
  expect(afterToggle?.width).toBeCloseTo(beforeToggle!.width, 1)
  expect(afterToggle?.height).toBeCloseTo(beforeToggle!.height, 1)
  await expectResizeChrome('file_canvas')
})

test('setup maps a codebase with an agent Ambio runs and follows it live', async () => {
  // Last in this file: it replaces the delivery handlers for the rest of the app's life.
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as unknown as { delivered: Array<{ workspaceId: string; messageId: string; hostId: string }> }
    state.delivered = []
    ipcMain.removeHandler('agent:delivery-hosts')
    ipcMain.handle('agent:delivery-hosts', () => [
      { id: 'claude-code', label: 'Claude Code CLI', route: 'run', available: true, detail: '' },
      { id: 'antigravity-cli', label: 'Antigravity CLI', route: 'run', available: true, detail: '' },
    ])
    ipcMain.removeHandler('agent:models')
    ipcMain.handle('agent:models', () => [{ id: 'fable', label: 'Fable (latest)' }, { id: 'opus', label: 'Opus (latest)' }])
    ipcMain.removeHandler('agent:deliver')
    ipcMain.handle('agent:deliver', (_event, request) => { state.delivered.push(request); return { detail: 'Agent launched.' } })
    ipcMain.removeHandler('agent:delivery-runs')
    ipcMain.handle('agent:delivery-runs', () => state.delivered.map(request => ({ key: 'mapping-run', workspaceId: request.workspaceId, messageId: request.messageId, revision: 'initial', hostId: request.hostId, rootPath: '', state: 'running', detail: 'Agent launched.', logPath: '', startedAt: 1 })))
    ipcMain.removeHandler('agent:delivery-events')
    // Events arrive while the run goes on; the cursor is how many were already read.
    const started = Date.now()
    const events = [{ at: 5, kind: 'tool', text: 'Ambio · get_architecture · overview' }, { at: 6, kind: 'tool', text: 'Read · src/app.ts' }]
    ipcMain.handle('agent:delivery-events', (_event, _workspace, _key, after: number) => events.slice(0, Date.now() - started > 2500 ? 2 : 1).slice(after))
  })
  const mappingAttempt = { id: 'mapping-ui', workspaceId: 'demo', rootId: 'root_demo', state: 'mapping', proposalId: '', startedAt: Date.now(), endedAt: 0, systemCount: 0 }
  await page.route(/\/api\/mapping-attempts(?:\?|$)/, route => route.fulfill({ json: route.request().method() === 'POST' ? { attempt: mappingAttempt, token: 'fixture' } : [mappingAttempt] }))
  await page.route(/\/api\/mapping-attempts\/mapping-ui\?/, route => route.fulfill({ json: mappingAttempt }))
  // A historical proposal must never complete this new mapping attempt.
  await page.route(/\/api\/architecture-proposals\?/, route => route.fulfill({ json: [{ id: 'unrelated-proposal' }] }))
  const setupUrl = new URL(page.url())
  setupUrl.searchParams.set('connect', '1')
  setupUrl.searchParams.delete('blank')
  await page.goto(setupUrl.toString())
  await expect(page.getByRole('heading', { name: 'Choose who maps this project' })).toBeVisible()
  const agents = page.getByRole('radiogroup', { name: 'Agents' })
  const sidebar = page.locator('.ambio-choose__sidebar')
  const claude = agents.getByRole('radio', { name: /Claude Code CLI/ })
  await expect(claude).toHaveAttribute('aria-checked', 'true')
  // Antigravity's CLI only reaches Ambio through Antigravity's own settings:
  // adding Ambio there is part of mapping, said plainly, not an option.
  await agents.getByRole('radio', { name: /Antigravity CLI/ }).click()
  await expect(sidebar.locator('.ambio-choose__required')).toContainText('Ambio adds itself to Antigravity first')
  await expect(sidebar.locator('.ambio-choose__required')).toContainText('mcp_config.json')
  await expect(sidebar.getByRole('checkbox')).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: 'Add Ambio and map with Antigravity CLI' })).toBeVisible()
  await expect.poll(() => sidebar.evaluate(panel => getComputedStyle(panel).transform)).toBe('none')
  await page.screenshot({ path: 'test-results/setup-antigravity-required.png' })
  await claude.click()
  // Ambio chat is offered even before a model service exists, and leads to setting one up.
  await agents.getByRole('radio', { name: /Ambio chat/ }).click()
  await expect(sidebar.getByRole('button', { name: 'Connect Ambio chat' })).toBeVisible()
  await claude.click()
  // Adding Ambio for the user's own sessions starts on, and can be turned off.
  const sessions = sidebar.getByRole('checkbox', { name: /Also add Ambio to your own/ })
  if (await sessions.count()) {
    await expect(sessions).toBeChecked()
    const info = sidebar.getByRole('button', { name: /About adding Ambio to your own/ })
    const controlsBefore = await sidebar.locator('.ambio-choose__run-settings').boundingBox()
    await info.click()
    const help = sidebar.getByRole('region', { name: 'About your own CLI sessions' })
    await expect(help).toBeVisible()
    await expect(help).toContainText('Runs started here work without this option.')
    expect(await sidebar.locator('.ambio-choose__run-settings').boundingBox()).toEqual(controlsBefore)
    expect((await help.boundingBox())!.y + (await help.boundingBox())!.height).toBeLessThan((await info.boundingBox())!.y)
    await page.screenshot({ path: 'test-results/setup-cli-info.png' })
    await expect(sessions).toBeChecked()
    await info.click()
    await expect(help).toBeHidden()
    await info.click()
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden()
    await expect(sidebar).toBeVisible()
    await expect(info).toBeFocused()
    await info.click()
    await sidebar.getByRole('heading').click()
    await expect(help).toBeHidden()
    await sessions.uncheck()
  }
  // The mascot follows the chosen agent: one Ambio runs is ready without connecting.
  const caption = page.locator('.ambio-connect__mascot p[aria-live]')
  await expect(caption).toHaveText('Found - Claude Code CLI. Sign in to this CLI before mapping.')
  await page.screenshot({ path: 'test-results/setup-choose-agent.png' })
  // The model is chosen right beside the button that starts the run.
  await sidebar.getByRole('combobox', { name: 'Model' }).selectOption('opus')
  await sidebar.getByRole('button', { name: 'Map with Claude Code CLI' }).click()
  const activity = page.getByRole('region', { name: 'Mapping activity' })
  await expect(activity).toContainText('Claude Code CLI is mapping the project')
  await expect(activity).toContainText('get_architecture')
  // A later event shows up without leaving the step.
  await expect(activity).toContainText('Read · src/app.ts', { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Claude Code CLI is mapping this project' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Agent setup steps' }).getByRole('tab')).toHaveCount(3)
  await expect(page.getByRole('tablist', { name: 'Agent setup steps' })).not.toContainText('restart', { ignoreCase: true })
  await expect(page.locator('.ambio-connect__mascot .ambio-final-gemini')).toHaveAttribute('data-state', 'connected')
  await expect(caption).toHaveText('Working - Claude Code CLI is mapping the project.')
  const delivered = await app.evaluate(() => (globalThis as unknown as { delivered: Array<{ hostId: string; model?: string }> }).delivered)
  expect(delivered.map(request => [request.hostId, request.model])).toEqual([['claude-code', 'opus']])
  await page.screenshot({ path: 'test-results/setup-map-with-agent.png' })
  await expect(page.getByRole('tab', { name: 'Map project' })).toHaveAttribute('aria-selected', 'true')
  mappingAttempt.state = 'submitted'
  mappingAttempt.proposalId = 'mapping-ui'
  mappingAttempt.systemCount = 7
  await expect(activity).toContainText('Map submitted — closing the agent session')
  await expect(activity).toContainText('7 systems')
  await expect(page.getByRole('tab', { name: 'Map project' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Review architecture' })).toHaveCount(0)
  mappingAttempt.endedAt = Date.now()
  await expect(page.getByRole('tab', { name: /Review$/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Your architecture is ready' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review architecture' })).toBeVisible()
  await page.screenshot({ path: 'test-results/setup-mapping-settled.png' })
  await page.getByRole('tab', { name: /Map project/ }).click()
  await expect(page.getByRole('heading', { name: 'Project mapping is complete' })).toBeVisible()
  await expect(activity).toContainText('finished its run')
  await page.getByRole('tab', { name: /Review$/ }).click()
  const mappedProposal = {
    id: 'mapping-ui', workspaceId: 'demo', currentRevision: 1,
    round: { rationale: 'This exact mapping attempt.', systems: [{ systemKey: 'mapping', name: 'Mapped Responsibility', description: 'Owns the canvas.', parentRefType: 'scope', parentRefId: null, depth: 0, decision: 'pending', fileCount: 1, affectedFileCount: 1 }], memberships: [{ id: 'mapped-file', fileId: 'file_canvas', rootId: 'root_demo', filePath: 'src/renderer/canvas/AmbioCanvas.tsx', targetSystemKey: 'mapping', disposition: 'assign' }], layouts: [] },
  }
  await page.route(/\/api\/architecture-proposals\/mapping-ui\?/, route => route.fulfill({ json: mappedProposal }))
  await page.getByRole('button', { name: 'Review architecture' }).click()
  // Reopen Review to prove that its pin survives a renderer restart even
  // when another proposal is now first in the workspace list.
  setupUrl.searchParams.delete('connect')
  setupUrl.searchParams.set('review', '1')
  await page.goto(setupUrl.toString())
  await expect(page.getByRole('heading', { name: 'Review the architecture your agent found' })).toBeVisible()
  await expect(page.locator('.ambio-review__panel')).toContainText('Mapped Responsibility')
  await expect(page.locator('.ambio-review__panel')).toContainText('This exact mapping attempt.')
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('ambio:setup-mapping:')) localStorage.removeItem(key) })
})

test('an agent reply reads as formatted Markdown, with project files as chips', async () => {
  const { root, file } = await page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    return { root: state.currentProject.rootPath as string, file: state.files[0].relPath.replace(/\\/g, '/') as string }
  })
  const href = `file:///${root.replace(/\\/g, '/')}/${file}#L5-L9`
  // What agents wrote: a "\b" decoded into a backspace, a one-backtick fence,
  // file links, an inline project path, emphasis, a rule and a table.
  const body = [
    '## Analysis', '', `It re-exports \u0008uild_query. *Only* the **facade** changes.`, '',
    '`python', 'from .query_builder import build_query', '`', '',
    `- Consumer: [${file}](${href})`, `- Also see \`${file}\``, `- Written plainly: ${file}.`, '', '---', '',
    '| Symbol | Breaks |', '| --- | --- |', '| build_query | executor |',
  ].join('\n')
  const reply = { id: 'md-1', workspaceId: 'demo', sheetId: null, note: 'What depends on this?', selection: '[]', changeSummary: '', sheetContext: '', buildSpec: '',
    status: 'answered', mode: 'ask', threadId: 'md-1', createdAt: 50, deliveredTo: null, answerAnnotationId: null, reply: { agent: 'antigravity', body, createdAt: 51 } }
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({ json: { nextCursor: '', availableCount: 1, messages: [reply] } }))
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const prose = page.getByRole('complementary', { name: 'Agent inbox' }).locator('.ambio-inbox__reply .ambio-inbox__prose')
  await expect(prose.locator('h4')).toHaveText('Analysis')
  await expect(prose).toContainText('It re-exports build_query.')
  await expect(prose).not.toContainText('\u0008')
  await expect(prose.locator('em')).toHaveText('Only')
  await expect(prose.locator('strong')).toHaveText('facade')
  await expect(prose.locator('.ambio-inbox__code')).toContainText('from .query_builder import build_query')
  await expect(prose.locator('.ambio-inbox__code')).toContainText('python')
  await expect(prose.locator('.ambio-inbox__file-link')).toHaveText([`${file}:5–9`, file, file])
  await expect(prose).not.toContainText('file:///')
  await expect(prose.locator('hr')).toHaveCount(1)
  await expect(prose.locator('table td')).toHaveText(['build_query', 'executor'])
  await page.screenshot({ path: 'test-results/agent-markdown.png' })
  // A chip with a line opens the file's source there.
  await page.route(/\/api\/files\/[^/]+\/source\?/, route => route.fulfill({ json: { relPath: file, language: 'plaintext', content: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') } }))
  await prose.locator('.ambio-inbox__file-link').first().click()
  const source = page.getByRole('dialog', { name: `${file} in ${file}` })
  await expect(source.locator('.source-preview-location')).toHaveText('lines 5–9')
  await expect(source.locator('.source-preview-line-highlighted')).toHaveCount(5)
  await expect(source.locator('.source-preview-line-highlighted').first()).toContainText('line 5')
  await source.getByRole('button', { name: 'Close source preview' }).click()
  await expect(source).toHaveCount(0)
  await page.unroute(/\/api\/files\/[^/]+\/source\?/)
  // A chip without one selects its file and brings the map to it.
  const viewport = page.locator('.react-flow__viewport')
  const before = await viewport.getAttribute('style')
  await prose.locator('.ambio-inbox__file-link').nth(1).click()
  await expect.poll(() => page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    return state.selectedNodeId === state.files[0].id
  })).toBe(true)
  await expect.poll(() => viewport.getAttribute('style'), { timeout: 5_000 }).not.toBe(before)
  // It lands in the middle of the map you can see, not under the open panel.
  await expect.poll(() => page.evaluate(() => {
    const id = (window as any).__ambioGraphStore.getState().files[0].id
    const card = document.querySelector(`.react-flow__node[data-id="${id}"]`)!.getBoundingClientRect()
    const map = document.querySelector('.react-flow')!.getBoundingClientRect()
    const panel = document.querySelector('.ambio-inbox')!.getBoundingClientRect()
    return Math.abs(map.right - panel.left) < 2 && Math.abs((card.left + card.right) / 2 - (map.left + map.right) / 2) < 8
  }), { timeout: 5_000 }).toBe(true)
  await page.unroute(/\/api\/canvas\/history\?/)
})

test('a function an agent names opens at its definition; an ambiguous name stays code', async () => {
  const { file, fileId } = await page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    return { file: state.files[0].relPath.replace(/\\/g, '/') as string, fileId: state.files[0].id as string }
  })
  const hit = (id: string, name: string, kind: string, lineStart: number, lineEnd: number) => ({ id, fileId, name, kind, lineStart, lineEnd, relPath: file })
  await page.route(/\/api\/symbols\/search\?/, route => {
    const name = new URL(route.request().url()).searchParams.get('q')
    const symbols = name === 'evaluate_scene' ? [hit('s1', 'evaluate_scene', 'function', 3, 6)]
      : name === 'update' ? [hit('s2', 'update', 'method', 8, 9), hit('s3', 'update', 'method', 10, 11)] : []
    return route.fulfill({ json: { symbols } })
  })
  await page.route(/\/api\/files\/[^/]+\/source\?/, route => route.fulfill({ json: { fileId, relPath: file, language: 'plaintext', lineCount: 12, content: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') } }))
  const body = 'The knob is dead: `evaluate_scene()` hardcodes `0.1`, and `update` is called twice.'
  const reply = { id: 'sym-1', workspaceId: 'demo', sheetId: null, note: 'Why?', selection: '[]', changeSummary: '', sheetContext: '', buildSpec: '',
    status: 'answered', mode: 'ask', threadId: 'sym-1', createdAt: 60, deliveredTo: null, answerAnnotationId: null, reply: { agent: 'claude-code', body, createdAt: 61 } }
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({ json: { nextCursor: '', availableCount: 1, messages: [reply] } }))
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const prose = page.getByRole('complementary', { name: 'Agent inbox' }).locator('.ambio-inbox__reply .ambio-inbox__prose').filter({ hasText: 'The knob is dead' })
  await expect(prose.locator('.ambio-inbox__file-link')).toHaveText(['evaluate_scene()'])
  await expect(prose.locator('code')).toHaveText(['0.1', 'update'])
  await prose.getByRole('button', { name: 'evaluate_scene()' }).click()
  const source = page.getByRole('dialog', { name: `evaluate_scene in ${file}` })
  await expect(source.locator('.source-preview-location')).toHaveText('function evaluate_scene · lines 3–6')
  await expect(source.locator('.source-preview-line-highlighted')).toHaveCount(4)
  await source.getByRole('button', { name: 'Close source preview' }).click()
  await expect(source).toHaveCount(0)
  await page.unroute(/\/api\/canvas\/history\?/)
  await page.unroute(/\/api\/files\/[^/]+\/source\?/)
  await page.unroute(/\/api\/symbols\/search\?/)
})

test('the editor marks what changed since the commit, whose change it is, and can revert it', async () => {
  const { file, fileId } = await page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    return { file: state.files[0].relPath.replace(/\\/g, '/') as string, fileId: state.files[0].id as string }
  })
  const content = 'speed = read()\nmoving = speed > config.limit\nwait()\nstop()\nlog()\n'
  await page.route(/\/api\/files\/[^/]+\/source\?/, route => route.fulfill({ json: { fileId, relPath: file, language: 'python', lineCount: 4, content, hash: 'h1', editable: true } }))
  await page.route(/\/api\/files\/[^/]+\/committed\?/, route => route.fulfill({ json: {
    repository: true, tracked: true, content: 'speed = read()\nmoving = speed > 0.1\nwait()\nlog()\n',
    authors: [{ actor: 'agent', agent: 'codex', goal: 'Fix threshold', lastAt: Date.now() - 4 * 60_000, saves: 2 }],
  } }))
  const reply = { id: 'marks-1', workspaceId: 'demo', sheetId: null, note: 'What changed?', selection: '[]', changeSummary: '', sheetContext: '', buildSpec: '',
    status: 'answered', mode: 'ask', threadId: 'marks-1', createdAt: 80, deliveredTo: null, answerAnnotationId: null, reply: { agent: 'codex', body: `Codex changed \`${file}:2\`.`, createdAt: 81 } }
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({ json: { nextCursor: '', availableCount: 1, messages: [reply] } }))
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const prose = page.getByRole('complementary', { name: 'Agent inbox' }).locator('.ambio-inbox__reply .ambio-inbox__prose').filter({ hasText: 'Codex changed' })
  await prose.getByRole('button', { name: `${file}:2` }).click()
  const dialog = page.getByRole('dialog', { name: `${file} in ${file}` })

  // Codex changed line 2 and added line 4, so both are marked as an agent's.
  const marks = dialog.locator('.cm-change-mark')
  await expect(marks).toHaveCount(2)
  await expect(dialog.locator('.cm-change-modified.cm-change-by-agent')).toHaveAttribute('title', /Changed\. Changed since the last commit by Codex \("Fix threshold"\), 4 min ago/)
  await expect(dialog.locator('.cm-change-added.cm-change-by-agent')).toHaveCount(1)
  await expect(dialog.locator('.cm-overview-mark.cm-overview-by-agent')).toHaveCount(2)
  await expect(dialog.locator('.cm-overview-target')).toHaveCount(1)
  // On the scrollbar a change stands out over the pointed-at lines, which may span a whole function.
  const lanes = await dialog.evaluate(element => {
    const box = (selector: string) => {
      const mark = element.querySelector(selector)!
      return { width: mark.getBoundingClientRect().width, height: mark.getBoundingClientRect().height, z: Number(getComputedStyle(mark).zIndex) }
    }
    return { target: box('.cm-overview-target'), change: box('.cm-overview-modified') }
  })
  expect(lanes.change.width).toBeGreaterThan(lanes.target.width * 3)
  expect(lanes.change.height).toBeGreaterThanOrEqual(4)
  expect(lanes.change.z).toBeGreaterThan(lanes.target.z)

  // A line the person types is theirs; the agent's line beside it stays the agent's.
  await dialog.locator('.cm-line', { hasText: 'log()' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' # mine')
  await expect(dialog.locator('.cm-change-by-mine')).toHaveCount(1)
  await expect(dialog.locator('.cm-change-by-mine')).toHaveAttribute('title', /Changed by you in this editor/)
  await expect(dialog.locator('.cm-change-by-agent')).toHaveCount(2)
  await page.screenshot({ path: 'test-results/source-editor-changes.png' })

  // Alt+F5 steps to the next change; clicking a mark shows the committed lines, and Revert puts them back.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Alt+F5')
  await expect(dialog.locator('.cm-activeLine')).toHaveText('moving = speed > config.limit')
  await dialog.locator('.cm-change-by-agent').first().click()
  const peek = dialog.getByRole('group', { name: 'Committed lines' })
  await expect(peek).toContainText('moving = speed > 0.1')
  await peek.getByRole('button', { name: 'Revert' }).click()
  await expect(peek).toHaveCount(0)
  await expect(dialog.locator('.cm-content')).toContainText('moving = speed > 0.1')
  await expect(dialog.locator('.cm-change-mark')).toHaveCount(2)
  await expect(dialog.getByRole('img', { name: 'Unsaved changes' })).toBeVisible()

  // Right-click offers the usual editing commands and this viewer's own; Escape closes only the menu.
  await dialog.locator('.cm-line', { hasText: 'wait()' }).click({ button: 'right' })
  const codeMenu = page.getByRole('menu', { name: 'Code' })
  await expect(codeMenu.getByRole('menuitem', { name: /^Copy / }).first()).toBeDisabled()
  await expect(codeMenu.getByRole('menuitem', { name: /^Paste/ })).toBeEnabled()
  await expect(codeMenu.getByRole('menuitem', { name: /^Ask Agent About This/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(codeMenu).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await dialog.locator('.cm-line', { hasText: 'wait()' }).click({ button: 'right' })
  await codeMenu.getByRole('menuitem', { name: /^Select All/ }).click()
  await expect(dialog.locator('.source-preview-statusline')).toContainText('selected')
  await dialog.locator('.cm-line', { hasText: 'wait()' }).click({ button: 'right' })
  await expect(codeMenu.getByRole('menuitem', { name: /^Cut/ })).toBeEnabled()
  await page.screenshot({ path: 'test-results/source-editor-menu.png' })
  await page.keyboard.press('Escape')

  // Ctrl+I attaches the selected lines beside the message, leaving the text for the question; unsaved edits still ask first.
  const composer = page.getByRole('textbox', { name: 'Instruction for your agent' })
  await composer.fill('')
  await dialog.locator('.cm-line', { hasText: 'wait()' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('ControlOrMeta+I')
  await expect(dialog.getByRole('alert')).toContainText(`Save your changes to ${file}?`)
  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(composer).toHaveValue('')
  const attached = page.locator('.ambio-inbox__attachments').getByRole('button', { name: `${file}:3-4` })
  await expect(attached).toHaveAttribute('title', `Remove ${file}:3-4 from message`)
  await page.locator('.ambio-inbox__compose, .ambio-inbox form').first().screenshot({ path: 'test-results/agent-code-attachment.png' })
  await attached.click()
  await expect(attached).toHaveCount(0)
  await page.unroute(/\/api\/canvas\/history\?/)
  await page.unroute(/\/api\/files\/[^/]+\/source\?/)
  await page.unroute(/\/api\/files\/[^/]+\/committed\?/)
})

test('the editor shows where you are, follows definitions, reloads disk changes and shows the file on the map', async () => {
  const workspaceId = await page.evaluate(() => (window as any).__ambioGraphStore.getState().currentProject.id as string)
  const canvasSource = (content: string, hash: string) => ({ fileId: 'file_canvas', relPath: 'src/renderer/canvas/AmbioCanvas.tsx', language: 'tsx', lineCount: 7, content, hash, editable: true })
  const original = "import React from 'react'\n\nexport function renderCanvas() {\n  const ready = true\n  const canvas = <Canvas />\n  return ready ? canvas : null\n}\n"
  await page.route(/\/api\/files\/file_canvas\/source\?/, route => route.fulfill({ json: canvasSource(original, 'h1') }))
  await page.route(/\/api\/files\/[^/]+\/committed\?/, route => route.fulfill({ json: { repository: false, tracked: false, content: '', authors: [] } }))
  await page.route(/\/api\/symbols\/search\?/, route => {
    const name = new URL(route.request().url()).searchParams.get('q')
    return route.fulfill({ json: { symbols: name === 'Canvas' ? [{ id: 'sym_canvas', fileId: 'file_docs', name: 'Canvas', kind: 'class', lineStart: 2, lineEnd: 3, relPath: 'docs/ARCHITECTURE.md' }] : [] } })
  })
  const reply = { id: 'nav-1', workspaceId, sheetId: null, note: 'Where?', selection: '[]', changeSummary: '', sheetContext: '', buildSpec: '',
    status: 'answered', mode: 'ask', threadId: 'nav-1', createdAt: 90, deliveredTo: null, answerAnnotationId: null, reply: { agent: 'codex', body: 'See `src/renderer/canvas/AmbioCanvas.tsx:5`.', createdAt: 91 } }
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({ json: { nextCursor: '', availableCount: 1, messages: [reply] } }))
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const prose = page.getByRole('complementary', { name: 'Agent inbox' }).locator('.ambio-inbox__reply .ambio-inbox__prose').filter({ hasText: 'See' })
  await prose.getByRole('button', { name: 'src/renderer/canvas/AmbioCanvas.tsx:5' }).click()
  const dialog = page.getByRole('dialog', { name: /in src\/renderer\/canvas\/AmbioCanvas\.tsx$/ })

  // Where the cursor is: inside renderCanvas, line 5; the file indents by two spaces.
  const crumbs = dialog.getByRole('navigation', { name: 'Where the cursor is' })
  await expect(crumbs).toContainText('AmbioCanvas.tsx›renderCanvas')
  const statusLine = dialog.locator('.source-preview-statusline')
  await expect(statusLine).toContainText('Ln 5, Col 1')
  await expect(statusLine).toContainText('TSX')
  await expect(statusLine).toContainText('LF')
  await expect(statusLine).toContainText('Spaces: 2')
  await page.screenshot({ path: 'test-results/source-editor-navigation.png' })

  // Ctrl+click: a name defined in this file goes there; one defined elsewhere opens that file, and Back returns.
  await dialog.locator('.cm-line', { hasText: 'import React' }).click()
  await expect(crumbs).not.toContainText('renderCanvas')
  await dialog.locator('.cm-line', { hasText: 'export function' }).getByText('renderCanvas').click({ modifiers: ['ControlOrMeta'] })
  await expect(dialog.locator('.source-preview-notice')).toHaveText('This is where renderCanvas is defined.')
  await dialog.locator('.cm-line', { hasText: '<Canvas />' }).getByText('Canvas', { exact: true }).click({ modifiers: ['ControlOrMeta'] })
  const docs = page.getByRole('dialog', { name: 'Canvas in docs/ARCHITECTURE.md' })
  await expect(docs.locator('.source-preview-location')).toHaveText('class Canvas · lines 2–3')
  await docs.getByRole('button', { name: 'Back' }).click()
  await expect(dialog.locator('.source-preview-location')).toHaveText('line 5')
  await expect(dialog.getByRole('button', { name: 'Back' })).toHaveCount(0)

  // An agent rewrites the file: the untouched editor shows the new version without losing its place.
  await page.route(/\/api\/files\/file_canvas\/source\?/, route => route.fulfill({ json: canvasSource(original.replace('  const ready = true\n', '  const ready = isReady()\n'), 'h2') }))
  await page.evaluate(() => (window as any).__ambioGraphStore.setState((state: any) => ({ files: state.files.map((file: any) => file.id === 'file_canvas' ? { ...file } : file) })))
  await expect(dialog.locator('.cm-content')).toContainText('const ready = isReady()')
  await expect(dialog.locator('.source-preview-notice')).toHaveText('src/renderer/canvas/AmbioCanvas.tsx changed on disk; showing it now.')
  await expect(dialog.getByRole('status')).toHaveCount(0)

  // With unsaved edits, a disk change is announced at once instead of on save.
  await dialog.locator('.cm-line', { hasText: 'return ready' }).click()
  await page.keyboard.type('// mine ')
  await page.route(/\/api\/files\/file_canvas\/source\?/, route => route.fulfill({ json: canvasSource(original.replace('null', 'undefined'), 'h3') }))
  await page.evaluate(() => (window as any).__ambioGraphStore.setState((state: any) => ({ files: state.files.map((file: any) => file.id === 'file_canvas' ? { ...file } : file) })))
  await expect(dialog.getByRole('alert')).toHaveText(/AmbioCanvas\.tsx changed on disk while you were editing\./)
  await expect(dialog.getByRole('alert')).not.toContainText('Nothing was saved')
  await dialog.getByRole('button', { name: 'Use the file on disk' }).click()
  await expect(dialog.locator('.cm-content')).toContainText('return ready ? canvas : undefined')

  // Show on map closes the editor and frames the file.
  await dialog.getByRole('button', { name: 'Show on map' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore.getState().selectedNodeId)).toBe('file_canvas')

  await page.unroute(/\/api\/canvas\/history\?/)
  await page.unroute(/\/api\/files\/file_canvas\/source\?/)
  await page.unroute(/\/api\/files\/[^/]+\/committed\?/)
  await page.unroute(/\/api\/symbols\/search\?/)
})

test('unsaved edits survive the editor closing unexpectedly and are offered back', async () => {
  const workspaceId = await page.evaluate(() => (window as any).__ambioGraphStore.getState().currentProject.id as string)
  const key = `ambio.sourceDraft.${workspaceId}.file_canvas`
  await page.route(/\/api\/files\/file_canvas\/source\?/, route => route.fulfill({ json: { fileId: 'file_canvas', relPath: 'src/renderer/canvas/AmbioCanvas.tsx', language: 'tsx', lineCount: 1, content: 'const a = 1\n', hash: 'h1', editable: true } }))
  await page.route(/\/api\/files\/[^/]+\/committed\?/, route => route.fulfill({ json: { repository: false, tracked: false, content: '', authors: [] } }))
  const reply = { id: 'draft-1', workspaceId, sheetId: null, note: 'Draft', selection: '[]', changeSummary: '', sheetContext: '', buildSpec: '',
    status: 'answered', mode: 'ask', threadId: 'draft-1', createdAt: 95, deliveredTo: null, answerAnnotationId: null, reply: { agent: 'codex', body: 'Open `src/renderer/canvas/AmbioCanvas.tsx:1`.', createdAt: 96 } }
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({ json: { nextCursor: '', availableCount: 1, messages: [reply] } }))
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const chip = page.getByRole('complementary', { name: 'Agent inbox' }).locator('.ambio-inbox__reply .ambio-inbox__prose').filter({ hasText: 'Open' })
    .getByRole('button', { name: 'src/renderer/canvas/AmbioCanvas.tsx:1' })
  await chip.click()
  const dialog = page.getByRole('dialog', { name: /in src\/renderer\/canvas\/AmbioCanvas\.tsx$/ })

  // Typing keeps a draft; losing the window (simulated by dropping the viewer without asking) leaves it.
  await dialog.locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' // draft')
  await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null')?.content, key)).toBe('const a = 1 // draft\n')
  await page.keyboard.press('Escape')
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await page.evaluate(() => document.querySelector('.source-preview-backdrop')?.remove())

  await page.reload()
  await page.waitForFunction(() => (window as any).__ambioGraphStore?.getState().files.length > 0)
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  await chip.click()
  const bar = dialog.getByRole('alert')
  await expect(bar).toContainText('You have unsaved changes to src/renderer/canvas/AmbioCanvas.tsx from')
  await bar.getByRole('button', { name: 'Restore them' }).click()
  await expect(dialog.locator('.cm-content')).toHaveText('const a = 1 // draft')
  await expect(dialog.getByRole('img', { name: 'Unsaved changes' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close source preview' }).click()
  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect.poll(() => page.evaluate(k => localStorage.getItem(k), key)).toBeNull()

  await page.unroute(/\/api\/canvas\/history\?/)
  await page.unroute(/\/api\/files\/file_canvas\/source\?/)
  await page.unroute(/\/api\/files\/[^/]+\/committed\?/)
})

test('source opened from a reply can be edited, saved, and never overwrites a newer file', async () => {
  const { file, fileId } = await page.evaluate(() => {
    const state = (window as any).__ambioGraphStore.getState()
    return { file: state.files[0].relPath.replace(/\\/g, '/') as string, fileId: state.files[0].id as string }
  })
  const original = 'speed = read()\r\nmoving = speed > 0.1\r\nstop()\r\n'
  const source = (content: string, hash: string) => ({ fileId, relPath: file, language: 'python', lineCount: 3, content, hash, editable: true })
  await page.route(/\/api\/files\/[^/]+\/source\?/, route => route.fulfill({ json: source(original, 'hash-1') }))
  const saves: Array<{ content: string; baseHash: string }> = []
  let conflictNext = false
  await page.route(/\/api\/files\/[^/]+\/source$/, route => {
    const body = route.request().postDataJSON()
    saves.push(body)
    if (conflictNext) return route.fulfill({ status: 409, json: { error: 'changed', current: source('speed = read()\r\nmoving = speed > config.limit\r\nstop()\r\n', 'hash-agent') } })
    return route.fulfill({ json: source(body.content, `hash-${saves.length + 1}`) })
  })
  const reply = { id: 'edit-1', workspaceId: 'demo', sheetId: null, note: 'Fix it', selection: '[]', changeSummary: '', sheetContext: '', buildSpec: '',
    status: 'answered', mode: 'ask', threadId: 'edit-1', createdAt: 70, deliveredTo: null, answerAnnotationId: null, reply: { agent: 'codex', body: `The threshold is hardcoded at \`${file}:2\`.`, createdAt: 71 } }
  await page.route(/\/api\/canvas\/history\?/, route => route.fulfill({ json: { nextCursor: '', availableCount: 1, messages: [reply] } }))
  await page.evaluate(() => window.dispatchEvent(new Event('ambio:open-agent-dispatch')))
  const prose = page.getByRole('complementary', { name: 'Agent inbox' }).locator('.ambio-inbox__reply .ambio-inbox__prose').filter({ hasText: 'The threshold is hardcoded' })
  await prose.getByRole('button', { name: `${file}:2` }).click()
  const dialog = page.getByRole('dialog', { name: `${file} in ${file}` })
  const editor = dialog.locator('.cm-content')
  await expect(dialog.locator('.source-preview-line-highlighted')).toHaveText('moving = speed > 0.1')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
  await page.screenshot({ path: 'test-results/source-editor.png' })

  // Edit the cited line and save with the keyboard: the file's CRLF endings are kept.
  await dialog.locator('.source-preview-line-highlighted').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+ControlOrMeta+ArrowLeft')
  await page.keyboard.type('limit')
  await expect(dialog.getByRole('img', { name: 'Unsaved changes' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+S')
  await expect(dialog.getByRole('status')).toHaveText('saved')
  expect(saves).toEqual([{ workspaceId: 'demo', baseHash: 'hash-1', content: 'speed = read()\r\nmoving = speed > 0.limit\r\nstop()\r\n' }])

  // An agent wrote the file meanwhile: nothing is overwritten, and the person chooses.
  conflictNext = true
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('# mine')
  await dialog.getByRole('button', { name: 'Save' }).click()
  const bar = dialog.getByRole('alert')
  await expect(bar).toContainText('changed on disk while you were editing')
  expect(saves[1].baseHash).toBe('hash-2')
  await bar.getByRole('button', { name: 'Show differences' }).click()
  await expect(dialog.locator('.cm-deletedChunk').filter({ hasText: 'config.limit' })).toHaveCount(1)
  await page.screenshot({ path: 'test-results/source-editor-conflict.png' })
  await bar.getByRole('button', { name: 'Use the file on disk' }).click()
  await expect(bar).toHaveCount(0)
  await expect(editor).toContainText('moving = speed > config.limit')
  await expect(editor).not.toContainText('# mine')
  await expect(dialog.getByRole('status')).toHaveCount(0)

  // Closing with unsaved changes asks first.
  await editor.click()
  await page.keyboard.type('x')
  await dialog.getByRole('button', { name: 'Close source preview' }).click()
  await expect(dialog.getByRole('alert')).toContainText(`Save your changes to ${file}?`)
  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toHaveCount(0)
  expect(saves).toHaveLength(2)

  await page.unroute(/\/api\/canvas\/history\?/)
  await page.unroute(/\/api\/files\/[^/]+\/source\?/)
  await page.unroute(/\/api\/files\/[^/]+\/source$/)
})
