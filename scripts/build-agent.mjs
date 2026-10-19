import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const suffix = process.arch === 'x64' ? '-baseline' : ''
const platform = process.platform === 'win32' ? 'windows' : process.platform
const packageName = `opencode-${platform}-${process.arch}${suffix}`
const binary = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const source = path.join(root, 'node_modules', packageName, 'bin', binary)
const target = path.join(root, 'out', 'agent')
if (!fs.existsSync(source)) throw new Error(`Integrated agent binary missing: ${packageName}. Run npm ci with optional dependencies enabled.`)
fs.mkdirSync(target, { recursive: true })
// The binary is large; a copy that already matches is left alone, so every
// `npm run dev` does not rewrite it.
const bundled = path.join(target, binary)
const current = (() => { try { const from = fs.statSync(source), to = fs.statSync(bundled); return from.size === to.size && to.mtimeMs >= from.mtimeMs } catch { return false } })()
if (!current) fs.copyFileSync(source, bundled)
fs.chmodSync(bundled, 0o755)
fs.copyFileSync(path.join(root, 'scripts', 'licenses', 'opencode-1.18.34.txt'), path.join(target, 'LICENSE.txt'))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(target, 'version.json'), JSON.stringify({ harness: 'OpenCode', version: manifest.version }))
console.log(`Bundled OpenCode ${manifest.version} for ${process.platform}/${process.arch}`)
