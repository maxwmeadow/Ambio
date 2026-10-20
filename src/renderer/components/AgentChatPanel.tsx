import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ChatConversation, ChatMessage, ChatMode, ChatProvider, ChatQuestion, ChatSnapshot } from '../../shared/agentChat'
import { AgentMessageContent } from './AgentMessageContent'
import { InboxIcon } from './InboxIcon'
import { WorkOrderReview } from './WorkOrderReview'
import { WorkOrderCodeChecks } from './WorkOrderCodeChecks'
import { useSheetStore, type CanvasMessage } from '../store/sheetStore'
import { inboxStatus, requestText, WORK_ORDER_MODES, workOrderNote } from './inboxModel'
import { conversationKey, useConversationPreferences } from '../store/conversationPreferences'
import '../styles/agentChat.css'

/**
 * Ambio's own chat agent, as one kind of conversation in the agent panel.
 *
 * An agent Ambio starts or hands off to answers one turn at a time through a
 * work order; this one streams. So the panel shares everything around the
 * transcript (the conversation list, modes, attachments, the composer) and
 * this module supplies the two things that differ: how a turn is sent, and
 * how the conversation reads while it happens.
 */

/** Settings saves a model service; open panels pick it up. */
export const CHAT_PROVIDERS_CHANGED = 'ambio:chat-providers-changed'
/** The panel asks for Settings → Agents, at Ambio chat's model services. */
export const OPEN_MODEL_SERVICES = 'ambio:open-model-services'

/** The thread a built-in conversation's Build work orders share. */
export const chatThreadId = (conversationId: string) => `chat:${conversationId}`

export function useAgentChat(workspaceId: string, isOpen: boolean, activeId: string | null) {
  const [providers, setProviders] = useState<ChatProvider[]>([])
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const lock = useRef(false)
  const lastStates = useRef(new Map<string, string>())
  const pendingKey = `ambio:chat-order:${workspaceId}`
  // A Build turn's work order keeps its id across retries, so a lost
  // acknowledgement never creates a second one.
  const pendingOrder = useRef<{ id: string; fingerprint: string } | null>(null)
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(pendingKey) ?? 'null'); pendingOrder.current = saved && typeof saved.id === 'string' && typeof saved.fingerprint === 'string' ? saved : null } catch { pendingOrder.current = null }
  }, [pendingKey])
  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))
  const reload = useCallback(async () => {
    if (!workspaceId || !window.ambio?.chatProviders) return
    const request = ++generation.current
    try {
      const [services, threads] = await Promise.all([window.ambio.chatProviders(), window.ambio.chatConversations(workspaceId)])
      if (generation.current !== request) return
      for (const thread of threads) {
        const previous = lastStates.current.get(thread.id)
        if (previous && ['working', 'waiting'].includes(previous) && thread.state === 'idle' && !thread.workOrderId && !document.hasFocus()) void window.ambio.notify({ title: `New reply: ${useConversationPreferences.getState().items[conversationKey(workspaceId, thread.id)]?.title || thread.title}`, body: 'Open the conversation to read it.', tag: `chat:${thread.id}`, workspaceId, threadId: thread.id })
        lastStates.current.set(thread.id, thread.state)
      }
      setProviders(services); setConversations(threads)
    } catch (failure) { fail(failure) }
  }, [workspaceId])
  useEffect(() => {
    void reload()
    const timer = setInterval(() => { void reload() }, 3000)
    return () => clearInterval(timer)
  }, [reload])
  useEffect(() => {
    const changed = () => { void reload() }
    window.addEventListener(CHAT_PROVIDERS_CHANGED, changed)
    return () => window.removeEventListener(CHAT_PROVIDERS_CHANGED, changed)
  }, [reload])
  useEffect(() => {
    let disposed = false
    setSnapshot(null); setError('')
    if (!activeId) return
    // The saved copy is complete for a finished turn, so opening a conversation
    // does not start its agent; the poll below takes over while a turn runs.
    void window.ambio.cachedChat(activeId).then(value => { if (!disposed) setSnapshot(value) }, fail)
    return () => { disposed = true }
  }, [activeId])
  const running = !!snapshot && ['working', 'waiting'].includes(snapshot.conversation.state)
  useEffect(() => {
    if (!activeId || !running) return
    let disposed = false; let fetching = false
    const refresh = async () => {
      if (fetching) return; fetching = true
      try {
        const value = await window.ambio.chatSnapshot(activeId)
        if (!disposed) { setSnapshot(value); setConversations(items => items.map(item => item.id === activeId ? value.conversation : item)) }
      } catch (failure) {
        if (disposed) return
        fail(failure)
        // The agent may have exited; the saved state says whether to keep polling.
        try { const value = await window.ambio.cachedChat(activeId); if (!disposed && !['working', 'waiting'].includes(value.conversation.state)) setSnapshot(value) } catch { /* keep the current history */ }
      } finally { fetching = false }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [activeId, running])

  /** Send one turn; starts the conversation when there is none. Returns its id. */
  const send = async ({ conversationId, providerId, text, mode, selection, sheetId, codeFitFileIds, model }: {
    conversationId: string | null; providerId: string; text: string; mode: ChatMode; selection: string[]; sheetId: string | null; codeFitFileIds: string[]; model?: string
  }): Promise<string | null> => {
    if (lock.current) return null
    lock.current = true; setBusy(true); setError('')
    let id = conversationId
    try {
      if (!id) {
        const conversation = await window.ambio.createChat(workspaceId, providerId, model)
        id = conversation.id
        setConversations(items => [conversation, ...items])
      }
      let message = text; let workOrderId: string | undefined
      if (mode === 'build') {
        // A build is a work order like any other, so its changes are reviewed the same way.
        if (text.length > 15000) throw new Error('Build requests can contain up to 15,000 characters. Shorten the request.')
        const fingerprint = JSON.stringify([id, text, selection, sheetId])
        if (pendingOrder.current?.fingerprint !== fingerprint) pendingOrder.current = { id: crypto.randomUUID(), fingerprint }
        workOrderId = pendingOrder.current.id
        try { localStorage.setItem(pendingKey, JSON.stringify(pendingOrder.current)) } catch { /* in-memory retry remains safe */ }
        await useSheetStore.getState().sendToAgent(workspaceId, workOrderNote('build', text), selection, sheetId, workOrderId, codeFitFileIds, { threadId: chatThreadId(id), mode: 'build' })
      } else if (selection.length || sheetId) {
        message += `${CONTEXT_MARK}${selection.join('\n')}${sheetId ? `\nSheet ID: ${sheetId}. Read its current revision using Ambio's tools.` : ''}`
      }
      if (message.length > 32000) throw new Error('This message and its attached context exceed 32,000 characters. Shorten the message or remove the attachment.')
      await window.ambio.sendChat({ conversationId: id, text: message, mode, workOrderId, ...(model ? { model } : {}) })
      pendingOrder.current = null
      try { localStorage.removeItem(pendingKey) } catch { /* acknowledged in memory */ }
      const value = await window.ambio.cachedChat(id)
      setSnapshot({ ...value, conversation: { ...value.conversation, state: 'working' } })
      setConversations(items => items.map(item => item.id === id ? { ...value.conversation, state: 'working' } : item))
      return id
    } catch (failure) {
      fail(failure)
      if (id) try { setSnapshot(await window.ambio.cachedChat(id)) } catch { /* retain the existing history */ }
      return null
    } finally { setBusy(false); lock.current = false }
  }
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    try { await work() } catch (failure) { fail(failure) } finally { setBusy(false) }
  }
  const stop = () => activeId && act(async () => {
    const wasRunning = running
    await window.ambio.stopChat(activeId)
    setSnapshot(wasRunning ? await window.ambio.chatSnapshot(activeId) : await window.ambio.cachedChat(activeId))
  })
  const approve = (requestId: string, allow: boolean) => activeId && act(() => window.ambio.approveChat(activeId, requestId, allow))
  const answered = () => { if (activeId) void window.ambio.chatSnapshot(activeId).then(setSnapshot, fail) }
  const remove = async (id: string) => {
    generation.current++
    await window.ambio.deleteChat(id)
    setConversations(items => items.filter(item => item.id !== id))
    if (activeId === id) setSnapshot(null)
  }
  return { providers, conversations, remove, snapshot, busy, error, setError, running, send, stop, approve, answered, fail }
}

