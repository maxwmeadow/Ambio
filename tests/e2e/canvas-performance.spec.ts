import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// Structural performance regressions are deterministic across machines. Frame
// timings belong in profiling runs, rather than machine-dependent CI limits.
for (const scenario of ['floor', 'sheet', 'proposal', 'navigation', 'fallback'] as const) {
  const mode = scenario === 'navigation' || scenario === 'fallback' ? 'floor' : scenario
  test(`${scenario} zoom avoids canvas-wide style invalidation and idle scene work`, async () => {
    test.setTimeout(90_000)
    const home = mkdtempSync(join(tmpdir(), 'ambio-canvas-perf-'))
    const appData = join(home, 'AppData', 'Roaming')
    const localAppData = join(home, 'AppData', 'Local')
    mkdirSync(appData, { recursive: true }); mkdirSync(localAppData, { recursive: true })
    const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
    let app: ElectronApplication | undefined
    try {
      app = await electron.launch({
        args: ['.'],
        env: { ...env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, AMBIO_E2E: '1', AMBIO_E2E_HOME: '1' },
      })
      const page = await app.firstWindow()
      page.on('pageerror', error => console.log('CANVAS_PAGE_ERROR', error.message))
      await page.waitForURL(/e2e=1/)
      if (scenario === 'fallback') await page.addInitScript(() => {
        Object.defineProperty(window, 'Worker', { value: class { constructor() { throw new Error('fixture: worker unavailable') } } })
      })
      await page.setViewportSize({ width: 1400, height: 900 })
      await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, route => route.fulfill({ json: [] }))
      const floorUrl = new URL(page.url()); floorUrl.searchParams.delete('home')
      await page.goto(floorUrl.toString())
      await page.waitForFunction(() => Boolean((window as any).__ambioGraphStore))
      const generatedSnapshot = await page.evaluate(count => {
        const state = (window as any).__ambioGraphStore.getState()
        const system = state.systems[0], file = state.files[0]
        const columns = Math.ceil(Math.sqrt(count * 1.4))
        const systems = Array.from({ length: count }, (_, i) => ({
          ...system, id: `perf-system-${i}`, parentId: null, depth: 0,
          name: `Subsystem ${i}`, source: 'user', positionX: (i % columns) * 660,
          positionY: Math.floor(i / columns) * 460, width: 620, height: 420,
        }))
        const files = systems.flatMap((s: any, i: number) => Array.from({ length: 6 }, (_, j) => ({
          ...file, id: `perf-file-${i}-${j}`, systemId: s.id,
          relPath: `subsystem-${i}/module-${j}.ts`, path: `/fixture/subsystem-${i}/module-${j}.ts`,
        })))
        return { workspaceId: 'demo', systems, files, infraNodes: [], dependencies: [], floorLayouts: [] }
      }, Number(process.env.AMBIO_PERF_SYSTEM_COUNT ?? (scenario === 'navigation' || scenario === 'fallback' ? 64 : 24)))
      const snapshot = process.env.AMBIO_PERF_SNAPSHOT
        ? JSON.parse(readFileSync(process.env.AMBIO_PERF_SNAPSHOT, 'utf8')) : generatedSnapshot
      const sheet = { id: 'perf-sheet', workspaceId: 'demo', name: 'Performance Draft', purpose: '',
        kind: 'structure', folder: '', createdBy: 'user', revision: 1, createdAt: 1, updatedAt: 1 }
      const sheetPayload = process.env.AMBIO_PERF_SHEET
        ? { ...JSON.parse(readFileSync(process.env.AMBIO_PERF_SHEET, 'utf8')), sheet }
        : { sheet, elements: [], annotations: [], planned: [], plannedEdges: [], layouts: [], removals: [] }
      const proposal = {
        id: 'perf-proposal', workspaceId: 'demo', currentRevision: 1,
        round: {
          systems: snapshot.systems.map(system => ({
            systemKey: system.id, name: system.name, description: '', depth: 0,
            parentRefType: 'scope', parentRefId: null, decision: 'pending', fileCount: 6, affectedFileCount: 6,
          })),
          memberships: snapshot.files.map(file => ({
            id: `membership-${file.id}`, fileId: file.id, rootId: file.rootId,
            filePath: file.relPath, targetSystemKey: file.systemId, disposition: 'assign',
          })),
          layouts: [] as any[],
        },
      }
      await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, async route => {
        const url = new URL(route.request().url())
        let json: any = []
        if (/\/api\/files\/[^/]+\/symbols$/.test(url.pathname) && (scenario === 'navigation' || scenario === 'fallback')) {
          json = Array.from({ length: 5000 }, (_, i) => ({ id: `symbol-${i}`, name: `function${i}`, kind: 'function', lineStart: i + 1, lineEnd: i + 1, exported: true }))
        }
        else if (url.pathname === '/api/sheets') json = [sheet]
        else if (url.pathname === '/api/sheets/perf-sheet') json = sheetPayload
        else if (url.pathname === '/api/architecture-proposals') json = [{ id: proposal.id }]
        else if (url.pathname === `/api/architecture-proposals/${proposal.id}`) json = proposal
        else if (url.pathname.endsWith('/layouts') && route.request().method() === 'POST') {
          proposal.round.layouts = route.request().postDataJSON().layouts
          json = proposal
        } else if (url.pathname === '/api/agent/presence') json = { connected: false, connections: [] }
        else if (url.pathname === '/api/canvas/history') json = { messages: [], availableCount: 0, nextCursor: '' }
        await route.fulfill({ json })
      })
      if (mode === 'proposal') {
        const url = new URL(page.url()); url.searchParams.set('review', '1')
        await page.goto(url.toString())
        await page.waitForFunction(() => Boolean((window as any).__ambioGraphStore))
      }
      await page.evaluate(snap => (window as any).__ambioGraphStore.getState().applySnapshot(snap), snapshot)
      const canvas = mode === 'proposal'
        ? page.locator('.ambio-review__canvas [data-ambio-canvas]').first()
        : page.locator('[data-ambio-canvas]').first()
      await expect(canvas).toBeVisible()
      if (mode === 'proposal') await expect(canvas).toHaveClass(/ambio-canvas-review-ready/)
      if (mode === 'sheet') await page.getByRole('button', { name: 'Performance Draft STR', exact: true }).click()
      await page.waitForTimeout(1600)
      if (process.env.AMBIO_PERF_PROFILE) console.log('CANVAS_INITIAL', mode, JSON.stringify(await canvas.evaluate(root => ({
        nodes: root.querySelectorAll('.react-flow__node').length,
        viewport: root.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform,
        metrics: (window as any).__ambioPerfMetrics,
      }))))
      await expect.poll(() => canvas.locator('.react-flow__node').count()).toBeGreaterThan(0)
      if (process.env.AMBIO_PERF_PROFILE) {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Performance.enable')
        if (process.env.AMBIO_PERF_CPU) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
        const before = await cdp.send('Performance.getMetrics')
        const start = await page.evaluate(() => {
          const w = window as any
          w.__frameTimes = []; w.__longTasks = []
          w.__frameRunning = true
          let previous = performance.now()
          const frame = (now: number) => { w.__frameTimes.push(now - previous); previous = now; if (w.__frameRunning) requestAnimationFrame(frame) }
          requestAnimationFrame(frame)
          w.__longObserver = new PerformanceObserver(list => w.__longTasks.push(...list.getEntries().map(e => e.duration)))
          w.__longObserver.observe({ entryTypes: ['longtask'] })
          w.__nodeMounts = {}
          w.__mountObserver = new MutationObserver(records => {
            for (const r of records) for (const added of r.addedNodes) if (added instanceof Element) {
              const nodes = [...added.querySelectorAll('.react-flow__node'), ...(added.matches('.react-flow__node') ? [added] : [])]
              for (const n of nodes) { const id = n.getAttribute('data-id')!; w.__nodeMounts[id] = (w.__nodeMounts[id] ?? 0) + 1 }
            }
          })
          w.__mountObserver.observe(document.body, { childList: true, subtree: true })
          return { ...(w.__ambioPerfMetrics) }
        })
        const bounds = (await canvas.boundingBox())!
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        for (let i = 0; i < 96; i++) {
          await page.mouse.wheel(0, Math.floor(i / 24) % 2 === 0 ? -80 : 80)
          await page.waitForTimeout(16)
          if (i % 24 === 23 && process.env.AMBIO_PERF_CPU) console.log('CANVAS_STAGE', mode, i, await canvas.evaluate(root => ({
            nodes: root.querySelectorAll('.react-flow__node').length, dom: root.querySelectorAll('*').length,
            viewport: root.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform,
          })))
        }
        await page.waitForTimeout(1000)
        const result = await page.evaluate(start => {
          const w = window as any
          w.__frameRunning = false; w.__longObserver.disconnect()
          w.__mountObserver.disconnect()
          const frames = w.__frameTimes.sort((a: number, b: number) => a - b)
          return { p50: frames[Math.floor(frames.length * .5)], p95: frames[Math.floor(frames.length * .95)], max: frames.at(-1),
            longTasks: w.__longTasks.length, dom: document.querySelectorAll('*').length,
            renders: w.__ambioPerfMetrics.canvasRenderCount - start.canvasRenderCount,
            visibilityPasses: w.__ambioPerfMetrics.zoomVisibilityPasses - start.zoomVisibilityPasses,
            sheetLayouts: w.__ambioPerfMetrics.sheetLayoutBuilds - (start.sheetLayoutBuilds ?? 0),
            workerQueries: w.__ambioPerfMetrics.workerQueries, workerFallbacks: w.__ambioPerfMetrics.workerFallbacks,
            budgetAdmissions: w.__ambioPerfMetrics.budgetAdmissions, maxBudgetBatch: w.__ambioPerfMetrics.maxBudgetBatch,
            richNodes: w.__ambioPerfMetrics.mountedRichNodes, maxSymbolRequests: w.__ambioPerfMetrics.maxSymbolRequests,
            mounts: Object.values(w.__nodeMounts).reduce((a: any, b: any) => a + b, 0),
            mostMounted: Object.values(w.__nodeMounts).sort((a: any, b: any) => b - a).slice(0, 5) }
        }, start)
        const after = await cdp.send('Performance.getMetrics')
        const metrics = Object.fromEntries(after.metrics.filter(m => ['ScriptDuration', 'TaskDuration', 'RecalcStyleDuration', 'LayoutDuration'].includes(m.name))
          .map(m => [m.name, m.value - (before.metrics.find(b => b.name === m.name)?.value ?? 0)]))
        console.log('CANVAS_PROFILE', JSON.stringify({ mode, ...result, ...metrics }))
        if (process.env.AMBIO_PERF_CPU) {
          const { profile } = await cdp.send('Profiler.stop')
          writeFileSync(`out/canvas-perf-${mode}.cpuprofile`, JSON.stringify(profile))
        }
      }
      await canvas.evaluate(root => {
        (window as any).__perfRootWrites = 0
        const observer = new MutationObserver(records => { (window as any).__perfRootWrites += records.length })
        observer.observe(root, { attributes: true, attributeFilter: ['style'] })
        ;(window as any).__perfStyleObserver = observer
        ;(window as any).__perfZoomPasses = (window as any).__ambioPerfMetrics.zoomVisibilityPasses
        ;(window as any).__perfSheetLayouts = (window as any).__ambioPerfMetrics.sheetLayoutBuilds
      })
      const box = (await canvas.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 400)
      await page.waitForTimeout(700)
      expect(await canvas.evaluate(root => root.style.getPropertyValue('--ambio-zoom'))).toBe('')
      expect(await page.evaluate(() => (window as any).__perfRootWrites)).toBe(0)
      if (mode === 'sheet') {
        expect(await page.evaluate(() => (window as any).__ambioPerfMetrics.sheetLayoutBuilds)).toBe(await page.evaluate(() => (window as any).__perfSheetLayouts))
        await page.evaluate(() => {
          const graph = (window as any).__ambioGraphStore.getState()
          graph.setSelectedNode(graph.systems[0].id)
        })
        await page.waitForTimeout(150)
        expect(await page.evaluate(() => (window as any).__ambioPerfMetrics.sheetLayoutBuilds)).toBe(await page.evaluate(() => (window as any).__perfSheetLayouts))
      }
      if (mode === 'proposal') {
        expect(await page.evaluate(() => (window as any).__ambioPerfMetrics.zoomVisibilityPasses - (window as any).__perfZoomPasses)).toBe(0)
        const renders = await page.evaluate(() => (window as any).__ambioPerfMetrics.canvasRenderCount)
        await page.evaluate(() => {
          const store = (window as any).__ambioGraphStore
          for (let i = 0; i < 20; i++) store.setState({
            nodeFx: {}, runtimeNodes: {}, relationshipFx: [], agentAttention: {}, activeWorkSessions: [],
          })
        })
        await page.waitForTimeout(100)
        expect(await page.evaluate(() => (window as any).__ambioPerfMetrics.canvasRenderCount)).toBe(renders)
      }
      if ((scenario === 'navigation' || scenario === 'fallback') && !process.env.AMBIO_PERF_SNAPSHOT) {
        const target = snapshot.files.at(-1)!
        const navigate = async (relPath: string) => {
          await page.keyboard.press('ControlOrMeta+K')
          const search = page.getByRole('textbox', { name: 'Search the map' })
          await search.fill(relPath)
          await page.getByRole('option').first().click()
        }
        const assertCentered = async (id: string) => {
          await expect.poll(() => canvas.evaluate((root, id) => {
            const node = root.querySelector(`[data-id="${id}"]`)
            if (!node) return false
            const rect = node.getBoundingClientRect(), map = root.querySelector('.react-flow')!.getBoundingClientRect()
            return rect.width > 20 && Math.abs((rect.left + rect.right - map.left - map.right) / 2) < 10 &&
              Math.abs((rect.top + rect.bottom - map.top - map.bottom) / 2) < 10
          }, id), { timeout: 8000 }).toBe(true)
        }
        // Cold flight, then supersede it with a distant destination. The newest
        // search owns the camera even when the older target was initially culled.
        const before = await page.evaluate(() => {
          const w = window as any
          w.__navigationFrames = []; w.__navigationSampling = true
          let previous = performance.now()
          const frame = (now: number) => { w.__navigationFrames.push(now - previous); previous = now; if (w.__navigationSampling) requestAnimationFrame(frame) }
          requestAnimationFrame(frame)
          return { ...w.__ambioPerfMetrics }
        })
        await navigate(snapshot.files[0].relPath)
        const mapBox = (await canvas.boundingBox())!
        await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2)
        await page.mouse.wheel(0, 80)
        await page.mouse.wheel(0, -80)
        await navigate(target.relPath)
        await assertCentered(target.id)
        await page.waitForTimeout(1100)
        const targetNode = canvas.locator(`.react-flow__node[data-id="${target.id}"]`)
        await expect(targetNode).toHaveClass(/selected/)
        const symbolList = targetNode.locator('.symbol-scroll')
        await expect.poll(() => symbolList.locator('[data-symbol-row]').count()).toBeGreaterThan(0)
        expect(await symbolList.locator('[data-symbol-row]').count()).toBeLessThan(32)
        await symbolList.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect(targetNode.getByText('function4999', { exact: true })).toBeAttached()
        expect(await symbolList.locator('[data-symbol-row]').count()).toBeLessThan(32)
        const lastSymbol = targetNode.locator('[data-symbol-row="4999"] [tabindex]')
        await lastSymbol.focus()
        await lastSymbol.press('Home')
        await expect(targetNode.locator('[data-symbol-row="0"] [tabindex]')).toBeFocused()
        const metrics = await page.evaluate(() => ({ ...(window as any).__ambioPerfMetrics, frames: (window as any).__ambioCameraFrameSummary() }))
        expect(metrics.navigationFlights).toBeGreaterThan(before.navigationFlights)
        expect(metrics.prefetchedTargets).toBeGreaterThan(before.prefetchedTargets)
        expect(metrics.maxBudgetBatch).toBeLessThanOrEqual(6)
        expect(metrics.maxSymbolRequests).toBeLessThanOrEqual(4)
        if (scenario === 'navigation') expect(metrics.workerQueries).toBeGreaterThan(0)
        else { expect(metrics.workerQueries).toBe(0); expect(metrics.workerFallbacks).toBeGreaterThan(0) }
        const navigationFrames = await page.evaluate(() => {
          const w = window as any
          w.__navigationSampling = false
          const frames = w.__navigationFrames.sort((a: number, b: number) => a - b)
          return { p95: frames[Math.floor(frames.length * .95)], max: frames.at(-1) }
        })
        console.log('CANVAS_NAVIGATION', scenario, JSON.stringify({ ...metrics, navigationFrames }))
        // Fit must use the canonical scene, including off-screen culled nodes.
        await page.keyboard.press('ControlOrMeta+0')
        await expect.poll(() => canvas.locator('.react-flow__node-system').count(), { timeout: 8000 }).toBe(snapshot.systems.length)
      }
      // Badges arriving after the camera settled still get the right zoom,
      // and a nested bin owns its camera independently of the Floor.
      await canvas.evaluate(root => {
        const badge = document.createElement('div')
        badge.className = 'ambio-living-window-rail'; badge.dataset.perfBadge = 'outer'
        root.append(badge)
        const nested = document.createElement('div'); nested.setAttribute('data-ambio-canvas', '')
        const other = document.createElement('div'); other.className = 'ambio-living-window-rail'; other.dataset.perfBadge = 'inner'
        nested.append(other); root.append(nested)
      })
      await expect.poll(() => canvas.evaluate(root => {
        const zoom = new DOMMatrixReadOnly(getComputedStyle(root.querySelector('.react-flow__viewport')!).transform).a
        const badge = root.querySelector<HTMLElement>('[data-perf-badge="outer"]')!
        return Math.abs(parseFloat(getComputedStyle(badge).scale) - Math.max(1, 1 / zoom))
      })).toBeLessThan(0.01)
      expect(await canvas.locator('[data-perf-badge="inner"]').evaluate(el => (el as HTMLElement).style.getPropertyValue('--ambio-zoom'))).toBe('')
      await page.mouse.wheel(0, -400)
      await page.waitForTimeout(700)
      await expect.poll(() => canvas.evaluate(root => {
        const zoom = new DOMMatrixReadOnly(getComputedStyle(root.querySelector('.react-flow__viewport')!).transform).a
        return Math.abs(Number(root.querySelector<HTMLElement>('[data-perf-badge="outer"]')!.style.getPropertyValue('--ambio-zoom')) - zoom)
      })).toBeLessThan(0.001)
      await canvas.evaluate(root => {
        (window as any).__perfStyleObserver.disconnect()
        root.querySelector('[data-perf-badge="outer"]')?.remove()
        root.querySelector('[data-perf-badge="inner"]')?.parentElement?.remove()
      })
    } finally {
      await app?.close()
      if (dirname(resolve(home)) === resolve(tmpdir()) && basename(home).startsWith('ambio-canvas-perf-')) rmSync(home, { recursive: true, force: true })
    }
  })
}
