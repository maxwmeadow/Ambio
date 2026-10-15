// Rasterize the approved vector mark and wrap the PNGs in native icon formats.
// Run on Windows with Edge, or with Playwright's Chromium installed elsewhere.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('..', import.meta.url))
const destination = path.join(root, 'resources', 'branding')
const mark = await fs.readFile(path.join(root, 'src/renderer/assets/branding/mark.svg'), 'utf8')
const contour = mark.match(/<path[^>]* d="([^"]+)"/)?.[1]
if (!contour) throw new Error('The approved A contour is missing')
await fs.mkdir(destination, { recursive: true })
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="26" fill="#244b45"/><path fill="#f5f3ed" d="${contour}"/></svg>`
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="9 12 110 104"><path fill="#000" d="${contour}"/></svg>`
await fs.writeFile(path.join(destination, 'icon.svg'), icon)
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true })
const images = new Map()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  async function render(svg, size) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`)
    return page.screenshot({ omitBackground: true })
  }
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) images.set(size, await render(icon, size))
  await fs.writeFile(path.join(destination, 'icon.png'), images.get(512))
  await fs.writeFile(path.join(destination, 'tray.png'), images.get(16))
  await fs.writeFile(path.join(destination, 'tray@2x.png'), images.get(32))
  await fs.writeFile(path.join(destination, 'trayTemplate.png'), await render(template, 16))
  await fs.writeFile(path.join(destination, 'trayTemplate@2x.png'), await render(template, 32))
} finally {
  await browser.close()
}

// Windows ICO supports PNG entries, including the full 256px representation.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, i) => {
  const png = images.get(size)
  const entry = 6 + i * 16
  header[entry] = size === 256 ? 0 : size
  header[entry + 1] = size === 256 ? 0 : size
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(png.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += png.length
})
await fs.writeFile(path.join(destination, 'icon.ico'), Buffer.concat([header, ...sizes.map(size => images.get(size))]))

// Modern macOS ICNS chunks contain the same lossless PNG representations.
const types = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']]
const chunks = types.map(([size, type]) => {
  const png = images.get(size)
  const chunk = Buffer.alloc(8)
  chunk.write(type)
  chunk.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([chunk, png])
})
const icns = Buffer.alloc(8)
icns.write('icns')
icns.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
await fs.writeFile(path.join(destination, 'icon.icns'), Buffer.concat([icns, ...chunks]))
console.log('Generated app and tray icons in resources/branding')