export type AgentChatState = ReturnType<typeof useAgentChat>

const CONTEXT_MARK = '\n\nAttached Ambio context (read-only):\n'
const HANDOFF = /^Check Ambio work order ([\w-]+) for project[^\n]*\n\n/

/** What the person wrote, and the work order a Build turn created, from what the agent was sent. */
export function chatUserTurn(text: string): { text: string; workOrderId?: string } {
  const handoff = HANDOFF.exec(text)
  const body = handoff ? text.slice(handoff[0].length) : text
  const context = body.indexOf(CONTEXT_MARK)
  return { text: requestText(context >= 0 ? body.slice(0, context) : body), ...(handoff ? { workOrderId: handoff[1] } : {}) }
}

/** The service a conversation uses, as the panel names it. */
export const chatAgentLabel = (provider: ChatProvider | undefined, model?: string) => `Ambio chat · ${provider?.name ?? 'removed service'}${model ? ` · ${model}` : ''}`

export function ChatTranscript({ chat, workspaceId, workOrders, agentLabel }: {
  chat: AgentChatState; workspaceId: string; workOrders: CanvasMessage[]; agentLabel: string
}) {
  const snapshot = chat.snapshot
  if (!snapshot) return null
  // A turn is what the person said and everything the agent did after it.
  const turns: { user?: ChatMessage; replies: ChatMessage[] }[] = []
  for (const message of snapshot.messages) {
    if (message.role === 'user' || !turns.length) turns.push({ user: message.role === 'user' ? message : undefined, replies: message.role === 'user' ? [] : [message] })
    else turns[turns.length - 1].replies.push(message)
  }
  const state = snapshot.conversation.state
  return <>
    {turns.map((turn, index) => {
      const said = turn.user ? chatUserTurn(turn.user.parts.filter(part => part.kind === 'text').map(part => part.text).join('\n')) : null
      const mode = turn.user?.mode ?? (said?.workOrderId ? 'build' : undefined)
      const order = said?.workOrderId ? workOrders.find(item => item.id === said.workOrderId) : undefined
      return <article key={turn.user?.id ?? `turn-${index}`} className="ambio-inbox__message">
        {said && <div className="ambio-inbox__user"><span className="ambio-inbox__entry-label">YOU{mode && <span className="ambio-inbox__turn-mode" data-mode={mode}>{WORK_ORDER_MODES.find(item => item.mode === mode)?.label}</span>}</span><p>{said.text}</p></div>}
        {turn.replies.some(reply => reply.parts.length) && <div className="ambio-inbox__reply ambio-chat__reply">
          <div className="ambio-inbox__reply-heading"><InboxIcon name="agent" size={16} /><strong>{agentLabel}</strong></div>
          {turn.replies.map(reply => <Fragment key={reply.id}>{reply.parts.map(part => part.kind === 'text'
            ? <AgentMessageContent key={part.id} text={part.text} />
            : <details key={part.id} className="ambio-chat__tool"><summary><span className={`ambio-chat__tool-state ambio-chat__tool-state--${part.state}`} />{part.tool}<small>{part.state}</small></summary><pre>{part.text}</pre></details>)}</Fragment>)}
        </div>}
        {order && <>
          <div className="ambio-inbox__meta"><span className={`ambio-inbox__status ambio-inbox__status--${order.status}`}>{inboxStatus(order)}</span></div>
          {order.codeChecks && order.codeChecks.length > 0 && <WorkOrderCodeChecks checks={order.codeChecks} />}
          <WorkOrderReview message={order} workspaceId={workspaceId} currentSheet={useSheetStore.getState().sheets.find(item => item.id === order.sheetId)} />
        </>}
      </article>
    })}
    {snapshot.approvals.map(item => <section key={item.id} className="ambio-inbox__permission" role="group" aria-label={`Permission request: ${item.permission}`}>
      <strong>The agent is asking: {item.permission}</strong>
      {item.patterns.length > 0 && <code>{item.patterns.join('\n')}</code>}
      <div>
        {snapshot.conversation.mode === 'build' && <button type="button" className="ambio-inbox__permission-allow" disabled={chat.busy} onClick={() => { void chat.approve(item.id, true) }}>Allow</button>}
        <button type="button" disabled={chat.busy} onClick={() => { void chat.approve(item.id, false) }}>Don&rsquo;t allow</button>
        <small>It waits for your answer.</small>
      </div>
    </section>)}
    {snapshot.questions.map(item => <QuestionCard key={item.id} item={item} conversationId={snapshot.conversation.id} fail={chat.fail} done={chat.answered} />)}
    {(chat.running || state === 'interrupted' || state === 'failed') && <div className="ambio-chat__status" role="status">
      <span className={chat.running ? 'ambio-chat__pulse' : ''} />
      {state === 'waiting' ? 'Waiting for you' : state === 'working' ? 'Working…' : snapshot.conversation.error ?? 'Stopped'}
      {state === 'interrupted' && <button type="button" disabled={chat.busy} onClick={() => { void chat.stop() }}>Stop previous run</button>}
    </div>}
  </>
}

