import { useState } from 'react'
import { messageBlocks } from './agentMessageFormat'
import { InboxIcon } from './InboxIcon'

function inline(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => part.startsWith('`') && part.endsWith('`')
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part)
}

function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [status, setStatus] = useState('Copy code')
  return <div className="axiom-inbox__code"><div><span>{language || 'Code'}</span><button type="button" aria-label={status} onClick={() => { void navigator.clipboard.writeText(text).then(() => setStatus('Copied'), () => setStatus('Copy unavailable')) }}><InboxIcon name={status === 'Copied' ? 'check' : 'copy'} size={13} />{status}</button></div><pre><code>{text}</code></pre></div>
}

export function AgentMessageContent({ text }: { text: string }) {
  return <div className="axiom-inbox__prose">{messageBlocks(text).map((block, index) => {
    if (block.kind === 'code') return <CodeBlock key={index} text={block.text} language={block.language} />
    if (block.kind === 'heading') return <h4 key={index}>{inline(block.text)}</h4>
    if (block.kind === 'list') {
      const List = block.ordered ? 'ol' : 'ul'
      return <List key={index}>{block.text.split('\n').map((item, i) => <li key={i}>{inline(item)}</li>)}</List>
    }
    return <p key={index}>{inline(block.text)}</p>
  })}</div>
}
