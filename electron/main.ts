import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, session } from 'electron'
import { readDaemonToken } from './daemonAuth'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import os from 'os'
import fs from 'fs'
import type { ProjectConfig, WsMessage } from '../src/shared/types'
import { completeSourceBoundaries, mergePersistedProjectConfig } from '../src/shared/projectLifecycle'
import { buildHosts, detectHosts, inspectHostConfiguration, installFamily } from './agentInstallers'
import { resolveNodeCommand } from './platformPaths'
import { readOverrides, setOverride, clearOverride } from './agentOverrides'
import {
  createProjectId,
  findProjectByRoot,
  migrateIndexedProjectLifecycle,
  refreshProjectDiskState,
  relocateProjectConfig,
  readResumeProjectId,
  removeProjectData,
  writeResumeProjectId,
} from './projectRegistry'

// electron-vite injects ELECTRON_RENDERER_URL in dev. The name matters: this
// used to read VITE_DEV_SERVER_URL, which is vite-plugin-electron's variable
// and one electron-vite never sets - so IS_DEV was always false and `npm run
// dev` silently served the last `npm run build` output from disk instead of
// the dev server. A stale out/renderer therefore rendered an arbitrarily old
// UI, and hot reload never worked at all.
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL
const IS_DEV = !!DEV_SERVER_URL
const IS_E2E = process.env.AXIOM_E2E === '1'
const IS_E2E_HOME = process.env.AXIOM_E2E_HOME === '1'  // route straight to the launcher for capture
const CONFIG_DIR = join(os.homedir(), '.axiom')
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json')
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json')
const DATA_DIR = join(os.homedir(), '.axiom', 'data')
const ARCHD_API_PORT = 7743
const ARCHD_WS_PORT = 7744

let mainWindow: BrowserWindow | null = null
let archdProcess: ChildProcess | null = null
let tray: Tray | null = null
// Set once the app is really leaving, so archd exiting then is expected.
let quitting = false
// The project the window has open, re-registered with archd after a restart
// so its file watchers come back without the user doing anything.
let activeProject: ProjectConfig | null = null
const archdRestarts: number[] = []
const ARCHD_RESTART_LIMIT = 5
const ARCHD_RESTART_WINDOW_MS = 60_000
let archdRecentStderr: string[] = []

// ─── Load/save recent projects ─────────────────────────────────────────────

function loadRecentProjects(): ProjectConfig[] {
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf8')
    const stored = JSON.parse(data) as ProjectConfig[]
    const migrated = stored.map(project => migrateIndexedProjectLifecycle(project, DATA_DIR))
    if (migrated.some((project, index) => project !== stored[index])) {
      try { saveRecentProjects(migrated) } catch { /* still return the readable registry */ }
    }
    return migrated
  } catch {
    return []
  }
}