function QuestionCard({ item, conversationId, done, fail }: { item: ChatQuestion; conversationId: string; done: () => void; fail: (error: unknown) => void }) {
  const [answers, setAnswers] = useState<string[][]>(item.questions.map(() => []))
  const [busy, setBusy] = useState(false)
  const reply = async (value: string[][] | null) => { setBusy(true); try { await window.ambio.answerChat(conversationId, item.id, value); done() } catch (error) { fail(error) } finally { setBusy(false) } }
  return <section className="ambio-chat__request" aria-label="Agent question"><strong>The agent needs your input</strong>{item.questions.map((question, index) => <fieldset key={index} disabled={busy}><legend>{question.question}</legend>{question.options.map(option => <label key={option.label} title={option.description}><input type={question.multiple ? 'checkbox' : 'radio'} name={`${item.id}-${index}`} checked={answers[index].includes(option.label)} onChange={() => setAnswers(value => value.map((answer, i) => i !== index ? answer : question.multiple ? answer.includes(option.label) ? answer.filter(label => label !== option.label) : [...answer, option.label] : [option.label]))} />{option.label}<small>{option.description}</small></label>)}<input aria-label={`Your answer: ${question.header}`} placeholder="Or write your answer" value={answers[index].filter(answer => !question.options.some(option => option.label === answer)).join(', ')} onChange={event => setAnswers(value => value.map((answer, i) => i === index ? event.target.value ? [event.target.value] : [] : answer))} /></fieldset>)}<div className="ambio-chat__actions"><button type="button" disabled={busy || answers.some(answer => !answer.length)} onClick={() => { void reply(answers) }}>Continue</button><button type="button" disabled={busy} onClick={() => { void reply(null) }}>Dismiss question</button></div></section>
}
