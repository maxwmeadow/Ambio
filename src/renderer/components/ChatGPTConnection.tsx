import { useEffect, useRef, useState } from 'react'
import type { ChatGPTModel, ChatGPTState } from '../../shared/chatgpt'
import { CHAT_PROVIDERS_CHANGED } from './AgentChatPanel'
import openaiLogo from '../assets/connectors/codex.svg'

/** Account and model controls; credentials remain behind the preload boundary. */
export function ChatGPTConnection({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<ChatGPTState>()
  const [models, setModels] = useState<ChatGPTModel[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const active = useRef(true)
  const profile = state?.profiles.find(item => item.id === state.activeId)
  const connected = !!profile?.connected && !!profile.sharing
  const update = async (next: ChatGPTState) => {
    if (!active.current) return
    setState(next); setModels([])
    if (next.modelError) setNotice(next.modelError)
    const selected = next.profiles.find(item => item.id === next.activeId && item.sharing)
    setModels((selected?.models ?? []).map(slug => ({ slug, displayName: slug })))
  }
  useEffect(() => {
    active.current = true
    void window.ambio.getChatGPTState().then(update).catch(error => { if (active.current) setNotice(String(error)) })
    return () => { active.current = false }
  }, [])
  const act = async (name: string, operation: () => Promise<ChatGPTState | void>) => {
    setBusy(name); setNotice('')
    try {
      const next = await operation()
      if (next) {
        await update(next)
        onChanged?.()
        window.dispatchEvent(new Event(CHAT_PROVIDERS_CHANGED))
      }
    } catch (error) {
      if (active.current) setNotice(error instanceof Error ? error.message : String(error))
    } finally { if (active.current) setBusy('') }
  }
  return <section aria-label="ChatGPT connection" className="ambio-chatgpt">
    <header className="ambio-agent-settings__card-heading">
      <img src={openaiLogo} width="28" height="28" alt="" aria-hidden="true" />
      <div><h3>ChatGPT</h3><p>Use your plan&rsquo;s usage limits</p></div>
      <span className="ambio-agent-settings__badge" data-connected={connected}>{!state ? notice ? 'Could not check' : 'Checking…' : connected ? 'Connected' : profile?.connected ? 'Needs approval' : 'Not connected'}</span>
    </header>
    <p className="ambio-settings__text">{connected ? 'Your ChatGPT plan powers Ambio’s built-in agent. Requests share your plan’s limits.' : 'Sign in with your eligible ChatGPT plan to power Ambio’s built-in agent. Approve plan usage in your browser.'}</p>
    {state && !state.secureStorage && <p className="ambio-settings__text">Unlock your OS credential store to connect. ChatGPT credentials require secure storage.</p>}
    {profile && <p className="ambio-agent-settings__account">{profile.email || profile.label}{profile.connected && !profile.sharing ? ' · Plan usage not approved' : ''}</p>}
    <div className="ambio-chatgpt__actions">
      {!connected && <button type="button" className="ambio-chat__primary" disabled={!!busy || !state?.secureStorage} onClick={() => void act('sign-in', () => window.ambio.signInChatGPT(profile?.id))}>
        {busy === 'sign-in' ? 'Waiting for ChatGPT…' : profile ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}
      </button>}
      {(busy === 'sign-in' || busy === 'add' || state?.signingIn) && <button type="button" onClick={() => void window.ambio.cancelChatGPTSignIn()}>Cancel sign-in</button>}
      {connected && <button type="button" onClick={() => void act('usage', () => window.ambio.manageChatGPTUsage())}>Manage usage</button>}
    </div>
    {profile && <details className="ambio-agent-settings__advanced">
      <summary>Account and model settings</summary>
      <div className="ambio-settings__row">
      <label htmlFor="chatgpt-account">ChatGPT account</label>
      <select id="chatgpt-account" value={state?.activeId ?? ''} disabled={!!busy} onChange={event => void act('switch', () => window.ambio.selectChatGPTProfile(event.target.value))}>
        {state?.profiles.map(item => <option key={item.id} value={item.id}>{item.label}{item.email ? ` · ${item.email}` : ''}{item.connected ? '' : ' · signed out'}</option>)}
      </select>
    </div>
    {profile?.sharing && <div className="ambio-settings__row">
      <label htmlFor="chatgpt-model">ChatGPT model</label>
      <select id="chatgpt-model" disabled={!!busy || !models.length} value={state?.model ?? models[0]?.slug ?? ''} onChange={event => void act('model', () => window.ambio.selectChatGPTModel(event.target.value))}>
        {!models.length && <option value="">Models unavailable</option>}
        {models.map(model => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
      </select>
    </div>}
    <div className="ambio-chatgpt__actions">
      <button type="button" disabled={!!busy} onClick={() => void act('add', () => window.ambio.signInChatGPT())}>Add account or workspace</button>
      {profile?.connected && <button type="button" className="ambio-settings__button" disabled={!!busy} onClick={() => void act('sign-out', async () => {
        const result = await window.ambio.signOutChatGPT()
        if (active.current) setNotice(result.detail)
        return result.state
      })}>Sign out</button>}
      {!connected && <button type="button" onClick={() => void act('usage', () => window.ambio.manageChatGPTUsage())}>Manage usage</button>}
      {profile?.sharing && <button type="button" className="ambio-settings__button" disabled={!!busy} onClick={() => void act('refresh', async () => { await window.ambio.listChatGPTModels(); return window.ambio.getChatGPTState() })}>Refresh models</button>}
    </div>
    </details>}
    <p className="ambio-chat__privacy">Messages and project context the agent reads are sent to OpenAI.</p>
    {notice && <p className="ambio-settings__text" role="status">{notice}</p>}
    {!state && notice && <button type="button" className="ambio-settings__button" disabled={!!busy} onClick={() => void act('refresh', () => window.ambio.getChatGPTState())}>Retry connection status</button>}
  </section>
}
