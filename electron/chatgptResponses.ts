/** The public Responses route's documented restrictions for ChatGPT plan use. */
const OMIT = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation',
  'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature',
  'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
]

export function chatGPTRequest(body: unknown): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid ChatGPT request.')
  const request = { ...body } as Record<string, any>
  if (typeof request.model !== 'string' || !Array.isArray(request.input)) throw new Error('ChatGPT requires a model and complete input history.')
  request.store = false; request.stream = true
  for (const name of OMIT) delete request[name]
  request.input = request.input.map((item: any) => item?.role === 'system' ? { ...item, role: 'developer' } : item)
  if (Array.isArray(request.tools)) {
    const local = request.tools.filter((tool: any) => tool?.type === 'function' || tool?.type === 'custom')
    const others = request.tools.filter((tool: any) => tool?.type !== 'function' && tool?.type !== 'custom')
    if (others.some((tool: any) => tool?.type !== 'namespace' && tool?.type !== 'web_search' && tool?.type !== 'web_search_preview')) throw new Error('This hosted tool is not available through ChatGPT plan usage.')
    if (local.length) {
      let namespace = 'ambio_local_tools'
      while (others.some((tool: any) => tool.name === namespace)) namespace += '_'
      request.tools = [...others, { type: 'namespace', name: namespace, description: 'Tools executed locally by Ambio.', tools: local }]
      if (request.tool_choice?.type === 'function' || request.tool_choice?.type === 'custom') request.tool_choice = { ...request.tool_choice, namespace }
    }
  }
  return request
}

function errorEvent(code: string, onFailure?: (message: string) => void): string {
  const message = code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable'
    ? 'ChatGPT plan usage is unavailable or its limit was reached. Open Manage usage in Ambio to review your ChatGPT limits.'
    : 'ChatGPT did not complete this response. Check your connection or reconnect ChatGPT in Model services.'
  onFailure?.(message)
  return `data: ${JSON.stringify({ type: 'error', code, message, param: null, sequence_number: 0 })}\n\n`
}

/** Do not let an interrupted or failed SSE stream look like a successful reply.
 * Tool calls, encrypted reasoning and usage events otherwise pass through intact. */
export async function* chatGPTEvents(body: ReadableStream<Uint8Array>, onFailure?: (message: string) => void): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder()
  let pending = '', terminal = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      pending = pending.replace(/\r\n/g, '\n')
      if (pending.length > 20 * 1024 * 1024) throw new Error('ChatGPT stream event is too large.')
      let end: number
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        let event: any
        try { event = JSON.parse(data) } catch { throw new Error('Invalid ChatGPT stream event.') }
        if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
          terminal = true
          yield errorEvent(event.response?.error?.code ?? event.code ?? 'chatgpt_response_failed', onFailure)
          return
        }
        if (event.type === 'response.completed') {
          if (event.response?.status !== 'completed') { terminal = true; yield errorEvent('chatgpt_response_incomplete', onFailure); return }
          terminal = true
        }
        yield `${frame}\n\n`
        if (terminal) return
      }
      if (done) break
    }
    if (!terminal) yield errorEvent('chatgpt_stream_incomplete', onFailure)
  } catch {
    if (!terminal) yield errorEvent('chatgpt_stream_interrupted', onFailure)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
