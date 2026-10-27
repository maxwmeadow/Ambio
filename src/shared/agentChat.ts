export type ChatProviderKind = 'openai' | 'anthropic' | 'google' | 'compatible'
export type ChatMode = 'ask' | 'propose' | 'build'
export const CHAT_MODES: ChatMode[] = ['ask', 'propose', 'build']
export interface ChatProvider {
  id: string
  name: string
  kind: ChatProviderKind
  /** Managed ChatGPT OAuth connection rather than an API-key service. */
  auth?: 'chatgpt'
  baseUrl: string
  model: string
  /** Tokens the model can hold; unset uses the provider default. */
  contextWindow?: number
  /** Every model the service offered when it was tested; `model` is the default. */
  models?: string[]
  hasKey: boolean
  persistentKey: boolean
}
export interface ChatProviderInput {
  id?: string
  name: string
  kind: ChatProviderKind
  baseUrl: string
  model: string
  contextWindow?: number
  models?: string[]
  apiKey?: string
}
export interface ChatConnectionTest { models: string[]; detail: string }
export interface ChatConversation {
  id: string
  workspaceId: string
  rootPath: string
  providerId: string
  model: string
  title: string
  mode: ChatMode
  createdAt: number
  updatedAt: number
  state: 'idle' | 'working' | 'waiting' | 'interrupted' | 'failed'
  error?: string
  workOrderId?: string
  /** Setup mapping is a finite, non-resumable session. */
  mappingAttemptId?: string
}
export interface ChatPart {
  id: string
  /** reasoning: the model's own reasoning, where its service returns it. */
  kind: 'text' | 'tool' | 'reasoning'
  text: string
  tool?: string
  state?: string
}
/** mode is the kind of turn a user message started, when the harness recorded it. */
export interface ChatMessage { id: string; role: 'user' | 'assistant'; parts: ChatPart[]; mode?: ChatMode }
export interface ChatApproval { id: string; permission: string; patterns: string[] }
export interface ChatQuestion {
  id: string
  questions: Array<{ header: string; question: string; multiple?: boolean; options: Array<{ label: string; description: string }> }>
}
export interface ChatSnapshot {
  conversation: ChatConversation
  messages: ChatMessage[]
  approvals: ChatApproval[]
  questions: ChatQuestion[]
}
/** model picks one of the service's models for this turn; unset keeps the conversation's. */
export interface ChatSendInput { conversationId: string; text: string; mode: ChatMode; workOrderId?: string; model?: string }

/** The models a conversation on this service can use, its default first. */
export function chatModels(provider: Pick<ChatProvider, 'model' | 'models'>): string[] {
  return [...new Set([provider.model, ...(provider.models ?? [])])]
}
// The harness compacts history against contextWindow, so too small a value
// trims early. Hosted models take 1M; compatible services are often local
// servers configured for less, so they start lower and can be raised.
export const CHAT_PROVIDER_DEFAULTS: Record<ChatProviderKind, { name: string; baseUrl: string; contextWindow: number }> = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', contextWindow: 1000000 },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', contextWindow: 1000000 },
  google: { name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', contextWindow: 1000000 },
  compatible: { name: 'OpenAI-compatible', baseUrl: '', contextWindow: 128000 },
}
export const CHAT_CONTEXT_WINDOW_MIN = 8000
export const CHAT_CONTEXT_WINDOW_MAX = 10000000
export function chatContextWindow(provider: Pick<ChatProvider, 'kind' | 'contextWindow'>): number {
  return provider.contextWindow ?? CHAT_PROVIDER_DEFAULTS[provider.kind].contextWindow
}