function saveRecentProjects(projects: ProjectConfig[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const temp = `${PROJECTS_FILE}.tmp`
  fs.writeFileSync(temp, JSON.stringify(projects, null, 2))
  fs.renameSync(temp, PROJECTS_FILE)
}

function upsertRecentProject(config: ProjectConfig): void {
  const projects = loadRecentProjects()
  const idx = projects.findIndex(p => p.id === config.id)
  if (idx >= 0) projects[idx] = mergePersistedProjectConfig(projects[idx], config)
  else projects.unshift(config)
  // No cap: every project is local, and dropping one from this registry used
  // to orphan its index in DATA_DIR with no way back to it. How many appear
  // as "recent" is the launcher's decision, not the registry's.
  saveRecentProjects(projects)
}

function updateRegistryProject(projectId: string, update: (project: ProjectConfig) => ProjectConfig): ProjectConfig {
  const projects = loadRecentProjects()
  const index = projects.findIndex(project => project.id === projectId)
  if (index < 0) throw new Error('Project is missing from the project registry.')
  projects[index] = update(projects[index])
  saveRecentProjects(projects)
  return projects[index]
}

// Turn a user-typed project name into a safe folder name: drop path-invalid
// characters, collapse whitespace to hyphens, and trim stray separators.
function sanitizeProjectName(name: string): string {
  return (name ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
}

// ─── archd daemon lifecycle ─────────────────────────────────────────────────

function archdBinaryPath(): string {
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : ''
    return join(process.resourcesPath, `archd${ext}`)
  }
  // Dev: binary lives at <project-root>/archd-go/archd[.exe]
  // __dirname = out/main/ so we go up two levels to reach the project root
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(__dirname, '..', '..', 'archd-go', 'archd' + ext)
}

function startArchd(): void {
  if (archdProcess) return

  const binary = archdBinaryPath()
  if (!fs.existsSync(binary)) {
    console.warn(`[main] archd binary not found at ${binary} - run: npm run build:archd`)
    return
  }

  fs.mkdirSync(DATA_DIR, { recursive: true })

  console.log('[main] spawning archd at:', binary)
  try {
    archdProcess = spawn(binary, [
      '-data', DATA_DIR,
      '-api-port', String(ARCHD_API_PORT),
      '-ws-port', String(ARCHD_WS_PORT),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    reportArchdLaunchError(binary, error)
    archdProcess = null
    return
  }

  archdRecentStderr = []
  archdProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    process.stderr.write('[archd] ' + text)
    archdRecentStderr = [...archdRecentStderr, ...text.split('\n').filter(Boolean)].slice(-40)
  })

  // Read newline-delimited JSON responses from archd stdout
  let buf = ''
  archdProcess.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        mainWindow?.webContents.send('archd:message', msg)
      } catch {
        console.error('[main] archd stdout parse error:', line)
      }
    }
  })

  archdProcess.on('error', (error) => {
    reportArchdLaunchError(binary, error)
    archdProcess = null
  })
  archdProcess.on('exit', (code, signal) => {
    console.log(`[main] archd exited with code ${code}${signal ? ` (${signal})` : ''}`)
    archdProcess = null
    if (!quitting) handleArchdCrash(code)
  })

  console.log('[main] archd started, pid:', archdProcess.pid)
}

function reportArchdLaunchError(binary: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[main] archd launch failed at ${binary}:`, error)
  // Written for the person using Axiom. Only a development checkout gets the
  // build instruction, because only there is it something they can do.
  dialog.showErrorBox(
    'Axiom could not start its background service',
    app.isPackaged
      ? `${message}\n\nYour code is untouched. Reinstalling Axiom usually fixes this; if it keeps happening, please report it from Help → Report a Bug.`
      : `${message}\n\nBuild the daemon with:\nnpm run build:archd`,
  )
}

type ArchdStatus =
  | { state: 'restarting'; attempt: number }
  | { state: 'running' }
  | { state: 'failed'; reason: string; detail: string }

function sendArchdStatus(status: ArchdStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('archd:status', status)
}

function archdFailureReason(): { reason: string; detail: string } {
  const log = archdRecentStderr.join('\n')
  if (/address already in use|only one usage of each socket address/i.test(log)) {
    return {
      reason: 'port-in-use',
      detail: `Another program is using Axiom's local ports (${ARCHD_API_PORT}/${ARCHD_WS_PORT}). ` +
        'Quit any other copy of Axiom, or the program holding those ports, then restart Axiom.',
    }
  }
  return {
    reason: 'crashed',
    detail: 'Axiom\'s background service stopped repeatedly. Your code is untouched. ' +
      'Restart Axiom; if it keeps happening, please report it with the diagnostics attached.',
  }
}

// archd owns indexing, watching and the MCP-facing API. When it dies the
// window used to keep showing a map that silently stopped updating. Restart it
// with backoff, and only give up - loudly - when it will not stay up.
function handleArchdCrash(code: number | null): void {
  if (IS_E2E) return
  const now = Date.now()
  while (archdRestarts.length > 0 && now - archdRestarts[0] > ARCHD_RESTART_WINDOW_MS) archdRestarts.shift()
  if (archdRestarts.length >= ARCHD_RESTART_LIMIT) {
    const failure = archdFailureReason()
    console.error(`[main] archd will not stay up (last exit ${code}); giving up: ${failure.reason}`)
    sendArchdStatus({ state: 'failed', ...failure })
    return
  }
  archdRestarts.push(now)
  const attempt = archdRestarts.length
  const delay = Math.min(500 * 2 ** (attempt - 1), 8000)
  sendArchdStatus({ state: 'restarting', attempt })
  setTimeout(() => {
    if (quitting) return
    startArchd()
    void reattachActiveProject()
  }, delay)
}

