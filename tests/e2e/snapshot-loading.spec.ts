import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('packaged snapshot reader preserves complete data and cancels failed large reads', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ambio-snapshot-'))
  const appData = join(home, 'AppData', 'Roaming'), localData = join(home, 'AppData', 'Local')
  mkdirSync(appData, { recursive: true }); mkdirSync(localData, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home,
      APPDATA: appData, LOCALAPPDATA: localData, AMBIO_E2E: '1', AMBIO_E2E_HOME: '1' } })
    const page = await app.firstWindow()
    await page.waitForURL(/e2e=1/)
    await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, route => route.fulfill({ json: [] }))
    const url = new URL(page.url()); url.searchParams.delete('home'); await page.goto(url.toString())
    await page.waitForFunction(() => Boolean((window as any).__ambioDecodeSnapshot))
    const result = await page.evaluate(async () => {
      const decode = (window as any).__ambioDecodeSnapshot
      const snapshot = { workspaceId: 'reader-fixture',
        systems: [{ id: 's', name: 'Original name', parentId: null }],
        files: Array.from({ length: 2049 }, (_, id) => ({ id: String(id),
          relPath: `${'nested/'.repeat(40)}${id}.ts`, systemId: 's', indexedAt: id + .25 })),
        infraNodes: [{ id: 'infra', config: { port: 7000 } }],
        dependencies: [{ id: 'edge', src: '0', dst: '2048' }],
        floorLayouts: [{ nodeId: 's', scale: .75, interiorScale: .5, width: 620, height: 420 }],
      }
      const text = JSON.stringify(snapshot)
      const loaded = await decode(new Response(text))
      const abort = new AbortController()
      const cancelled = decode(new Response(text), abort.signal).then(() => 'published', (error: Error) => error.name)
      setTimeout(() => abort.abort(), 0)
      const invalid = await decode(new Response(' '.repeat(300000) + '{invalid'))
        .then(() => 'published', (error: Error) => error.message)
      return { bytes: text.length, identical: JSON.stringify(loaded) === text,
        cancelled: await cancelled, invalid, originalFileCount: (window as any).__ambioGraphStore.getState().files.length }
    })
    expect(result.bytes).toBeGreaterThan(256 * 1024)
    expect(result.identical).toBe(true)
    expect(result.cancelled).toBe('AbortError')
    expect(result.invalid).not.toBe('published')
    expect(result.originalFileCount).toBeGreaterThan(0)
  } finally { await app?.close(); rmSync(home, { recursive: true, force: true }) }
})
