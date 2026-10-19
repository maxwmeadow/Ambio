import type { Page } from '@playwright/test'
import { CHAT_DELIVERY, DESTINATION_GUIDE } from '../../src/shared/agentDelivery'

/**
 * Start as someone who has read every agent's guide, for specs that are not
 * about the first-use introduction (agent-delivery.spec.ts covers that).
 */
export async function skipAgentGuides(page: Page): Promise<void> {
  const ids = [...new Set([CHAT_DELIVERY, ...Object.keys(DESTINATION_GUIDE)])]
  await page.evaluate(seen => localStorage.setItem('ambio:destination-guides-seen', JSON.stringify(seen)), ids)
}