/** Resolves once archd answers HTTP at all; a 401 still proves it is listening. */
async function waitForArchd(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!archdProcess) return false
    try {
      await fetch(`http://127.0.0.1:${ARCHD_API_PORT}/api/workspace-scope/health`, { signal: AbortSignal.timeout(1000) })
      return true
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  return false
}

async function reattachActiveProject(): Promise<void> {
  if (!(await waitForArchd())) return
  const project = activeProject
  if (project) {
    try {
      await fetch(`http://127.0.0.1:${ARCHD_API_PORT}/api/workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readDaemonToken()}` },
        body: JSON.stringify({
          workspaceId: project.id,
          name: project.name,
          rootPath: project.rootPath,
          ignoredPaths: project.ignoredPaths,
          sourceBoundariesReviewedAt: project.sourceBoundariesReviewedAt,
        }),
      })
    } catch (error) {
      console.error('[main] could not reattach the open project after restarting archd:', error)
    }
  }
  sendArchdStatus({ state: 'running' })
}

function stopArchd(): void {
  if (archdProcess) {
    // SIGTERM is ignored on Windows; use taskkill to ensure the process tree is killed
    const pid = archdProcess.pid
    archdProcess.kill()
    if (pid && process.platform === 'win32') {
      require('child_process').spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { detached: true, stdio: 'ignore' })
    }
    archdProcess = null
  }
}

function sendToArchd(msg: unknown): void {
  if (!archdProcess?.stdin) return
  archdProcess.stdin.write(JSON.stringify(msg) + '\n')
}

