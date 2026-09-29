import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectConfig, WsMessage } from '../src/shared/types'
import type { AppSettings } from '../src/shared/appSettings'
import type { CommandId, SystemRole } from '../src/shared/appMenu'

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('axiom', {
  // Project management
  openProjectDialog: (): Promise<ProjectConfig | null> =>
    ipcRenderer.invoke('project:open-dialog'),

  openProject: (config: ProjectConfig): Promise<ProjectConfig> =>
    ipcRenderer.invoke('project:open', config),

  chooseDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:choose-directory'),

  createProject: (parentDir: string, name: string): Promise<ProjectConfig> =>
    ipcRenderer.invoke('project:create', { parentDir, name }),

  listRecentProjects: (): Promise<ProjectConfig[]> =>
    ipcRenderer.invoke('project:list-recent'),

  removeProject: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('project:remove', projectId),

  /** Ask for a moved project's new folder; null when the user cancels. */
  relocateProject: (projectId: string): Promise<ProjectConfig | null> =>
    ipcRenderer.invoke('project:relocate', projectId),

  setProjectHidden: (projectId: string, hidden: boolean): Promise<ProjectConfig> =>
    ipcRenderer.invoke('project:set-hidden', projectId, hidden),

  updateProject: (projectId: string, patch: Partial<Pick<ProjectConfig, 'name' | 'ignoredPaths' | 'sourceBoundariesReviewedAt'>>): Promise<ProjectConfig> =>
    ipcRenderer.invoke('project:update', projectId, patch),

  getResumeProjectId: (): Promise<string | null> => ipcRenderer.invoke('project:get-resume-id'),
  setResumeProjectId: (projectId: string | null): Promise<void> => ipcRenderer.invoke('project:set-resume-id', projectId),
  completeProjectLifecycle: (projectId: string, milestone: 'agentSetupCompletedAt' | 'reviewCompletedAt'): Promise<ProjectConfig> =>
    ipcRenderer.invoke('project:complete-lifecycle', projectId, milestone),

  // Mutations
  sendMutationIntent: (intent: unknown) =>
    ipcRenderer.invoke('mutation:intent', intent),

  // Node positions
  saveNodePosition: (id: string, x: number, y: number, projectId: string) =>
    ipcRenderer.invoke('node:save-position', { id, x, y, projectId }),

  // Filesystem helpers
  listDir: (dirPath: string): Promise<Array<{ name: string; isDirectory: boolean; path: string }>> =>
    ipcRenderer.invoke('fs:list-dir', dirPath),

  // Shell
  showInFolder: (filePath: string) =>
    ipcRenderer.invoke('shell:show-item', filePath),

  openFile: (filePath: string) =>
    ipcRenderer.invoke('shell:open-file', filePath),

  // App info
  getAppInfo: (): Promise<{ version: string; dataDir: string; platform: string; mcpPath: string; archdApiUrl: string; archdWsUrl: string; isPackaged: boolean }> =>
    ipcRenderer.invoke('app:info'),

  // How an agent connects to this install (stdio server entry, not a URL)
  getAgentConnection: (): Promise<AgentConnection> =>
    ipcRenderer.invoke('agent:connection'),

  // Which agents are on this machine
  listAgentHosts: (projectRoot?: string): Promise<AgentHostInfo[]> =>
    ipcRenderer.invoke('agent:hosts', projectRoot),

  // Install Axiom into one agent - server entry and slash command
  installAgent: (hostId: string, projectRoot?: string): Promise<AgentInstallResult> =>
    ipcRenderer.invoke('agent:install', hostId, projectRoot),

  // Install all detected modalities for an agent family in one click
  installFamily: (familyId: string, projectRoot?: string): Promise<AgentInstallResult> =>
    ipcRenderer.invoke('agent:install-family', familyId, projectRoot),
  locateAgentHost: (hostId: string): Promise<AgentOverrideResult> =>
    ipcRenderer.invoke('agent:locate', hostId),
  clearAgentHostOverride: (hostId: string): Promise<AgentOverrideResult> =>
    ipcRenderer.invoke('agent:clear-override', hostId),

  // Platform & window controls
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  maximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  setTitleBarHeight: (height: number): Promise<void> =>
    ipcRenderer.invoke('window:set-title-bar-height', height),
  onMaximizedChange: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, max: boolean) => callback(max)
    ipcRenderer.on('window:maximized-change', handler)
    return () => {
      ipcRenderer.removeListener('window:maximized-change', handler)
    }
  },

  // Listen for messages from archd (forwarded by main process)
  restartArchd: (): Promise<void> => ipcRenderer.invoke('archd:restart'),

  uninstallAgent: (hostId: string, projectRoot?: string): Promise<AgentInstallResult> =>
    ipcRenderer.invoke('agent:uninstall', hostId, projectRoot),
  uninstallAllAgents: (projectRoot?: string): Promise<AgentInstallResult> =>
    ipcRenderer.invoke('agent:uninstall-all', projectRoot),

  // Updates from GitHub Releases.
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:get-status'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('update:check'),

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (callback: (settings: AppSettings) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: AppSettings) => callback(settings)
    ipcRenderer.on('settings:changed', handler)
    return () => { ipcRenderer.removeListener('settings:changed', handler) }
  },

  clearRecentProjects: (): Promise<void> => ipcRenderer.invoke('project:clear-recent'),
  onOpenRecent: (callback: (projectId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId)
    ipcRenderer.on('menu:open-recent', handler)
    return () => { ipcRenderer.removeListener('menu:open-recent', handler) }
  },
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),

  // Menus and commands
  setMenuState: (state: { projectOpen: boolean }): Promise<void> => ipcRenderer.invoke('menu:state', state),
  runMenuRole: (role: SystemRole): Promise<void> => ipcRenderer.invoke('menu:role', role),
  developerMenuEnabled: (): Promise<boolean> => ipcRenderer.invoke('menu:developer'),
  onMenuCommand: (callback: (id: CommandId) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: CommandId) => callback(id)
    ipcRenderer.on('menu:command', handler)
    return () => { ipcRenderer.removeListener('menu:command', handler) }
  },
  zoom: (action: 'in' | 'out' | 'reset'): Promise<number> => ipcRenderer.invoke('window:zoom', action),
  toggleFullScreen: (): Promise<void> => ipcRenderer.invoke('window:toggle-fullscreen'),
  openHelp: (topic: 'docs' | 'privacy' | 'license' | 'releases'): Promise<void> => ipcRenderer.invoke('help:open', topic),
  getAppPaths: (): Promise<{ config: string; data: string; logs: string }> => ipcRenderer.invoke('app:paths'),
  openAppPath: (which: 'config' | 'data' | 'logs'): Promise<string> => ipcRenderer.invoke('shell:open-path', which),
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status)
    ipcRenderer.on('update:status', handler)
    return () => { ipcRenderer.removeListener('update:status', handler) }
  },

  // Diagnostics: always user-initiated, never sent automatically.
  copyDiagnostics: (): Promise<string> => ipcRenderer.invoke('diagnostics:copy'),
  openLogsFolder: (): Promise<string> => ipcRenderer.invoke('diagnostics:open-logs'),
  reportBug: (): Promise<void> => ipcRenderer.invoke('diagnostics:report-bug'),

  // archd's ports: read once at startup, then pushed when they change.
  archdPortsSync: (): { api: number; ws: number; runtime: number } => ipcRenderer.sendSync('archd:ports-sync'),
  onArchdPorts: (callback: (ports: { api: number; ws: number; runtime: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ports: { api: number; ws: number; runtime: number }) => callback(ports)
    ipcRenderer.on('archd:ports', handler)
    return () => { ipcRenderer.removeListener('archd:ports', handler) }
  },

  /** archd restarts, recovery, and giving up. Returns an unsubscribe. */
  onArchdStatus: (callback: (status: ArchdStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ArchdStatus) => callback(status)
    ipcRenderer.on('archd:status', handler)
    return () => { ipcRenderer.removeListener('archd:status', handler) }
  },

  onArchdMessage: (callback: (msg: WsMessage) => void) => {
    ipcRenderer.on('archd:message', (_event, msg) => callback(msg))
  },

  removeArchdListener: (callback: (msg: WsMessage) => void) => {
    ipcRenderer.removeListener('archd:message', (_event: Electron.IpcRendererEvent, msg: WsMessage) => callback(msg))
  },
})

