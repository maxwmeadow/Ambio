/** Display state only. OAuth credentials never cross the preload bridge. */
export interface ChatGPTProfile {
  id: string
  label: string
  email?: string
  connected: boolean
  sharing: boolean
}

export interface ChatGPTState {
  profiles: ChatGPTProfile[]
  activeId?: string
  model?: string
  signingIn: boolean
  secureStorage: boolean
  harnessInstalled: boolean
}

export interface ChatGPTModel { slug: string; displayName: string }

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/#settings/Usage'