// ─── Window creation ────────────────────────────────────────────────────────

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {
      trafficLightPosition: { x: 14, y: 10 },
    } : {}),
    // On Windows: overlay native window controls on top of the custom toolbar
    ...(isWin ? {
      titleBarOverlay: {
        color: '#26332f',
        symbolColor: '#f2f1eb',
        height: 34,
      },
    } : {}),
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Axiom',
    show: false,
    // E2E windows render offscreen and never enter the taskbar. They are shown
    // with showInactive() below because Chromium will not consider screenshots
    // geometrically stable while a BrowserWindow remains fully hidden.
    skipTaskbar: IS_E2E,
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-change', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-change', false)
  })

  if (IS_DEV && DEV_SERVER_URL) {
    const rendererUrl = new URL(DEV_SERVER_URL)
    if (IS_E2E) rendererUrl.searchParams.set('e2e', '1')
    if (IS_E2E_HOME) rendererUrl.searchParams.set('home', '1')
    mainWindow.loadURL(rendererUrl.toString())
    if (!IS_E2E) mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      IS_E2E ? { query: IS_E2E_HOME ? { e2e: '1', home: '1' } : { e2e: '1' } } : undefined,
    )
  }

  if (IS_E2E) {
    const showForAutomation = () => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
      // Keep a conventionally rendered window (required for reliable canvas
      // screenshots) far outside every practical desktop, and never activate
      // it. Unlike show(), showInactive() cannot take keyboard focus.
      mainWindow.setPosition(-32000, -32000, false)
      mainWindow.showInactive()
    }
    mainWindow.once('ready-to-show', showForAutomation)
    mainWindow.webContents.once('did-finish-load', showForAutomation)
  } else {
    // Show as soon as the renderer is usable. ready-to-show alone is NOT
    // reliable on Windows (it can simply never fire for initially-hidden
    // windows on some GPU/driver combos - the app stays invisible while
    // everything else runs). did-finish-load always fires, so show on
    // whichever comes first, with a timed fallback as the last resort.
    const showOnce = (source: string) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.log(`[main] showing window (${source})`)
        mainWindow.maximize()
        mainWindow.show()
      }
    }
    mainWindow.once('ready-to-show', () => showOnce('ready-to-show'))
    mainWindow.webContents.once('did-finish-load', () => showOnce('did-finish-load'))
    setTimeout(() => showOnce('fallback-timer'), 5000)
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] renderer failed to load: ${code} ${desc} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer process gone:', details.reason, details.exitCode)
  })
  mainWindow.on('unresponsive', () => {
    console.error('[main] renderer is unresponsive')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ─── IPC Handlers ──────────────────────────────────────────────────────────

function setupIPC(): void {
  // Open a project directory - returns config only; caller is responsible for sending to archd
  ipcMain.handle('project:open-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Open Project',
    })
    if (result.canceled || !result.filePaths[0]) return null

    const rootPath = result.filePaths[0]
    const existing = findProjectByRoot(loadRecentProjects(), rootPath)
    const id = existing?.id ?? createProjectId()
    const freshConfig: ProjectConfig = {
      id,
      name: rootPath.split(/[/\\]/).pop() ?? 'Project',
      rootPath,
      creationSource: 'open-codebase',
      rootIsEmpty: fs.readdirSync(rootPath).length === 0,
      ignoredPaths: [],
      languageOverrides: {},
      layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
      openedAt: Date.now(),
    }
    let config = mergePersistedProjectConfig(existing, freshConfig)
    // An empty codebase has no source scope to choose, but it still follows the
    // Open Codebase journey because the launcher action is authoritative.
    if (config.rootIsEmpty) {
      config = completeSourceBoundaries(config, [])
    }
    upsertRecentProject(config)
    return config
  })

  // Open a specific project path directly
  ipcMain.handle('project:open', async (_event, config: ProjectConfig) => {
    // Opening a project is the clearest signal it is recent again.
    const currentConfig = refreshProjectDiskState({ ...config, openedAt: Date.now(), hiddenFromRecents: false })
    upsertRecentProject(currentConfig)
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(
      join(DATA_DIR, 'active_project.json'),
      JSON.stringify({ workspaceId: currentConfig.id, name: currentConfig.name, rootPath: currentConfig.rootPath }, null, 2)
    )
    sendToArchd({ type: 'open:project', payload: currentConfig })
    activeProject = currentConfig
    return currentConfig
  })

  // Choose a directory to hold a new project (New Project flow → location).
  ipcMain.handle('dialog:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a location for the new project',
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // Create a project from scratch: make an empty folder that an agent (or the
  // user) can build into, then hand back a config the renderer opens like any
  // other project. The live Floor then materializes files as they appear.
  ipcMain.handle('project:create', async (_event, { parentDir, name }: { parentDir: string; name: string }) => {
    const safe = sanitizeProjectName(name)
    if (!safe) throw new Error('Project name is empty or contains only invalid characters.')
    if (!parentDir) throw new Error('No location was chosen for the project.')
    const rootPath = join(parentDir, safe)
    if (fs.existsSync(rootPath) && fs.readdirSync(rootPath).length > 0) {
      throw new Error(`A non-empty folder named "${safe}" already exists here.`)
    }
    fs.mkdirSync(rootPath, { recursive: true })
    const id = createProjectId()
    const config: ProjectConfig = completeSourceBoundaries({
      id,
      name: safe,
      rootPath,
      creationSource: 'new-project',
      rootIsEmpty: true,
      ignoredPaths: [],
      languageOverrides: {},
      layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
      openedAt: Date.now(),
    }, [])
    upsertRecentProject(config)
    return config
  })

  // A project folder was moved or renamed. Repoint the project at its new
  // location so its map, layout and history come along, rather than making
  // the user start over. Axiom never moves the user's files.
  ipcMain.handle('project:relocate', async (_event, projectId: string) => {
    const project = loadRecentProjects().find(candidate => candidate.id === projectId)
    if (!project) throw new Error('Project is missing from the project registry.')
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: `Locate the folder for ${project.name}`,
      buttonLabel: 'Use This Folder',
    })
    if (result.canceled || !result.filePaths[0]) return null
    const newRoot = result.filePaths[0]
    const owner = findProjectByRoot(loadRecentProjects(), newRoot)
    if (owner && owner.id !== projectId) {
      throw new Error(`That folder already belongs to the project "${owner.name}".`)
    }
    const token = readDaemonToken()
    const response = await fetch(`http://127.0.0.1:${ARCHD_API_PORT}/api/workspace-relocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: projectId, fromPath: project.rootPath, toPath: newRoot }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Axiom could not move the project map to the new folder${detail ? `: ${detail}` : '.'}`)
    }
    return refreshProjectDiskState(updateRegistryProject(projectId, current => relocateProjectConfig(current, newRoot)))
  })

  // Hiding is not deleting: the project and its map stay, it just leaves the
  // launcher's recent list until it is opened again.
  ipcMain.handle('project:set-hidden', (_event, projectId: string, hidden: boolean) =>
    updateRegistryProject(projectId, project => ({ ...project, hiddenFromRecents: Boolean(hidden) })))

  // Get recent projects
  ipcMain.handle('project:list-recent', () => loadRecentProjects().map(refreshProjectDiskState))

  ipcMain.handle('project:get-resume-id', () => readResumeProjectId(SETTINGS_FILE))
  ipcMain.handle('project:set-resume-id', (_event, projectId: string | null) => {
    // Clearing the resume marker is how the renderer leaves a project.
    if (projectId === null) activeProject = null
    if (projectId !== null && !loadRecentProjects().some(project => project.id === projectId)) {
      throw new Error('Cannot resume a project outside the recent-project registry.')
    }
    writeResumeProjectId(SETTINGS_FILE, projectId)
  })
  ipcMain.handle('project:complete-lifecycle', (_event, projectId: string, milestone: 'agentSetupCompletedAt' | 'reviewCompletedAt') => {
    if (milestone !== 'agentSetupCompletedAt' && milestone !== 'reviewCompletedAt') {
      throw new Error('Invalid project lifecycle milestone.')
    }
    return updateRegistryProject(projectId, project => ({ ...project, [milestone]: Date.now() }))
  })

  // Deleting is a verified lifecycle boundary. Keep the recent entry if any
  // daemon or filesystem step fails so the UI cannot claim data was removed.
  ipcMain.handle('project:remove', async (_event, projectId: string) => {
    const token = readDaemonToken()
    await removeProjectData({ projectId, dataDir: DATA_DIR, apiPort: ARCHD_API_PORT,
      request: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } }),
    })
    saveRecentProjects(loadRecentProjects().filter(project => project.id !== projectId))
    if (readResumeProjectId(SETTINGS_FILE) === projectId) writeResumeProjectId(SETTINGS_FILE, null)
  })

  // Send a mutation intent to archd
  ipcMain.handle('mutation:intent', (_event, intent) => {
    sendToArchd({ type: 'mutation:intent', payload: intent })
  })

  // Save node position
  ipcMain.handle('node:save-position', (_event, { id, x, y, projectId }) => {
    // Positions are saved by archd via the store
    sendToArchd({ type: 'node:position', payload: { id, x, y, projectId } })
  })

  // List directory contents for project setup screen
  ipcMain.handle('fs:list-dir', (_event, dirPath: string) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      return entries.map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        path: join(dirPath, e.name),
      }))
    } catch {
      return []
    }
  })

  // Show item in Finder/Explorer
  ipcMain.handle('shell:show-item', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  // Open file in default editor
  ipcMain.handle('shell:open-file', (_event, filePath: string) => {
    shell.openPath(filePath)
  })

  // Get app info (includes archd ports so renderer can connect)
  ipcMain.handle('app:info', () => {
    const isPackaged = app.isPackaged
    const mcpPath = isPackaged
      ? join(process.resourcesPath, 'mcp', 'axiom-mcp.mjs')
      : join(__dirname, '..', '..', 'mcp', 'axiom-mcp.ts')
    return {
      version: app.getVersion(),
      dataDir: join(os.homedir(), '.axiom'),
      platform: process.platform,
      archdApiUrl: `http://127.0.0.1:${ARCHD_API_PORT}`,
      archdWsUrl: `ws://127.0.0.1:${ARCHD_WS_PORT}/ws`,
      mcpPath,
      isPackaged,
    }
  })

  // Which agents are on this machine, and what each install would touch.
  ipcMain.handle('agent:hosts', (_event, projectRoot?: string) => {
    const overrides = readOverrides(CONFIG_DIR)
    const present = detectHosts(undefined, undefined, process.platform, overrides)
    return buildHosts(undefined, undefined, process.platform, overrides).map(host => {
      const configuration = inspectHostConfiguration(host, projectRoot)
      return {
        id: host.id,
        label: host.label,
        familyId: host.familyId,
        familyLabel: host.familyLabel,
        modality: host.modality,
        modalityLabel: host.modalityLabel,
        sharedSurfaces: host.sharedSurfaces ?? [],
        detected: present[host.id] === true,
        configPath: host.configPath(),
        configOverride: overrides[host.id] ?? null,
        command: host.command ?? null,
        triggerKind: host.triggerKind,
        promptText: host.promptText,
        restartAction: host.restartAction,
        restartDetail: host.restartDetail,
        ...configuration,
      }
    })
  })

  // Install Axiom into one agent modality.
  ipcMain.handle('agent:install', (_event, hostId: string, projectRoot?: string) => {
    const host = buildHosts(undefined, undefined, process.platform, readOverrides(CONFIG_DIR))
      .find(candidate => candidate.id === hostId)
    if (!host) return { ok: false, detail: `Unknown agent "${hostId}".`, paths: [] }
    const mcpPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp', 'axiom-mcp.mjs')
      : join(__dirname, '..', '..', 'mcp', 'axiom-mcp.ts')
    if (!fs.existsSync(mcpPath)) {
      return { ok: false, detail: `This Axiom install has no MCP server at ${mcpPath}.`, paths: [] }
    }
    const nodeCmd = resolveNodeCommand()
    try {
      return host.install(nodeCmd, [mcpPath], NAME_ARCHITECTURE_COMMAND, projectRoot)
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        paths: [host.configPath()],
      }
    }
  })

  // Install Axiom into all detected modalities for an agent family in one action.
  ipcMain.handle('agent:install-family', (_event, familyId: string, projectRoot?: string) => {
    const mcpPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp', 'axiom-mcp.mjs')
      : join(__dirname, '..', '..', 'mcp', 'axiom-mcp.ts')
    if (!fs.existsSync(mcpPath)) {
      return { ok: false, detail: `This Axiom install has no MCP server at ${mcpPath}.`, paths: [] }
    }
    const nodeCmd = resolveNodeCommand()
    try {
      return installFamily(familyId, nodeCmd, [mcpPath], NAME_ARCHITECTURE_COMMAND, projectRoot)
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        paths: [],
      }
    }
  })

  // How an agent actually connects. Axiom speaks MCP over stdio, so the thing a
  // user needs is a server entry naming this install - never a URL. The old
  // invitation copied http://127.0.0.1:7743/mcp, which archd does not serve and
  // never did, so following the app's own instruction could not work.
  // Point Axiom at a configuration file it could not find on its own.
  ipcMain.handle('agent:locate', async (_event, hostId: string) => {
    const host = buildHosts(undefined, undefined, process.platform, readOverrides(CONFIG_DIR))
      .find(candidate => candidate.id === hostId)
    if (!host) return { ok: false, detail: `Unknown agent "${hostId}".` }

    const suggested = host.configPath()
    const extension = suggested.split('.').pop() ?? ''
    const result = await dialog.showOpenDialog({
      title: `Locate the configuration file for ${host.modalityLabel || host.label}`,
      defaultPath: fs.existsSync(join(suggested, '..')) ? join(suggested, '..') : os.homedir(),
      properties: ['openFile', 'showHiddenFiles'],
      filters: extension
        ? [{ name: `${extension.toUpperCase()} files`, extensions: [extension] }, { name: 'All files', extensions: ['*'] }]
        : [{ name: 'All files', extensions: ['*'] }],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, detail: 'Cancelled.' }
    }
    return setOverride(CONFIG_DIR, hostId, result.filePaths[0])
  })

  ipcMain.handle('agent:clear-override', (_event, hostId: string) => clearOverride(CONFIG_DIR, hostId))

  ipcMain.handle('agent:connection', () => {
    const mcpPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp', 'axiom-mcp.mjs')
      : join(__dirname, '..', '..', 'mcp', 'axiom-mcp.ts')
    const args = [mcpPath]
    return {
      command: 'node',
      args,
      // Reported rather than assumed: a missing entry point is the difference
      // between "paste this" and "your install is incomplete", and the user
      // should be told which one they are looking at.
      available: fs.existsSync(mcpPath),
      path: mcpPath,
      config: JSON.stringify(
        { mcpServers: { axiom: { command: 'node', args } } },
        null,
        2,
      ),
    }
  })

  // The user asked to try again after archd gave up: start with a clean
  // backoff budget.
  ipcMain.handle('archd:restart', async () => {
    archdRestarts.length = 0
    if (!archdProcess) startArchd()
    await reattachActiveProject()
  })

  // Window controls
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:is-maximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  ipcMain.handle('window:set-title-bar-height', (_event, height: number) => {
    if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
      try {
        mainWindow.setTitleBarOverlay({
          color: '#26332f',
          symbolColor: '#f2f1eb',
          height,
        })
      } catch {
        // Ignore if unsupported
      }
    }
  })
}


