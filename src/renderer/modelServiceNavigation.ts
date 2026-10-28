import type { ChatProviderKind } from '../shared/agentChat'

export const OPEN_MODEL_SERVICES = 'ambio:open-model-services'
export type ModelServiceDestination = ChatProviderKind | 'chatgpt'
export interface ModelServiceSetupRequest { provider?: ModelServiceDestination }

/** Open the relevant connection form without starting sign-in or changing saved services. */
export function openModelServices(provider?: ModelServiceDestination): void {
  window.dispatchEvent(new CustomEvent<ModelServiceSetupRequest>(OPEN_MODEL_SERVICES, { detail: { provider } }))
}
