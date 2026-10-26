import fs from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { CLI_CLIENTS } from '../src/shared/agentDelivery.ts'
import { selectedDeliveryCli } from './agentDelivery.ts'
import { DRIVER_CLI_NAMES } from './agentDrivers.ts'

const FILE = 'agent-executable-overrides.json'
const known = (id: string) => CLI_CLIENTS.some(client => client.id === id)

/** Keep stale paths: a removed executable must be reported, not silently replaced. */
export function readExecutableOverrides(directory: string): Record<string, string> {
  let value: unknown
  try { value = JSON.parse(fs.readFileSync(join(directory, FILE), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Could not read saved CLI locations. Check agent-executable-overrides.json and retry.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved CLI locations are invalid. Check agent-executable-overrides.json and retry.')
  return Object.fromEntries(Object.entries(value).filter(([id, file]) => known(id) && typeof file === 'string' && isAbsolute(file)))
}

function save(directory: string, values: Record<string, string>): void {
  fs.mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `${FILE}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, JSON.stringify(values, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, join(directory, FILE))
  } finally { fs.rmSync(temporary, { force: true }) }
}

const VERSION: Record<string, RegExp> = {
  'claude-code': /claude\s*code/i, codex: /codex/i, 'copilot-cli': /github\s+copilot|copilot-cli/i,
  'cursor-cli': /cursor/i, 'devin-cli': /devin/i,
  'antigravity-cli': /antigravity|\bagy\b/i, 'antigravity-acp': /antigravity|agy|acp/i,
}

/** Only a user-selected CLI is run for validation, with a bounded --version probe. */
export async function setExecutableOverride(directory: string, hostId: string, file: string): Promise<{ ok: boolean; detail: string; path?: string }> {
  try {
    const launcher = selectedDeliveryCli(hostId, file)
    // ACP discovery must not require a version flag or start a long-lived
    // protocol session. The run checks the handshake.
    if (hostId === 'antigravity-acp') {
      if (!DRIVER_CLI_NAMES[hostId].some(name => [name, `${name}.exe`].includes(basename(file)))) throw new Error('Choose agy_acp_server or agy_acp_server.par for the Antigravity ACP agent.')
      save(directory, { ...readExecutableOverrides(directory), [hostId]: file })
      return { ok: true, detail: 'ACP executable located. Protocol compatibility is checked when starting a session.', path: file }
    }
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn(launcher.command, [...launcher.args, '--version'], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(launcher.bundledNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      })
      let output = ''
      let failure: Error | undefined
      const timer = setTimeout(() => { failure = new Error('The CLI did not answer --version within 5 seconds. Choose its executable, not an installer.'); child.kill(); reject(failure) }, 5000)
      const read = (data: Buffer) => {
        if (failure) return
        output += data.toString()
        if (output.length > 16384) { failure = new Error('The selected file returned too much output for a CLI version check.'); child.kill(); reject(failure) }
      }
      child.stdout.on('data', read); child.stderr.on('data', read)
      child.once('error', () => { clearTimeout(timer); reject(new Error('The selected CLI could not be started. Check its permissions and installation.')) })
      child.once('close', code => {
        clearTimeout(timer)
        if (failure) return
        if (code !== 0 || !VERSION[hostId]?.test(output) || !/\d+\.\d+/.test(output)) reject(new Error('The selected file did not identify itself as this CLI. Choose the correct installed executable.'))
        else resolve(output.trim().split(/\r?\n/).find(line => VERSION[hostId].test(line))?.slice(0, 160) ?? 'CLI verified')
      })
    })
    // Read after the asynchronous probe, so other clients' selections are preserved.
    save(directory, { ...readExecutableOverrides(directory), [hostId]: file })
    return { ok: true, detail: `Executable verified: ${version}. CLI sign-in is managed separately.`, path: file }
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) } }
}

export function clearExecutableOverride(directory: string, hostId: string): { ok: boolean; detail: string } {
  if (!known(hostId)) return { ok: false, detail: 'Unknown runnable client.' }
  const values = readExecutableOverrides(directory)
  delete values[hostId]
  save(directory, values)
  return { ok: true, detail: 'Ambio will search for this CLI automatically again.' }
}
