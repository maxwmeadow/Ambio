import claude from '../assets/connectors/claude.svg'
import claudeCode from '../assets/connectors/claudecode.svg'
import codex from '../assets/connectors/codex.svg'
import copilot from '../assets/connectors/githubcopilot.svg'
import antigravity from '../assets/connectors/antigravity.svg'
import cursor from '../assets/connectors/cursor.svg'
import devin from '../assets/connectors/devin.svg'
import windsurf from '../assets/connectors/windsurf.svg'
import jetbrains from '../assets/connectors/jetbrains.svg'
import zed from '../assets/connectors/zedindustries.svg'
import ambio from '../assets/branding/mark.svg'

/** Client routes share their product's mark while keeping distinct names. */
const logos: Record<string, string> = {
  'claude-code': claudeCode,
  'claude-code-vscode': claudeCode,
  'claude-code-jetbrains': claudeCode,
  'claude-desktop': claude,
  codex,
  'codex-ide': codex,
  'codex-app': codex,
  'copilot-cli': copilot,
  copilot,
  'antigravity-cli': antigravity,
  'antigravity-acp': antigravity,
  antigravity,
  'cursor-cli': cursor,
  cursor,
  'devin-cli': devin,
  windsurf,
  jetbrains,
  zed,
}

export function ConnectorLogo({ clientId }: { clientId: string }) {
  const src = clientId === 'chat-setup' || clientId.startsWith('chat:') ? ambio : logos[clientId]
  return src
    ? <img className="ambio-choose__logo" src={src} alt="" aria-hidden="true" draggable={false} />
    : <span className="ambio-choose__logo" aria-hidden="true">◇</span>
}
