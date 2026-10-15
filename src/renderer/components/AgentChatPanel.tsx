import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatConversation, ChatMode, ChatProvider, ChatQuestion, ChatSnapshot } from '../../shared/agentChat'
import { AgentMessageContent } from './AgentMessageContent'
import { ChatProviderSettings } from './ChatProviderSettings'
import { useSheetStore } from '../store/sheetStore'
import { referenceTarget, workOrderNote } from './inboxModel'
import '../styles/agentChat.css'

function QuestionCard({ item, conversationId, done, fail }: { item: ChatQuestion; conversationId: string; done: () => void; fail: (error: unknown) => void }) {
  const [answers, setAnswers] = useState<string[][]>(item.questions.map(() => []))
  const [busy, setBusy] = useState(false)
  const reply = async (value: string[][] | null) => { setBusy(true); try { await window.ambio.answerChat(conversationId, item.id, value); done() } catch (error) { fail(error) } finally { setBusy(false) } }
  return <section className="ambio-chat__request" aria-label="Agent question"><strong>The agent needs your input</strong>{item.questions.map((question, index) => <fieldset key={index} disabled={busy}><legend>{question.question}</legend>{question.options.map(option => <label key={option.label} title={option.description}><input type={question.multiple ? 'checkbox' : 'radio'} name={`${item.id}-${index}`} checked={answers[index].includes(option.label)} onChange={() => setAnswers(value => value.map((answer, i) => i !== index ? answer : question.multiple ? answer.includes(option.label) ? answer.filter(label => label !== option.label) : [...answer, option.label] : [option.label]))} />{option.label}<small>{option.description}</small></label>)}<input aria-label={`Your answer: ${question.header}`} placeholder="Or write your answer" value={answers[index].filter(answer => !question.options.some(option => option.label === answer)).join(', ')} onChange={event => setAnswers(value => value.map((answer, i) => i === index ? event.target.value ? [event.target.value] : [] : answer))} /></fieldset>)}<div className="ambio-chat__actions"><button type="button" disabled={busy || answers.some(answer => !answer.length)} onClick={() => { void reply(answers) }}>Continue</button><button type="button" disabled={busy} onClick={() => { void reply(null) }}>Dismiss question</button></div></section>
}

