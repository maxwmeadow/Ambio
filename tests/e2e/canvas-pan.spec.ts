import { canvasDenseFixture } from '../fixtures/canvasScale'
import { canvasViewportSettled } from './canvasComponentCounts'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, platform, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

for (const mode of ['floor', 'review'] as const) for (const input of ['mouse', 'wasd'] as const) {
  test(`${mode} ${input} camera pan preserves scene geometry`, async ({}, info) => {
    test.setTimeout(120000)
    const home = mkdtempSync(join(tmpdir(), 'ambio-pan-'))
    const appData = join(home, 'AppData', 'Roaming'), localData = join(home, 'AppData', 'Local')
    mkdirSync(appData, { recursive: true }); mkdirSync(localData, { recursive: true })
    const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
    let app: ElectronApplication | undefined
    try {
      app = await electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home,
        APPDATA: appData, LOCALAPPDATA: localData, AMBIO_E2E: '1', AMBIO_E2E_HOME: '1' } })
      const page = await app.firstWindow()
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      await page.waitForURL(/e2e=1/); await page.setViewportSize({ width: 1400, height: 900 })
      await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, route => route.fulfill({ json: [] }))
      const url = new URL(page.url()); url.searchParams.delete('home'); await page.goto(url.toString())
      await page.waitForFunction(() => Boolean((window as any).__ambioGraphStore))
      const templates = await page.evaluate(() => { const state = (window as any).__ambioGraphStore.getState(); return { system: state.systems[0], file: state.files[0] } })
      const snapshot = canvasDenseFixture(templates, Number(process.env.AMBIO_PAN_SYSTEMS ?? 96))
      const proposal = { id: 'pan-proposal', workspaceId: 'demo', currentRevision: 1, round: {
        systems: snapshot.systems.map(system => ({ systemKey: system.id, name: system.name, description: '', depth: 0,
          parentRefType: 'scope', parentRefId: null, decision: 'pending', fileCount: 6, affectedFileCount: 6 })),
        memberships: snapshot.files.map(file => ({ id: `membership-${file.id}`, fileId: file.id, rootId: file.rootId,
          filePath: file.relPath, targetSystemKey: file.systemId, disposition: 'assign' })), layouts: [] as any[] } }
      let layoutSaves = 0
      await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, async route => {
        const path = new URL(route.request().url()).pathname
        let json: any = []
        if (path === '/api/architecture-proposals') json = [{ id: proposal.id }]
        else if (path === `/api/architecture-proposals/${proposal.id}`) json = proposal
        else if (path.endsWith('/layouts') && route.request().method() === 'POST') {
          layoutSaves++; proposal.round.layouts = route.request().postDataJSON().layouts; json = proposal
        } else if (path === '/api/agent/presence') json = { connected: false, connections: [] }
        else if (path === '/api/canvas/history') json = { messages: [], availableCount: 0, nextCursor: '' }
        await route.fulfill({ json })
      })
      if (mode === 'review') { url.searchParams.set('review', '1'); await page.goto(url.toString()); await page.waitForFunction(() => Boolean((window as any).__ambioGraphStore)) }
      await page.evaluate(data => (window as any).__ambioGraphStore.getState().applySnapshot(data), snapshot)
      const canvas = page.locator('[data-ambio-canvas]').first()
      await expect(canvas).toHaveAttribute('data-canonical-node-count', String(snapshot.systems.length + snapshot.files.length))
      await expect(canvas).not.toHaveAttribute('data-scene-preparing', 'true')
      if (mode === 'review') await expect(canvas).toHaveClass(/ambio-canvas-review-ready/)
      await expect(canvas.locator('.react-flow__node').first()).toBeVisible()
      if (mode === 'floor') await page.getByRole('button', { name: 'Fit view', exact: true }).click()
      await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })
      // Diagnostic-only CSS experiments are reported separately from app builds.
      if (process.env.AMBIO_PAN_STYLE) await page.addStyleTag({ content: process.env.AMBIO_PAN_STYLE })
      // Start the drag on exposed pane, rather than accidentally dragging a node.
      const point = await canvas.evaluate(root => {
        const pane = root.querySelector('.react-flow__pane')!, r = pane.getBoundingClientRect()
        for (const y of [15, 35, 65, r.height - 30]) for (const x of [30, 70, 120, r.width / 2])
          if (x + 200 < r.width && document.elementFromPoint(r.left + x, r.top + y) === pane) return { x: r.left + x, y: r.top + y }
        throw Error('No exposed pane start point')
      })
      await page.evaluate(() => document.addEventListener('pointerdown', event => { (window as any).__panPointerId = event.pointerId }, { once: true, capture: true }))
      if (mode === 'review' && !process.env.AMBIO_PAN_STYLE) {
        if (process.env.AMBIO_PAN_LEGACY_HANDLES === '1') {
          expect(await canvas.locator('.react-flow__handle').count()).toBeGreaterThan(0)
          expect(await canvas.locator('.react-flow__handle').evaluateAll(handles =>
            handles.every(handle => getComputedStyle(handle).display === 'none'))).toBe(true)
        } else await expect(canvas.locator('.react-flow__handle')).toHaveCount(0)
      }
      else if (mode === 'floor') expect(await canvas.locator('.react-flow__handle').count()).toBeGreaterThan(0)
      await page.mouse.move(point.x, point.y)
      await page.waitForTimeout(300)
      const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable')
      if (process.env.AMBIO_PAN_CPU === '1') { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
      if (process.env.AMBIO_PAN_TIMELINE === '1') await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' })
      const context = {
        buildFingerprint: createHash('sha256').update(readFileSync('out/renderer/index.html')).digest('hex'),
        reference: { platform: platform(), cpu: cpus()[0]?.model, viewport: { width: 1400, height: 900 },
          browser: await page.evaluate(() => ({ userAgent: navigator.userAgent, pixelRatio: devicePixelRatio })) },
        instrumented: process.env.AMBIO_PAN_CPU === '1' || process.env.AMBIO_PAN_TIMELINE === '1',
        diagnosticStyle: process.env.AMBIO_PAN_STYLE ?? null,
        legacyHandles: process.env.AMBIO_PAN_LEGACY_HANDLES === '1',
        fixtureFingerprint: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      }
      const before = await cdp.send('Performance.getMetrics'), saves = layoutSaves
      const initial = await page.evaluate(() => {
        const w = window as any
        w.__ambioPerfTrace.start()
        w.__panTrace = { frames: [], running: true, tasks: [], moves: 0 }
        const frame = (at: number) => {
          const s = w.__panTrace
          if (!s.running) return
          if (s.previous) s.frames.push(at - s.previous)
          s.previous = at
          const transform = document.querySelector('.react-flow__viewport')!.getAttribute('style')
          if (s.transform && s.transform !== transform) s.moves++
          s.transform = transform
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
        w.__panObserver = new PerformanceObserver(list => w.__panTrace.tasks.push(...list.getEntries().map(entry => entry.duration)))
        w.__panObserver.observe({ type: 'longtask' })
        return { transform: document.querySelector('.react-flow__viewport')!.getAttribute('style'), metrics: { ...w.__ambioPerfMetrics } }
      })
      if (input === 'mouse') {
        await page.mouse.down()
        for (let i = 0; i < 96; i++) { const step = i % 48; await page.mouse.move(point.x + (step < 24 ? step + 1 : 47 - step) * 8, point.y + Math.sin(i / 8) * 10); await page.waitForTimeout(8) }
        // Inspect while held too: pan-only CSS/state may disappear on release.
        await expect(canvas.locator('.react-flow__pane')).toHaveClass(/dragging/)
        const held = await canvas.evaluate(root => ({
          filters: [...root.querySelectorAll('.ambio-shape-backdrop-path, .ambio-system-backdrop')].map(path => getComputedStyle(path).filter),
          capture: root.querySelector('.react-flow__pane')!.hasPointerCapture((window as any).__panPointerId),
        }))
        if (mode === 'review') {
          expect(held.filters.length).toBeGreaterThan(0)
          expect(held.filters.every(filter => filter === 'none')).toBe(true)
          expect(held.capture).toBe(true)
        } else expect(held.filters.some(filter => filter.includes('drop-shadow'))).toBe(true)
        await page.mouse.move(point.x, point.y)
        await page.mouse.up()
        await expect(canvas.locator('.react-flow__pane')).not.toHaveClass(/dragging/)
        expect(await canvas.evaluate(root => root.querySelector('.react-flow__pane')!.hasPointerCapture((window as any).__panPointerId))).toBe(false)
        expect(await canvas.locator('.ambio-shape-backdrop-path, .ambio-system-backdrop').first().evaluate(path => getComputedStyle(path).filter)).toContain('drop-shadow')
      } else {
        for (const key of ['d', 'a', 'd', 'a']) { await page.keyboard.down(key); await page.waitForTimeout(200); await page.keyboard.up(key) }
      }
      await page.waitForTimeout(250)
      const after = await cdp.send('Performance.getMetrics')
      const result = await page.evaluate(initial => {
        const w = window as any, s = w.__panTrace; s.running = false; w.__panObserver.disconnect()
        s.frames.sort((a: number, b: number) => a - b)
        return { frames: { count: s.frames.length, p95: s.frames[Math.floor(s.frames.length * .95)], p99: s.frames[Math.floor(s.frames.length * .99)], max: s.frames.at(-1) },
          cameraMoves: s.moves, longTasks: s.tasks, stages: w.__ambioPerfTrace.summary(), nodes: document.querySelectorAll('.react-flow__node').length, dom: document.querySelectorAll('*').length,
          handles: document.querySelectorAll('.react-flow__handle').length,
          canonicalNodes: Number(document.querySelector('[data-ambio-canvas]')!.getAttribute('data-canonical-node-count')),
          startTransform: initial.transform,
          renders: w.__ambioPerfMetrics.canvasRenderCount - initial.metrics.canvasRenderCount,
          visibilityPasses: w.__ambioPerfMetrics.zoomVisibilityPasses - initial.metrics.zoomVisibilityPasses,
          transform: document.querySelector('.react-flow__viewport')!.getAttribute('style') }
      }, initial)
      const browserWork = Object.fromEntries(after.metrics.filter(m => ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(m.name)).map(m => [m.name, m.value - (before.metrics.find(b => b.name === m.name)?.value ?? 0)]))
      // Reference-machine acceptance is opt-in; ordinary CI checks work bounds.
      const budgets = { frameP95Ms: 16.7, frameP99Ms: 33.3, timestampToleranceMs: 0.1 }
      const targets = {
        frameP95: result.frames.p95 <= budgets.frameP95Ms + budgets.timestampToleranceMs + 1e-6,
        frameP99: result.frames.p99 <= budgets.frameP99Ms + budgets.timestampToleranceMs + 1e-6,
      }
      if (process.env.AMBIO_PAN_CPU === '1') { const { profile } = await cdp.send('Profiler.stop'); writeFileSync(info.outputPath('pan.cpuprofile'), JSON.stringify(profile)) }
      if (process.env.AMBIO_PAN_TIMELINE === '1') {
        const completed = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve))
        await cdp.send('Tracing.end'); const { stream } = await completed
        let text = '', chunk
        do { chunk = await cdp.send('IO.read', { handle: stream }); text += chunk.data } while (!chunk.eof)
        await cdp.send('IO.close', { handle: stream }); writeFileSync(info.outputPath('pan-timeline.json'), text)
      }
      console.log('CANVAS_PAN', JSON.stringify({ mode, input, systems: snapshot.systems.length, ...context, ...result, browserWork, budgets, targets }))
      await info.attach('pan-metrics', { body: JSON.stringify({ mode, input, ...context, ...result, browserWork, budgets, targets }, null, 2), contentType: 'application/json' })
      if (mode === 'review' && input === 'mouse') {
        for (const button of ['middle'] as const) {
          await page.mouse.move(point.x, point.y)
          const start = await canvas.locator('.react-flow__viewport').getAttribute('style')
          await page.mouse.down({ button })
          await page.mouse.move(point.x + 80, point.y + 10, { steps: 6 })
          await expect(canvas.locator('.react-flow__pane')).toHaveClass(/dragging/)
          expect(await canvas.locator('.react-flow__viewport').getAttribute('style')).not.toBe(start)
          await page.mouse.move(point.x, point.y, { steps: 6 })
          await page.mouse.up({ button })
          await expect(canvas.locator('.react-flow__pane')).not.toHaveClass(/dragging/)
        }
        // Shift selection stays owned by Flow; ending it must leave panning usable.
        await page.keyboard.down('Shift')
        await page.mouse.move(point.x, point.y); await page.mouse.down()
        await page.mouse.move(point.x + 30, point.y + 20, { steps: 4 })
        await expect(canvas.locator('.react-flow__selection')).toBeVisible()
        await expect(canvas.locator('.react-flow__pane')).not.toHaveClass(/dragging/)
        await page.mouse.up(); await page.keyboard.up('Shift')
        await expect(canvas.locator('.react-flow__selection')).toHaveCount(0)
      }
      expect(result.stages.stages['worker.geometry-post']).toBeUndefined()
      expect(layoutSaves).toBe(saves)
      expect(result.nodes).toBeGreaterThan(0)
      expect(result.cameraMoves).toBeGreaterThan(2)
      expect(result.visibilityPasses).toBe(0)
      expect(errors).toEqual([])
      if (process.env.AMBIO_PAN_ENFORCE_FRAMES === '1') expect(targets).toEqual({ frameP95: true, frameP99: true })
    } finally {
      await app?.close()
      if (dirname(resolve(home)) === resolve(tmpdir()) && basename(home).startsWith('ambio-pan-')) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
}
