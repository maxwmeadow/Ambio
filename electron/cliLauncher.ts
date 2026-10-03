import fs from 'fs'
import { delimiter, join } from 'path'

// The `ambio` terminal command: `ambio .` opens the current folder, like
// `code .`. It is a tiny script that launches the installed app with the
// arguments; a running Ambio receives them through its single-instance lock.

export interface CliInstallResult {
  ok: boolean
  /** Where the command was written. */
  path?: string
  /** What to do by hand when Ambio could not finish the job. */
  manual?: string
  detail: string
}

export function launcherScript(executable: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `@echo off\r\nstart "" "${executable}" %*\r\n`
  }
  // nohup and the background job keep the app alive after the terminal closes.
  return `#!/bin/sh\n# Opens Ambio. Installed by Ambio (Settings → Advanced).\nnohup "${executable}" "$@" >/dev/null 2>&1 &\n`
}

/** A directory already on PATH that this user can write to, if there is one. */
export function writableDirOnPath(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string | null {
  const onPath = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const preferred = platform === 'win32'
    ? []
    : [join(home, '.local', 'bin'), join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of preferred) {
    if (!onPath.includes(dir)) continue
    try {
      fs.accessSync(dir, fs.constants.W_OK)
      return dir
    } catch { /* not writable */ }
  }
  return null
}

export function installCliLauncher(options: {
  executable: string
  configDir: string
  env?: NodeJS.ProcessEnv
  home: string
  platform?: NodeJS.Platform
}): CliInstallResult {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const script = launcherScript(options.executable, platform)
  const name = platform === 'win32' ? 'ambio.cmd' : 'ambio'

  // Always keep a copy in Ambio's own folder; it is what manual steps point at.
  const binDir = join(options.configDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const own = join(binDir, name)
  fs.writeFileSync(own, script, { mode: 0o755 })

  if (platform === 'win32') {
    const onPath = (env.PATH ?? env.Path ?? '').toLowerCase().split(delimiter).includes(binDir.toLowerCase())
    return onPath
      ? { ok: true, path: own, detail: 'The ambio command is ready. Open a new terminal and run: ambio .' }
      : {
        ok: false, path: own, manual: binDir,
        detail: `Add ${binDir} to your PATH (Settings → System → About → Advanced system settings → Environment Variables), then open a new terminal and run: ambio .`,
      }
  }

  const target = writableDirOnPath(env, options.home, platform)
  if (!target) {
    const command = `sudo ln -sf "${own}" /usr/local/bin/ambio`
    return { ok: false, path: own, manual: command, detail: `Run this once in a terminal to finish: ${command}` }
  }
  const installed = join(target, name)
  try { fs.rmSync(installed, { force: true }) } catch { /* replaced below */ }
  fs.symlinkSync(own, installed)
  return { ok: true, path: installed, detail: `Installed ${installed}. Open a new terminal and run: ambio .` }
}