export function AgentChatPanel({ workspaceId, selection, sheetId, onWorkOrders }: { workspaceId: string; selection: string[]; sheetId: string | null; onWorkOrders: () => void }) {
  const [providers, setProviders] = useState<ChatProvider[]>([])
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [providerId, setProviderId] = useState('')
  const [active, setActive] = useState<string>(() => { try { return localStorage.getItem(`ambio:chat-active:${workspaceId}`) ?? '' } catch { return '' } })
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null)
  const [settings, setSettings] = useState(false)
  const [mode, setMode] = useState<ChatMode>('ask')
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(`ambio:chat-draft:${workspaceId}`) ?? '' } catch { return '' } })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attach, setAttach] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const lock = useRef(false)
  const pendingKey = `ambio:chat-order:${workspaceId}`
  const pendingOrder = useRef<{ id: string; fingerprint: string } | null>((() => {
    try { const saved = JSON.parse(localStorage.getItem(pendingKey) ?? 'null'); return saved && typeof saved.id === 'string' && typeof saved.fingerprint === 'string' ? saved : null } catch { return null }
  })())
  const history = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const composer = useRef<HTMLTextAreaElement>(null)
  const current = useRef(active); current.current = active
  const turnRunning = snapshot && ['working', 'waiting'].includes(snapshot.conversation.state)
  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))
  const reload = async () => { const [services, threads] = await Promise.all([window.ambio.chatProviders(), window.ambio.chatConversations(workspaceId)]); setProviders(services); setConversations(threads); setProviderId(value => services.some(item => item.id === value) ? value : services[0]?.id ?? '') }
  useEffect(() => { let disposed = false; void Promise.all([window.ambio.chatProviders(), window.ambio.chatConversations(workspaceId)]).then(([services, threads]) => { if (disposed) return; setProviders(services); setConversations(threads); setProviderId(services[0]?.id ?? ''); if (active && !threads.some(item => item.id === active)) setActive('') }, fail); return () => { disposed = true } }, [workspaceId])
  useEffect(() => { try { localStorage.setItem(`ambio:chat-draft:${workspaceId}`, draft) } catch { /* draft remains in memory */ } }, [workspaceId, draft])
  useEffect(() => {
    let disposed = false
    setSnapshot(null); setError('')
    try { localStorage.setItem(`ambio:chat-active:${workspaceId}`, active) } catch { /* in-memory selection still works */ }
    if (!active) return
    // The saved copy is complete for a finished turn, so opening a conversation
    // does not start its agent; the poll below takes over while a turn runs.
    void window.ambio.cachedChat(active).then(value => { if (!disposed) { setSnapshot(value); setMode(value.conversation.mode) } }, fail)
    return () => { disposed = true }
  }, [active, workspaceId])
  const running = !!turnRunning
  useEffect(() => {
    if (!active || !running) return
    let disposed = false; let fetching = false
    const refresh = async () => {
      if (fetching) return; fetching = true
      try { const value = await window.ambio.chatSnapshot(active); if (!disposed) { setSnapshot(value); setConversations(items => items.map(item => item.id === active ? value.conversation : item)) } }
      catch (failure) {
        if (disposed) return
        fail(failure)
        // The agent may have exited; the saved state says whether to keep polling.
        try { const value = await window.ambio.cachedChat(active); if (!disposed && !['working', 'waiting'].includes(value.conversation.state)) setSnapshot(value) } catch { /* keep the current history */ }
      }
      finally { fetching = false }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [active, running])
  useEffect(() => { if (nearBottom.current) { history.current?.scrollTo({ top: history.current.scrollHeight }); setUnseen(false) } else setUnseen(true) }, [snapshot])
  const remember = (id: string) => { setActive(id); try { localStorage.setItem(`ambio:chat-active:${workspaceId}`, id) } catch { /* selection remains in memory */ } }
  const choose = (id: string) => { if (busy) return; nearBottom.current = true; remember(id) }
  const create = async () => {
    if (lock.current || !providerId) return; lock.current = true; setBusy(true); setError('')
    try { const conversation = await window.ambio.createChat(workspaceId, providerId); setConversations(items => [conversation, ...items]); remember(conversation.id); setMode('ask') }
    catch (failure) { fail(failure) }
    finally { setBusy(false); lock.current = false }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current || !draft.trim() || turnRunning) return
    lock.current = true; setBusy(true); setError('')
    try {
      let id = active
      if (!id) { const conversation = await window.ambio.createChat(workspaceId, providerId); id = conversation.id; setConversations(items => [conversation, ...items]); remember(id) }
      let text = draft.trim(); let workOrderId: string | undefined
      if (mode === 'build') {
        if (text.length > 15000) throw new Error('Build requests can contain up to 15,000 characters. Shorten the request before creating a work order.')
        const fingerprint = JSON.stringify([id, text, attach ? selection : [], attach ? sheetId : null])
        if (pendingOrder.current?.fingerprint !== fingerprint) pendingOrder.current = { id: crypto.randomUUID(), fingerprint }
        workOrderId = pendingOrder.current.id
        try { localStorage.setItem(pendingKey, JSON.stringify(pendingOrder.current)) } catch { /* in-memory retry remains safe */ }
        await useSheetStore.getState().sendToAgent(workspaceId, workOrderNote('build', text), attach ? selection : [], attach ? sheetId : null, workOrderId)
      } else if (attach && (selection.length || sheetId)) text += `\n\nAttached Ambio context (read-only):\n${selection.join('\n')}${sheetId ? `\nSheet ID: ${sheetId}. Read its current revision using Ambio's tools.` : ''}`
      if (text.length > 32000) throw new Error('This message and its attached context exceed 32,000 characters. Shorten the message or remove the attachment.')
      await window.ambio.sendChat({ conversationId: id, text, mode, workOrderId })
      pendingOrder.current = null
      try { localStorage.removeItem(pendingKey) } catch { /* acknowledged in memory */ }
      setDraft(''); nearBottom.current = true
      try { localStorage.setItem(`ambio:chat-draft:${workspaceId}`, '') } catch { /* acknowledged in memory */ }
      const value = await window.ambio.cachedChat(id); setSnapshot({ ...value, conversation: { ...value.conversation, state: 'working' } })
      requestAnimationFrame(() => composer.current?.focus())
    } catch (failure) {
      fail(failure)
      if (current.current) try { setSnapshot(await window.ambio.cachedChat(current.current)) } catch { /* retain the existing history */ }
    }
    finally { setBusy(false); lock.current = false }
  }
  const selectedProvider = providers.find(item => item.id === (snapshot?.conversation.providerId ?? providerId))
  return <div className="ambio-chat" aria-label="Chat in Ambio">
    <div className="ambio-chat__toolbar"><label className="ambio-chat__conversation-label">Conversation<select aria-label="Conversation" value={active} disabled={busy} onChange={event => choose(event.target.value)}><option value="">New conversation</option>{conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button type="button" disabled={busy} onClick={() => setSettings(value => !value)}>Model services</button></div>
    {settings ? <ChatProviderSettings providers={providers} onClose={() => setSettings(false)} onSaved={profile => { void reload().then(() => { if (profile) setProviderId(profile.id); setSettings(false) }, fail) }} /> : <>
      {!active && providers.length > 0 && <div className="ambio-chat__service"><label>Use service<select aria-label="Chat service" value={providerId} disabled={busy} onChange={event => setProviderId(event.target.value)}>{providers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label><button type="button" onClick={() => { void create() }} disabled={busy || !providerId}>{busy ? 'Starting…' : 'Start conversation'}</button></div>}
      {active && <div className="ambio-chat__service"><span>{selectedProvider?.name ?? 'Service removed'} · {snapshot?.conversation.model ?? 'Loading…'}</span><button type="button" disabled={busy} onClick={() => choose('')}>New conversation</button></div>}
      {selectedProvider?.hasKey && !selectedProvider.persistentKey && <p className="ambio-chat__notice">Your system keychain is unavailable. The key is kept for this app session only; enter it again after restarting.</p>}
      {error && <div className="ambio-chat__error" role="alert">{error}<button type="button" onClick={() => setSettings(true)}>Check service</button></div>}
      <div className="ambio-chat__history" ref={history} aria-label="Conversation messages" onScroll={() => { if (!history.current) return; nearBottom.current = history.current.scrollHeight - history.current.scrollTop - history.current.clientHeight < 60; if (nearBottom.current) setUnseen(false) }}>
        {!snapshot?.messages.length && <div className="ambio-chat__welcome"><span className="ambio-chat__spark">✦</span><h3>Your architecture, in conversation.</h3><p>{providers.length ? 'Ask about your project, explore a plan, or build a change together. Selected canvas items come along.' : 'Connect your model service to chat and build here. Your existing agents are still available in Work orders.'}</p>{!providers.length && <button className="ambio-chat__primary" type="button" onClick={() => setSettings(true)}>Connect a model service</button>}</div>}
        {snapshot?.messages.map(message => <article key={message.id} className={`ambio-chat__message ambio-chat__message--${message.role}`}><strong>{message.role === 'user' ? 'You' : 'Ambio agent'}</strong>{message.parts.map(part => part.kind === 'text' ? <AgentMessageContent key={part.id} text={part.text} /> : <details key={part.id} className="ambio-chat__tool"><summary><span className={`ambio-chat__tool-state ambio-chat__tool-state--${part.state}`} />{part.tool} <small>{part.state}</small></summary><pre>{part.text}</pre></details>)}</article>)}
        {snapshot?.approvals.map(item => <section key={item.id} className="ambio-chat__request" aria-label="Action approval"><strong>Allow this action?</strong><p>{item.permission}</p><pre>{item.patterns.join('\n')}</pre><div className="ambio-chat__actions"><button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await window.ambio.approveChat(active, item.id, false) } catch (failure) { fail(failure) } finally { setBusy(false) } }}>Deny</button><button type="button" disabled={busy || mode === 'ask'} onClick={async () => { setBusy(true); try { await window.ambio.approveChat(active, item.id, true) } catch (failure) { fail(failure) } finally { setBusy(false) } }}>Allow once</button></div></section>)}
        {snapshot?.questions.map(item => <QuestionCard key={item.id} item={item} conversationId={active} fail={fail} done={() => { void window.ambio.chatSnapshot(active).then(setSnapshot, fail) }} />)}
      </div>
      {unseen && <button className="ambio-chat__latest" type="button" onClick={() => { nearBottom.current = true; history.current?.scrollTo({ top: history.current.scrollHeight }); setUnseen(false) }}>Jump to latest ↓</button>}
      {snapshot && <div className="ambio-chat__status" role="status"><span className={turnRunning ? 'ambio-chat__pulse' : ''} />{busy ? 'Sending…' : snapshot.conversation.state === 'waiting' ? 'Waiting for you' : snapshot.conversation.state === 'working' ? 'Working…' : snapshot.conversation.error ?? 'Ready for your next message'}{(turnRunning || snapshot.conversation.state === 'interrupted') && <button type="button" disabled={busy} onClick={() => { void window.ambio.stopChat(active).then(() => turnRunning ? window.ambio.chatSnapshot(active) : window.ambio.cachedChat(active)).then(setSnapshot, fail) }}>{turnRunning ? 'Stop' : 'Stop previous run'}</button>}</div>}
      {snapshot?.conversation.workOrderId && <button type="button" className="ambio-chat__review" onClick={onWorkOrders}>Open work orders & review changes →</button>}
      <form className="ambio-chat__compose" onSubmit={submit}><div className="ambio-chat__compose-heading"><div role="radiogroup" aria-label="Conversation mode"><button type="button" role="radio" aria-checked={mode === 'ask'} disabled={busy || !!turnRunning} onClick={() => setMode('ask')}>Ask</button><button type="button" role="radio" aria-checked={mode === 'build'} disabled={busy || !!turnRunning} onClick={() => setMode('build')}>Build</button></div><span>{mode === 'ask' ? 'Read-only discussion' : 'Edits through a reviewable work order'}</span></div>
        {(selection.length > 0 || sheetId) && <label className="ambio-chat__context"><input type="checkbox" checked={attach} disabled={busy || !!turnRunning} onChange={event => setAttach(event.target.checked)} />Include {selection.length ? selection.map(ref => referenceTarget(ref).label).join(', ') : 'active sheet'}{sheetId && selection.length ? ' + active sheet' : ''}</label>}
        <textarea ref={composer} aria-label="Message integrated agent" placeholder={mode === 'ask' ? 'Ask about your architecture…' : 'Describe the change to build…'} value={draft} maxLength={32000} rows={3} disabled={busy || !providers.length} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
        <div className="ambio-chat__compose-footer"><span>Enter to send · Shift+Enter for a new line</span><button className="ambio-chat__primary" type="submit" disabled={busy || !!turnRunning || !draft.trim() || !providers.length || (!active && !providerId) || selection.length > 100}>Send</button></div>
      </form>
    </>}
  </div>
}
