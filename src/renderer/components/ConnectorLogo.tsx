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
import meta from '../assets/connectors/meta.svg'
import grok from '../assets/connectors/grok.svg'
import ambio from '../assets/branding/mark.svg'
import { CONNECTOR_MARKS, type ConnectorMark } from './connectorMarks'

const marks: Record<ConnectorMark, string> = { claude, claudeCode, codex, copilot, antigravity, cursor, devin, windsurf, jetbrains, zed, meta, grok }

export function ConnectorLogo({ clientId }: { clientId: string }) {
  const mark = (CONNECTOR_MARKS as Record<string, ConnectorMark | undefined>)[clientId]
  const src = clientId === 'chat-setup' || clientId.startsWith('chat:') ? ambio : mark && marks[mark]
  return src
    ? <img className="ambio-choose__logo" src={src} alt="" aria-hidden="true" draggable={false} />
    : <span className="ambio-choose__logo" aria-hidden="true">◇</span>
}
