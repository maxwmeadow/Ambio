import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CHAT_CONTEXT_WINDOW_MAX, CHAT_CONTEXT_WINDOW_MIN, CHAT_PROVIDER_DEFAULTS, type ChatProvider, type ChatProviderInput, type ChatProviderKind } from '../../shared/agentChat'
import { ChatGPTConnection } from './ChatGPTConnection'
import type { ModelServiceSetupRequest } from '../modelServiceNavigation'
import '../styles/agentSettings.css'

export function ChatProviderSettings({ providers, onSaved, onClose, setupRequest }: { providers: ChatProvider[]; onSaved: (provider: ChatProvider | null) => void; onClose?: () => void; setupRequest?: ModelServiceSetupRequest }) {
  const [input, setInput] = useState<ChatProviderInput>({ kind: 'openai', name: 'OpenAI', baseUrl: CHAT_PROVIDER_DEFAULTS.openai.baseUrl, model: '', apiKey: '' })
  const [models, setModels] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const surface = useRef<HTMLElement>(null)
  const chatGPTSetup = useRef<HTMLDivElement>(null)
  const apiKey = useRef<HTMLInputElement>(null)
  const serviceUrl = useRef<HTMLInputElement>(null)
  const chooser = useRef<HTMLDivElement>(null)
  const apiProviders = providers.filter(item => item.auth !== 'chatgpt')
  const chooseProvider = (kind: ChatProviderKind) => {
    setInput({ kind, ...CHAT_PROVIDER_DEFAULTS[kind], model: '', apiKey: '' })
    setModels([]); setNotice(''); setError(''); setEditorOpen(true)
  }
  useEffect(() => {
    if (!setupRequest) return
    const kind = setupRequest.provider
    if (kind && kind !== 'chatgpt') {
      chooseProvider(kind)
    }
    if (kind === 'chatgpt') setEditorOpen(false)
    // Run after the dialog mounts and the provider form has rendered.
    const frame = requestAnimationFrame(() => {
      const target = kind === 'chatgpt' ? chatGPTSetup.current : kind === 'compatible' ? serviceUrl.current : kind ? apiKey.current : surface.current
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: !kind || kind === 'chatgpt' ? 'start' : 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [setupRequest])
  useEffect(() => {
    if (!editorOpen) return
    const frame = requestAnimationFrame(() => {
      const field = input.kind === 'compatible' ? serviceUrl.current : apiKey.current
      field?.focus({ preventScroll: true }); field?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [editorOpen, input.kind, input.id])
  const closeEditor = () => { setEditorOpen(false); chooser.current?.focus() }
  const select = (id: string) => {
    const profile = providers.find(item => item.id === id)
    setInput(profile ? { id: profile.id, kind: profile.kind, name: profile.name, baseUrl: profile.baseUrl, model: profile.model, contextWindow: profile.contextWindow, apiKey: '' } : { kind: 'openai', name: 'OpenAI', baseUrl: CHAT_PROVIDER_DEFAULTS.openai.baseUrl, model: '', apiKey: '' })
    setModels(profile?.models ?? []); setNotice(''); setError('')
    setEditorOpen(true)
  }
  const test = async () => {
    setBusy(true); setError(''); setNotice('Checking your service…')
    try {
      const result = await window.ambio.testChatProvider(input)
      setModels(result.models); setNotice(result.detail)
      if (!input.model && result.models.length) setInput(value => ({ ...value, model: result.models[0] }))
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Connection failed.'); setNotice('') }
    finally { setBusy(false) }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    try { const profile = await window.ambio.saveChatProvider({ ...input, ...(models.length ? { models } : {}) }); setInput(value => ({ ...value, apiKey: '' })); onSaved(profile); closeEditor() }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save service.') }
    finally { setBusy(false) }
  }
  return <section className="ambio-chat__settings" aria-label="Model services" ref={surface} tabIndex={-1}>
    <p className="ambio-agent-settings__intro">Ambio&rsquo;s most native experience: an agent built into your workspace.</p>
    {onClose && <button type="button" onClick={onClose}>Close model services</button>}
    <div ref={chatGPTSetup} tabIndex={-1}><ChatGPTConnection onChanged={() => onSaved(null)} /></div>
    <section className="ambio-agent-settings__api" aria-label="API key connections">
      <header className="ambio-agent-settings__card-heading"><div><h3>Use an API key</h3><p>Connect your own model provider</p></div></header>
      <p className="ambio-settings__text">API calls use your provider account and are billed by that provider.</p>
      {apiProviders.length > 0 && <ul className="ambio-agent-settings__saved" aria-label="Saved API connections">
        {apiProviders.map(provider => <li key={provider.id}>
          <div><strong>{provider.name}</strong><small>{CHAT_PROVIDER_DEFAULTS[provider.kind].name} · {provider.model}</small></div>
          <button type="button" disabled={busy} aria-label={`Edit ${provider.name}`} onClick={() => select(provider.id)}>Edit</button>
        </li>)}
      </ul>}
      <div className="ambio-agent-settings__provider-choices" ref={chooser} tabIndex={-1} role="group" aria-label="Add an API connection">
        {(Object.entries(CHAT_PROVIDER_DEFAULTS) as Array<[ChatProviderKind, typeof CHAT_PROVIDER_DEFAULTS[ChatProviderKind]]>).map(([kind, provider]) =>
          <button key={kind} type="button" disabled={busy} aria-label={`Add ${provider.name} API connection`} aria-pressed={editorOpen && !input.id && input.kind === kind} onClick={() => chooseProvider(kind)}>{provider.name}</button>)}
      </div>
    {editorOpen && <form onSubmit={save} className="ambio-agent-settings__editor">
      <header className="ambio-agent-settings__card-heading"><div><h4>{input.id ? `Edit ${input.name}` : `Connect ${CHAT_PROVIDER_DEFAULTS[input.kind].name}`}</h4><p>Add a key, check the connection, then choose a model.</p></div><button type="button" disabled={busy} onClick={closeEditor} aria-label="Close API connection setup">×</button></header>
      <label>Provider<select aria-label="Model provider" value={input.kind} disabled={busy || !!input.id} onChange={event => { const kind = event.target.value as ChatProviderKind; setInput({ kind, ...CHAT_PROVIDER_DEFAULTS[kind], model: '', apiKey: '' }); setModels([]); setNotice('') }}>{Object.entries(CHAT_PROVIDER_DEFAULTS).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
      {input.kind === 'compatible' && <label>Service URL<input ref={serviceUrl} aria-label="Service URL" type="url" value={input.baseUrl} required disabled={busy} placeholder="https://your-service.example/v1" onChange={event => setInput(value => ({ ...value, baseUrl: event.target.value }))} /></label>}
      <label>API key<input ref={apiKey} aria-label="Service API key" type="password" autoComplete="off" spellCheck={false} value={input.apiKey} disabled={busy} placeholder={input.id ? 'Leave blank to keep your saved key' : 'Your provider API key'} onChange={event => setInput(value => ({ ...value, apiKey: event.target.value }))} /></label>
      <div className="ambio-chat__actions"><button type="button" disabled={busy || !input.baseUrl} onClick={() => { void test() }}>{busy ? 'Connecting…' : 'Test connection & find models'}</button></div>
      <label>Model<input aria-label="Service model" value={input.model} list="ambio-chat-models" required disabled={busy} placeholder="Choose or enter a model ID" onChange={event => setInput(value => ({ ...value, model: event.target.value }))} /><datalist id="ambio-chat-models">{models.map(model => <option key={model} value={model} />)}</datalist></label>
      <details className="ambio-agent-settings__advanced"><summary>Advanced settings</summary>
        <label>Service name<input value={input.name} maxLength={100} required disabled={busy} onChange={event => setInput(value => ({ ...value, name: event.target.value }))} /></label>
        {input.kind !== 'compatible' && <label>Service URL<input aria-label="Service URL" type="url" value={input.baseUrl} required disabled={busy} onChange={event => setInput(value => ({ ...value, baseUrl: event.target.value }))} /></label>}
        <label>Context window (tokens)<input aria-label="Context window" type="number" inputMode="numeric" min={CHAT_CONTEXT_WINDOW_MIN} max={CHAT_CONTEXT_WINDOW_MAX} step={1000} value={input.contextWindow ?? ''} disabled={busy} placeholder={`Default: ${CHAT_PROVIDER_DEFAULTS[input.kind].contextWindow.toLocaleString()}`} onChange={event => setInput(value => ({ ...value, contextWindow: event.target.value ? Number(event.target.value) : undefined }))} /><small>How much the model can read at once. Use the model provider&rsquo;s documented limit.</small></label>
      </details>
      <p className="ambio-chat__privacy">Your messages and the project context the agent reads are sent to this service. Calls use your account and may incur charges. Keys stay on this computer; they are never added to your project or sent to Ambio.</p>
      {notice && <p role="status">{notice}</p>}{error && <p className="ambio-chat__error" role="alert">{error}</p>}
      <div className="ambio-chat__actions"><button className="ambio-chat__primary" type="submit" disabled={busy || !input.model.trim()}>Save service</button>{input.id && <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await window.ambio.removeChatProvider(input.id!); select(''); onSaved(null); closeEditor() } catch (failure) { setError(String(failure)) } finally { setBusy(false) } }}>Remove service</button>}</div>
    </form>}
    </section>
  </section>
}
