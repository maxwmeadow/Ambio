/**
 * Which bundled product mark each client route shows (assets/connectors).
 * Client routes share their product's mark while keeping distinct names. Kept
 * apart from the image imports so code outside the renderer bundle can ask it.
 */
export const CONNECTOR_MARKS = {
  'claude-code': 'claudeCode',
  'claude-code-vscode': 'claudeCode',
  'claude-code-jetbrains': 'claudeCode',
  'claude-desktop': 'claude',
  codex: 'codex',
  'codex-ide': 'codex',
  'codex-app': 'codex',
  'copilot-cli': 'copilot',
  copilot: 'copilot',
  'antigravity-cli': 'antigravity',
  'antigravity-acp': 'antigravity',
  antigravity: 'antigravity',
  'cursor-cli': 'cursor',
  cursor: 'cursor',
  'devin-cli': 'devin',
  grok: 'grok',
  muse: 'meta',
  windsurf: 'windsurf',
  jetbrains: 'jetbrains',
  zed: 'zed',
} as const

export type ConnectorMark = typeof CONNECTOR_MARKS[keyof typeof CONNECTOR_MARKS]

/** Whether a client has a bundled product mark; one without shows a neutral glyph. */
export const hasConnectorLogo = (clientId: string): boolean => Object.hasOwn(CONNECTOR_MARKS, clientId)
