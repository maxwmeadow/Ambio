export type ChatProviderKind = 'openai' | 'anthropic' | 'google' | 'compatible'
export type ChatMode = 'ask' | 'build'
export interface ChatProvider {
  id: string
  name: string
  kind: ChatProviderKind
  baseUrl: string
  model: string
  /** Tokens the model can hold; unset uses the provider default. */
  contextWindow?: number
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
}
export interface ChatPart {
  id: string
  kind: 'text' | 'tool'
  text: string
  tool?: string
  state?: string
}
export interface ChatMessage { id: string; role: 'user' | 'assistant'; parts: ChatPart[] }
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
export interface ChatSendInput { conversationId: string; text: string; mode: ChatMode; workOrderId?: string }
// contextWindow is a conservative figure for current models from each provider.
// The harness compacts history against it, so too small a value trims early.
export const CHAT_PROVIDER_DEFAULTS: Record<ChatProviderKind, { name: string; baseUrl: string; contextWindow: number }> = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', contextWindow: 128000 },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', contextWindow: 200000 },
  google: { name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', contextWindow: 1000000 },
  compatible: { name: 'OpenAI-compatible', baseUrl: '', contextWindow: 32000 },
}
export const CHAT_CONTEXT_WINDOW_MIN = 8000
export const CHAT_CONTEXT_WINDOW_MAX = 10000000
export function chatContextWindow(provider: Pick<ChatProvider, 'kind' | 'contextWindow'>): number {
  return provider.contextWindow ?? CHAT_PROVIDER_DEFAULTS[provider.kind].contextWindow
}