// The body of Axiom's architecture-mapping workflow. Kept beside the installer
// so the workflow a user invokes and the instructions Axiom means to give are
// the same text, rather than two copies that drift.
const NAME_ARCHITECTURE_COMMAND = `# Axiom - map this codebase's architecture

Map this codebase's architecture for its owner, who is watching a spatial map
of it in Axiom. Produce a TREE OF SEMANTIC SYSTEMS.

**What a system is.** A responsibility - something the codebase does. Name it
the way an engineer would say it aloud explaining the project to a new
colleague.

A system is NOT a folder. Folders are for navigation; never use them as the
answer. Two files in different directories belong to the same system when they
serve the same responsibility, and one directory often holds several distinct
systems.

**Nesting is the point.** Every system may contain sub-systems, and those may
contain more. Go as deep as the code justifies - a large area earns four or
five levels, a small utility earns none. If a system holds more than about ten
files, ask whether it is really one thing or several. There may be hundreds of
systems in the tree; what must stay small is how many appear at any one level.

**Shape.** Around a dozen systems at the top - the parts you would list if
asked what this application is made of. For each: a name of two to four words,
one sentence saying what it is responsible for, and for leaf systems the files
that belong to it.

**How to work.** Start from the file tree only to orient yourself. Then READ.
Open entry points, the largest files, anything whose name suggests it
coordinates others. Do not infer from filenames - a file called utils.ts may be
the core of a system. Do not begin from the systems already on the map: those
were named automatically from word frequency and describe nothing.

**Submit it incrementally** with Axiom's \`edit_systems\` tool. Call
\`begin_session\` once, then \`add_chunk\` for small groups of systems with a
stable chunkId per group. Each system takes a systemKey, name, description,
optional parentKey (which may refer to another chunk), and repository-relative
files. Set rootId on a system when its file paths are ambiguous across roots.
Call \`commit_session\` after the whole tree is submitted. If your
session is interrupted, use \`session_status\` and resume with the same
sessionId. A small map can still use \`op: "propose"\` in one call.

The human confirms, renames or rejects each system. Nothing reaches their map
until they do.
`

