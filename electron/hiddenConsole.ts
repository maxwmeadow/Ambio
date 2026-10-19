import fs from 'node:fs'
import type { StdioOptions } from 'node:child_process'

/**
 * Keep an agent CLI's console, and its children's, out of sight on Windows.
 *
 * windowsHide alone starts a console program with no console at all when all
 * its stdio is piped (libuv sets CREATE_NO_WINDOW). The program runs fine, but
 * any console program it starts in turn - a shell, a language server - is then
 * given a console of its own, and that one is visible: the black window that
 * Copilot CLI and Antigravity CLI opened. Inheriting one extra handle (NUL)
 * stops libuv from asking for no console, so the program gets a console that
 * windowsHide keeps hidden, and its children share it.
 */
let nul: number | undefined

export function hiddenConsoleStdio(stdio: Exclude<StdioOptions, string>): StdioOptions {
  if (process.platform !== 'win32') return stdio
  try { nul ??= fs.openSync('\\\\.\\NUL', 'r') } catch { return stdio }
  return [...stdio, nul]
}
