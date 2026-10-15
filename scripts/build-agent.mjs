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
fs.copyFileSync(source, path.join(target, binary))
fs.chmodSync(path.join(target, binary), 0o755)
fs.copyFileSync(path.join(root, 'scripts', 'licenses', 'opencode-1.18.34.txt'), path.join(target, 'LICENSE.txt'))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(target, 'version.json'), JSON.stringify({ harness: 'OpenCode', version: manifest.version }))
console.log(`Bundled OpenCode ${manifest.version} for ${process.platform}/${process.arch}`)
