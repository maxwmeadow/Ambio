import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useReactFlow } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { fileLinkTarget, inlineFilePath, normalizeAgentText } from './agentMessageFormat'
import { InboxIcon } from './InboxIcon'

function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [status, setStatus] = useState('Copy code')
  return <div className="ambio-inbox__code"><div><span>{language || 'Code'}</span><button type="button" aria-label={status} onClick={() => { void navigator.clipboard.writeText(text).then(() => setStatus('Copied'), () => setStatus('Copy unavailable')) }}><InboxIcon name={status === 'Copied' ? 'check' : 'copy'} size={13} />{status}</button></div><pre><code>{text}</code></pre></div>
}

/** A file the agent named: its path in the project, opening it on the map when Ambio indexed it. */
function FileChip({ relPath, absolute, lines, fileId }: { relPath?: string; absolute: string; lines?: string; fileId?: string }) {
  const label = `${relPath ?? absolute.split('/').pop()}${lines ? `:${lines.replace('-', '–')}` : ''}`
  const { fitView, getInternalNode } = useReactFlow()
  const open = () => {
    if (!fileId) { window.ambio?.showInFolder(absolute); return }
    // As search does: open its system if it is closed, select it, and fly to it.
    const graph = useGraphStore.getState()
    const systemId = graph.files.find(file => file.id === fileId)?.systemId
    if (systemId && !graph.expandedSystemIds.has(systemId)) graph.toggleSystemExpanded(systemId)
    graph.setSelectedNode(fileId)
    graph.setInspectedNode(fileId)
    // Selecting reveals a card hidden at this zoom; fly once it has a size.
    let tries = 0
    const fly = () => {
      if (getInternalNode(fileId)?.measured.width || ++tries > 20) void fitView({ nodes: [{ id: fileId }], duration: 850, padding: 0.5 })
      else setTimeout(fly, 50)
    }
    setTimeout(fly, 50)
  }
  return <button type="button" className="ambio-inbox__file-link" title={fileId ? `Show ${relPath} on the map` : absolute} onClick={open}>{label}</button>
}

/**
 * Which link targets a message may carry: the web, mail, relative links, and
 * file links (which become file chips). Anything else, such as javascript:, is
 * dropped, as react-markdown's own default would; that default also dropped
 * file links, which agents use for every path they cite.
 */
const safeUrl = (url: string) => /^(https?:|mailto:|file:)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : ''

const textOf = (node: ReactNode): string => typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(textOf).join('')
    : node && typeof node === 'object' && 'props' in node ? textOf((node as ReactElement<{ children?: ReactNode }>).props.children) : ''

/**
 * An agent's message, as Markdown: emphasis, lists, tables, code and links,
 * with file paths turned into chips that open the file. Raw HTML is shown as
 * text, never run.
 */
export function AgentMessageContent({ text }: { text: string }) {
  const { root, files } = useGraphStore(useShallow(state => ({ root: state.currentProject?.rootPath, files: state.files })))
  const byPath = useMemo(() => new Map(files.map(file => [file.relPath.replace(/\\/g, '/'), file.id])), [files])
  const paths = useMemo(() => new Set(byPath.keys()), [byPath])
  const components: Components = useMemo(() => ({
    h1: ({ children }) => <h4>{children}</h4>,
    h2: ({ children }) => <h4>{children}</h4>,
    h3: ({ children }) => <h4>{children}</h4>,
    h4: ({ children }) => <h4>{children}</h4>,
    h5: ({ children }) => <h4>{children}</h4>,
    h6: ({ children }) => <h4>{children}</h4>,
    a: ({ href, children }) => {
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
      return path ? <FileChip relPath={path} absolute={path} fileId={byPath.get(path)} /> : <code className={className}>{children}</code>
    },
    table: ({ children }) => <div className="ambio-inbox__table"><table>{children}</table></div>,
  }), [root, byPath, paths])
  return <div className="ambio-inbox__prose">
    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrl}>{normalizeAgentText(text, root)}</Markdown>
  </div>
}
