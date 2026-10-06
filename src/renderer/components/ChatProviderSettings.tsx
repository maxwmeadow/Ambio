import { useState, type FormEvent } from 'react'
import { CHAT_PROVIDER_DEFAULTS, type ChatProvider, type ChatProviderInput, type ChatProviderKind } from '../../shared/agentChat'

export function ChatProviderSettings({ providers, onSaved, onClose }: { providers: ChatProvider[]; onSaved: (provider: ChatProvider | null) => void; onClose: () => void }) {
  const [input, setInput] = useState<ChatProviderInput>({ kind: 'openai', name: 'OpenAI', baseUrl: CHAT_PROVIDER_DEFAULTS.openai.baseUrl, model: '', apiKey: '' })
  const [models, setModels] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const select = (id: string) => {
    const profile = providers.find(item => item.id === id)
    setInput(profile ? { id: profile.id, kind: profile.kind, name: profile.name, baseUrl: profile.baseUrl, model: profile.model, apiKey: '' } : { kind: 'openai', name: 'OpenAI', baseUrl: CHAT_PROVIDER_DEFAULTS.openai.baseUrl, model: '', apiKey: '' })
    setModels([]); setNotice(''); setError('')
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
    try { const profile = await window.ambio.saveChatProvider(input); setInput(value => ({ ...value, apiKey: '' })); onSaved(profile) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save service.') }
    finally { setBusy(false) }
  }
  return <section className="ambio-chat__settings" aria-label="Model services">
    <div className="ambio-chat__section-heading"><div><h3>Your model service</h3><p>Choose where your integrated agent thinks.</p></div><button type="button" onClick={onClose} aria-label="Close model services">×</button></div>
    <form onSubmit={save}>
      <label>Saved services<select value={input.id ?? ''} disabled={busy} onChange={event => select(event.target.value)}><option value="">Add a service</option>{providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Provider<select aria-label="Model provider" value={input.kind} disabled={busy || !!input.id} onChange={event => { const kind = event.target.value as ChatProviderKind; setInput({ kind, ...CHAT_PROVIDER_DEFAULTS[kind], model: '', apiKey: '' }); setModels([]); setNotice('') }}>{Object.entries(CHAT_PROVIDER_DEFAULTS).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
      <label>Service name<input value={input.name} maxLength={100} required disabled={busy} onChange={event => setInput(value => ({ ...value, name: event.target.value }))} /></label>
      <label>Service URL<input aria-label="Service URL" type="url" value={input.baseUrl} required disabled={busy} placeholder="https://your-service.example/v1" onChange={event => setInput(value => ({ ...value, baseUrl: event.target.value }))} /></label>
      <label>API key<input aria-label="Service API key" type="password" autoComplete="off" spellCheck={false} value={input.apiKey} disabled={busy} placeholder={input.id ? 'Leave blank to keep your saved key' : 'Your provider API key'} onChange={event => setInput(value => ({ ...value, apiKey: event.target.value }))} /></label>
      <div className="ambio-chat__actions"><button type="button" disabled={busy || !input.baseUrl} onClick={() => { void test() }}>{busy ? 'Connecting…' : 'Test connection & find models'}</button></div>
      <label>Model<input aria-label="Service model" value={input.model} list="ambio-chat-models" required disabled={busy} placeholder="Choose or enter a model ID" onChange={event => setInput(value => ({ ...value, model: event.target.value }))} /><datalist id="ambio-chat-models">{models.map(model => <option key={model} value={model} />)}</datalist></label>
      <p className="ambio-chat__privacy">Your messages and the project context the agent reads are sent to this service. Calls use your account and may incur charges. Keys stay on this computer; they are never added to your project or sent to Ambio.</p>
      {notice && <p role="status">{notice}</p>}{error && <p className="ambio-chat__error" role="alert">{error}</p>}
      <div className="ambio-chat__actions"><button className="ambio-chat__primary" type="submit" disabled={busy || !input.model.trim()}>Save service</button>{input.id && <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await window.ambio.removeChatProvider(input.id!); select(''); onSaved(null) } catch (failure) { setError(String(failure)) } finally { setBusy(false) } }}>Remove service</button>}</div>
    </form>
  </section>
}