// ─── App lifecycle ──────────────────────────────────────────────────────────

// One Axiom per machine. A second copy would start a second archd that loses
// the race for the local ports and leaves one window silently disconnected.
// Launching again instead brings the existing window forward.
const hasInstanceLock = IS_E2E || app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

app.whenReady().then(() => {
  if (!hasInstanceLock) return
  // The capability stays in main; only requests to our fixed loopback daemon
  // receive it. Page scripts never receive the token through IPC or URLs.
  if (!IS_E2E) session.defaultSession.webRequest.onBeforeSendHeaders(
    // archd answers HTTP on both ports: the renderer's symbol and agent-lane
    // requests go to the WebSocket port (arcdApi.ts, symbolCache.ts), and
    // without the token there they fail as 401 and files show "No symbols".
    { urls: ['http://127.0.0.1:7743/*', 'http://127.0.0.1:7744/*', 'ws://127.0.0.1:7744/*'] },
    (details, callback) => {
      if (details.webContentsId !== mainWindow?.webContents.id) { callback({ requestHeaders: details.requestHeaders }); return }
      const frameUrl = details.frame?.url
      if (frameUrl && !frameUrl.startsWith('file://') && !(DEV_SERVER_URL && new URL(frameUrl).origin === new URL(DEV_SERVER_URL).origin)) {
        callback({ requestHeaders: details.requestHeaders }); return
      }
      try { details.requestHeaders.Authorization = `Bearer ${readDaemonToken()}` } catch { /* daemon may still be starting */ }
      callback({ requestHeaders: details.requestHeaders })
    },
  )
  createWindow()
  setupIPC()
  if (!IS_E2E) startArchd()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    quitting = true
    stopArchd()
    app.quit()
  }
})

app.on('before-quit', () => {
  quitting = true
  stopArchd()
})

// Ensure archd is killed if the process is terminated via Ctrl+C or signal
process.on('SIGINT', () => { quitting = true; stopArchd(); process.exit(0) })
process.on('SIGTERM', () => { quitting = true; stopArchd(); process.exit(0) })

// Security: prevent navigation to external URLs
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl)
    const devOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : null
    if (parsedUrl.origin !== devOrigin && !navigationUrl.startsWith('file://')) {
      event.preventDefault()
    }
  })
})