export interface AgentHostInfo {
  id: string
  label: string
  familyId: string
  familyLabel: string
  modality: 'cli' | 'vscode' | 'desktop' | 'editor'
  modalityLabel: string
  /** Other surfaces covered by this same configuration file. */
  sharedSurfaces: { id: string; label: string }[]
  /** Whether this agent looks installed on this machine. */
  detected: boolean
  /** Whether any user or project configuration contains an Axiom MCP entry. */
  configured: boolean
  configuredPaths: string[]
  unreadablePaths: string[]
  workflowInstalled: boolean
  workflowPath: string | null
  configPath: string
  /** Set when the user pointed Axiom at this file themselves. */
  configOverride: string | null
  command: string | null
  triggerKind: 'slash command' | 'skill command' | 'instruction' | 'chat prompt'
  promptText?: string
  restartAction: string
  restartDetail: string
}

export interface AgentOverrideResult {
  ok: boolean
  detail: string
  path?: string
}

export interface AgentInstallResult {
  ok: boolean
  detail: string
  paths: string[]
}

export interface AgentConnection {
  command: string
  args: string[]
  /** False when this install has no MCP entry point on disk. */
  available: boolean
  path: string
  /** A ready-to-paste `mcpServers` entry for this machine. */
  config: string
}

export type UpdateCheckResult = 'up-to-date' | 'available' | 'unavailable' | 'failed'

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; version: string; manual: boolean }
  | { state: 'ready'; version: string }

