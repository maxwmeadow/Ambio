export interface TerminalProfile {
  id: string
  label: string
  path: string
  args: string[]
}

export interface TerminalStart {
  id: string
  workspaceId: string
  profileId: string
  cols: number
  rows: number
}

export type TerminalEvent =
  | { id: string; type: 'data'; data: string }
  | { id: string; type: 'exit'; exitCode: number }

export interface TerminalBridge {
  profiles: () => Promise<TerminalProfile[]>
  locateProfile: () => Promise<TerminalProfile | null>
  readClipboard: () => Promise<string>
  start: (input: TerminalStart) => Promise<void>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  acknowledge: (id: string, count: number) => void
  stop: (id: string) => Promise<void>
  onEvent: (listener: (event: TerminalEvent) => void) => () => void
}
