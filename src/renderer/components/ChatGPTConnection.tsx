import { useEffect, useRef, useState } from 'react'
import type { ChatGPTModel, ChatGPTState } from '../../shared/chatgpt'

/** Account and model controls; credentials remain behind the preload boundary. */
export function ChatGPTConnection() {
  const [state, setState] = useState<ChatGPTState>()
  const [models, setModels] = useState<ChatGPTModel[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const active = useRef(true)
  const profile = state?.profiles.find(item => item.id === state.activeId)
  const update = async (next: ChatGPTState) => {
    if (!active.current) return
    setState(next); setModels([])
    window.dispatchEvent(new Event('ambio-chatgpt-changed'))
    if (next.profiles.some(item => item.id === next.activeId && item.sharing)) {
      const available = await window.ambio.listChatGPTModels()
      if (active.current) setModels(available)
    }
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
      if (next) await update(next)
    } catch (error) {
      if (active.current) setNotice(error instanceof Error ? error.message : String(error))
    } finally { if (active.current) setBusy('') }
  }
  return <section aria-label="ChatGPT connection" className="ambio-chatgpt">
    <h3>ChatGPT</h3>
    <p className="ambio-settings__text">Use your eligible ChatGPT plan for conversations in Ambio. Sign in in your browser and approve plan usage. Requests share your plan's limits.</p>
    {state && !state.secureStorage && <p role="status">Unlock your OS credential store to connect. ChatGPT credentials require secure storage.</p>}
    {state && !state.harnessInstalled && <p className="ambio-settings__text">Install <a href="https://developers.openai.com/codex/cli" target="_blank" rel="noreferrer">Codex CLI</a> to run ChatGPT conversations, then restart Ambio. Sign-in does not require a separate Codex account.</p>}
    {(state?.profiles.length ?? 0) > 0 && <div className="ambio-settings__row">
      <label htmlFor="chatgpt-account">ChatGPT account</label>
      <select id="chatgpt-account" value={state?.activeId ?? ''} disabled={!!busy} onChange={event => void act('switch', () => window.ambio.selectChatGPTProfile(event.target.value))}>
        {state?.profiles.map(item => <option key={item.id} value={item.id}>{item.label}{item.email ? ` · ${item.email}` : ''}{item.connected ? '' : ' · signed out'}</option>)}
      </select>
    </div>}
    {profile && <p className="ambio-settings__text">{profile.connected ? profile.sharing ? 'Connected · ChatGPT plan usage enabled' : 'Connected · plan usage was not approved. Reconnect to enable it.' : 'Signed out'}</p>}
    {profile?.sharing && <div className="ambio-settings__row">
      <label htmlFor="chatgpt-model">ChatGPT model</label>
      <select id="chatgpt-model" disabled={!!busy || !models.length} value={state?.model ?? models[0]?.slug ?? ''} onChange={event => void act('model', () => window.ambio.selectChatGPTModel(event.target.value))}>
        {!models.length && <option value="">Models unavailable</option>}
        {models.map(model => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
      </select>
    </div>}
    <div className="ambio-chatgpt__actions">
      <button type="button" className="ambio-settings__button" disabled={!!busy || !state?.secureStorage} onClick={() => void act('sign-in', () => window.ambio.signInChatGPT(profile?.id))}>
        {busy === 'sign-in' ? 'Waiting for ChatGPT…' : profile ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}
      </button>
      {(busy === 'sign-in' || busy === 'add' || state?.signingIn) && <button type="button" className="ambio-settings__button" onClick={() => void window.ambio.cancelChatGPTSignIn()}>Cancel sign-in</button>}
      {profile && <button type="button" className="ambio-settings__button" disabled={!!busy} onClick={() => void act('add', () => window.ambio.signInChatGPT())}>Add account or workspace</button>}
      {profile?.connected && <button type="button" className="ambio-settings__button" disabled={!!busy} onClick={() => void act('sign-out', async () => {
        const result = await window.ambio.signOutChatGPT()
        if (active.current) setNotice(result.detail)
        return result.state
      })}>Sign out</button>}
      <button type="button" className="ambio-settings__button" onClick={() => void act('usage', () => window.ambio.manageChatGPTUsage())}>Manage usage</button>
      {profile?.sharing && <button type="button" className="ambio-settings__button" disabled={!!busy} onClick={() => void act('refresh', () => window.ambio.getChatGPTState())}>Refresh models</button>}
    </div>
    <p className="ambio-settings__text">Choose ChatGPT under Deliver to in a conversation. Ask and Propose can read the project; Build can edit it. The conversation and project context the agent reads are sent to OpenAI when you send a turn.</p>
    {notice && <p className="ambio-settings__text" role="status">{notice}</p>}
    {!state && notice && <button type="button" className="ambio-settings__button" disabled={!!busy} onClick={() => void act('refresh', () => window.ambio.getChatGPTState())}>Retry connection status</button>}
  </section>
}
