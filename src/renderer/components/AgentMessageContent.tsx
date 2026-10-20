import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useShowOnMap } from '../canvas/useShowOnMap'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { architectureLinkTarget, fileLinkTarget, inlineFilePath, normalizeAgentText, remarkFilePaths, remarkArchitectureNames } from './agentMessageFormat'
import { useSheetStore } from '../store/sheetStore'
import { InboxIcon } from './InboxIcon'

function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [status, setStatus] = useState('Copy code')
  return <div className="ambio-inbox__code"><div><span>{language || 'Code'}</span><button type="button" aria-label={status} onClick={() => { void navigator.clipboard.writeText(text).then(() => setStatus('Copied'), () => setStatus('Copy unavailable')) }}><InboxIcon name={status === 'Copied' ? 'check' : 'copy'} size={13} />{status}</button></div><pre><code>{text}</code></pre></div>
}

/** A file the agent named: its path in the project, opening it on the map when Ambio indexed it. */
function FileChip({ relPath, absolute, lines, fileId, written }: { relPath?: string; absolute: string; lines?: string; fileId?: string; written?: string }) {
  // Inline code keeps what the agent wrote, even a shortened name; a link shows its path.
  const label = written ?? `${relPath ?? absolute.split('/').pop()}${lines ? `:${lines.replace('-', '–')}` : ''}`
  const showOnMap = useShowOnMap()
  const open = () => {
    if (fileId) showOnMap(fileId)
    else window.ambio?.showInFolder(absolute)
  }
  return <button type="button" className="ambio-inbox__file-link" title={fileId ? `Show ${relPath} on the map` : absolute} onClick={open}>{label}</button>
}

/**
 * Which link targets a message may carry: the web, mail, relative links, and
 * file links (which become file chips). Anything else, such as javascript:, is
 * dropped, as react-markdown's own default would; that default also dropped
 * file links, which agents use for every path they cite.
 */
const safeUrl = (url: string) => /^(https?:|mailto:|file:|ambio:)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : ''

const textOf = (node: ReactNode): string => typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(textOf).join('')
    : node && typeof node === 'object' && 'props' in node ? textOf((node as ReactElement<{ children?: ReactNode }>).props.children) : ''

/**
 * An agent's message, as Markdown: emphasis, lists, tables, code and links,
 * with file paths turned into chips that open the file. Raw HTML is shown as
 * text, never run.
 */
export function AgentMessageContent({ text }: { text: string }) {
  const sheets = useSheetStore(s => s.sheets)
  const systems = useGraphStore(s => s.systems)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const references = useMemo(() => [...sheets.map(sheet => ({ id: sheet.id, name: sheet.name, type: 'sheet' as const })), ...systems.map(system => ({ id: system.id, name: system.name, type: 'system' as const }))], [sheets, systems])
  const showOnMap = useShowOnMap()
  const { root, files } = useGraphStore(useShallow(state => ({ root: state.currentProject?.rootPath, files: state.files })))
  const byPath = useMemo(() => new Map(files.map(file => [file.relPath.replace(/\\/g, '/'), file.id])), [files])
  const paths = useMemo(() => new Set(byPath.keys()), [byPath])
  const plugins = useMemo(() => [remarkGfm, remarkArchitectureNames(references), remarkFilePaths(paths)], [paths, references])
  const components: Components = useMemo(() => ({
    h1: ({ children }) => <h4>{children}</h4>,
    h2: ({ children }) => <h4>{children}</h4>,
    h3: ({ children }) => <h4>{children}</h4>,
    h4: ({ children }) => <h4>{children}</h4>,
    h5: ({ children }) => <h4>{children}</h4>,
    h6: ({ children }) => <h4>{children}</h4>,
    a: ({ href, children }) => {
      if (href && /^ambio:/i.test(href)) {
        try {
          const target = architectureLinkTarget(href)
          const reference = target && references.find(item => item.id === target.id && item.type === target.type)
          if (!reference) return <span>{children}</span>
          return <button type="button" className="ambio-inbox__file-link" onClick={() => reference.type === 'sheet' ? void useSheetStore.getState().openSheet(workspaceId, reference.id) : showOnMap(reference.id)}>{reference.name}</button>
        } catch { return <span>{children}</span> }
      }
      const target = fileLinkTarget(href, root)
      if (target) return <FileChip {...target} fileId={target.relPath ? byPath.get(target.relPath) : undefined} />
      // Web links open in the browser (the window's open handler), never inside Ambio.
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>
    },
    pre: ({ children }) => {
      const code = Array.isArray(children) ? children[0] : children
      const className = (code as ReactElement<{ className?: string }> | undefined)?.props?.className ?? ''
      return <CodeBlock text={textOf(children).replace(/\n$/, '')} language={/language-([\w+#.-]+)/.exec(className)?.[1]} />
    },
    code: ({ children, className }) => {
      // Inline code naming a project file becomes a chip; anything else stays code.
      const path = !className && typeof children === 'string' ? inlineFilePath(children, paths) : null
      return path ? <FileChip relPath={path} absolute={path} fileId={byPath.get(path)} written={(children as string).trim()} /> : <code className={className}>{children}</code>
    },
    table: ({ children }) => <div className="ambio-inbox__table"><table>{children}</table></div>,
  }), [root, byPath, paths, references, workspaceId, showOnMap])
  return <div className="ambio-inbox__prose">
    <Markdown remarkPlugins={plugins} components={components} urlTransform={safeUrl}>{normalizeAgentText(text, root)}</Markdown>
  </div>
}