export type ArchdStatus =
  | { state: 'restarting'; attempt: number }
  | { state: 'running' }
  | { state: 'failed'; reason: string; detail: string }

// Type declaration for the renderer
declare global {
  interface Window {
    axiom: {
      openProjectDialog: () => Promise<ProjectConfig | null>
      openProject: (config: ProjectConfig) => Promise<ProjectConfig>
      chooseDirectory: () => Promise<string | null>
      createProject: (parentDir: string, name: string) => Promise<ProjectConfig>
      listRecentProjects: () => Promise<ProjectConfig[]>
      removeProject: (projectId: string) => Promise<void>
      relocateProject: (projectId: string) => Promise<ProjectConfig | null>
      setProjectHidden: (projectId: string, hidden: boolean) => Promise<ProjectConfig>
      updateProject: (projectId: string, patch: Partial<Pick<ProjectConfig, 'name' | 'ignoredPaths' | 'sourceBoundariesReviewedAt'>>) => Promise<ProjectConfig>
      getResumeProjectId: () => Promise<string | null>
      setResumeProjectId: (projectId: string | null) => Promise<void>
      completeProjectLifecycle: (projectId: string, milestone: 'agentSetupCompletedAt' | 'reviewCompletedAt') => Promise<ProjectConfig>
      sendMutationIntent: (intent: unknown) => void
      saveNodePosition: (id: string, x: number, y: number, projectId: string) => void
      listDir: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean; path: string }>>
      showInFolder: (filePath: string) => void
      openFile: (filePath: string) => void
      getAppInfo: () => Promise<{ version: string; dataDir: string; platform: string; mcpPath: string; archdApiUrl: string; archdWsUrl: string; isPackaged: boolean }>
      getAgentConnection: () => Promise<AgentConnection>
      listAgentHosts: (projectRoot?: string) => Promise<AgentHostInfo[]>
      installAgent: (hostId: string, projectRoot?: string) => Promise<AgentInstallResult>
      installFamily: (familyId: string, projectRoot?: string) => Promise<AgentInstallResult>
      locateAgentHost: (hostId: string) => Promise<AgentOverrideResult>
      clearAgentHostOverride: (hostId: string) => Promise<AgentOverrideResult>
      platform: 'darwin' | 'win32' | 'linux'
      minimize: () => Promise<void>
      maximize: () => Promise<void>
      close: () => Promise<void>
      isMaximized: () => Promise<boolean>
      setTitleBarHeight: (height: number) => Promise<void>
      onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
      onArchdStatus: (callback: (status: ArchdStatus) => void) => () => void
      archdPortsSync: () => { api: number; ws: number; runtime: number }
      onArchdPorts: (callback: (ports: { api: number; ws: number; runtime: number }) => void) => () => void
      restartArchd: () => Promise<void>
      uninstallAgent: (hostId: string, projectRoot?: string) => Promise<AgentInstallResult>
      uninstallAllAgents: (projectRoot?: string) => Promise<AgentInstallResult>
      getUpdateStatus: () => Promise<UpdateStatus>
      installUpdate: () => Promise<void>
      checkForUpdates: () => Promise<UpdateCheckResult>
      getSettings: () => Promise<AppSettings>
      setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
      clearRecentProjects: () => Promise<void>
      onOpenRecent: (callback: (projectId: string) => void) => () => void
      copyText: (text: string) => Promise<void>
      setMenuState: (state: { projectOpen: boolean }) => Promise<void>
      runMenuRole: (role: SystemRole) => Promise<void>
      developerMenuEnabled: () => Promise<boolean>
      onMenuCommand: (callback: (id: CommandId) => void) => () => void
      zoom: (action: 'in' | 'out' | 'reset') => Promise<number>
      toggleFullScreen: () => Promise<void>
      openHelp: (topic: 'docs' | 'privacy' | 'license' | 'releases') => Promise<void>
      getAppPaths: () => Promise<{ config: string; data: string; logs: string }>
      openAppPath: (which: 'config' | 'data' | 'logs') => Promise<string>
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
      copyDiagnostics: () => Promise<string>
      openLogsFolder: () => Promise<string>
      reportBug: () => Promise<void>
      onArchdMessage: (callback: (msg: WsMessage) => void) => void
      removeArchdListener: (callback: (msg: WsMessage) => void) => void
    }
  }
}
