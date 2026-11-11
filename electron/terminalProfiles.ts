import { access, readFile, readdir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import type { TerminalProfile } from '../src/shared/terminal.ts'

export async function detectTerminalProfiles(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  customPaths: string[] = [],
): Promise<TerminalProfile[]> {
  const profiles: TerminalProfile[] = []
  const seen = new Set<string>()
  const add = async (path: string | undefined, label: string, args: string[] = []) => {
    if (!path) return
    let key: string
    try { await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK) } catch { return }
    try { key = await realpath(path) } catch { return }
    if (platform === 'win32') key = key.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    profiles.push({ id: path, path, label, args })
  }
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  const find = async (name: string, label: string, args: string[] = []) => {
    for (const dir of pathDirs) await add(join(dir.replace(/^"|"$/g, ''), name), label, args)
  }
  if (platform === 'win32') {
    await find('pwsh.exe', 'PowerShell')
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    try {
      for (const version of (await readdir(join(programFiles, 'PowerShell'))).sort().reverse()) {
        await add(join(programFiles, 'PowerShell', version, 'pwsh.exe'), `PowerShell ${version}`)
      }
    } catch { /* PowerShell Core is optional */ }
    await add(join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'Windows PowerShell', ['-NoLogo'])
    await add(env.ComSpec ?? join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), 'Command Prompt')
    await find('cmd.exe', 'Command Prompt')
    for (const root of [join(programFiles, 'Git'), join(env.LOCALAPPDATA ?? '', 'Programs', 'Git')]) {
      await add(join(root, 'bin', 'bash.exe'), 'Git Bash', ['--login', '-i'])
    }
    // A portable Git installation may only advertise its cmd directory on PATH.
    for (const dir of pathDirs) await add(join(dirname(dir), 'bin', 'bash.exe'), 'Git Bash', ['--login', '-i'])
    await find('bash.exe', 'Bash', ['--login', '-i'])
    const wsl = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
    try {
      const output = await new Promise<string>((resolve, reject) => execFile(wsl, ['--list', '--quiet'],
        { encoding: 'utf16le', windowsHide: true, timeout: 3000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
      for (const distro of output.replace(/\0/g, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        profiles.push({ id: `wsl:${distro}`, label: `WSL (${distro})`, path: wsl, args: ['--distribution', distro] })
      }
    } catch { /* no installed WSL distributions */ }
  } else {
    await add(env.SHELL, `${basename(env.SHELL ?? 'Shell')} (default)`, ['-l'])
    try {
      for (const shell of (await readFile('/etc/shells', 'utf8')).split(/\r?\n/)) {
        if (shell.startsWith('/')) await add(shell.trim(), basename(shell.trim()), ['-l'])
      }
    } catch { /* fall back to PATH and standard locations */ }
    for (const shell of ['zsh', 'bash', 'fish', 'sh', 'ksh', 'nu', 'pwsh']) {
      await find(shell, shell, shell === 'nu' || shell === 'pwsh' ? [] : ['-l'])
      await add(`/bin/${shell}`, shell, ['-l'])
    }
  }
  for (const path of customPaths) await add(path, basename(path))
  return profiles
}
