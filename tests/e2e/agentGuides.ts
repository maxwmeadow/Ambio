import type { Locator, Page } from '@playwright/test'
import { CHAT_DELIVERY, CLI_CLIENTS, DESTINATION_GUIDE } from '../../src/shared/agentDelivery'

/**
 * Start as someone who has read every agent's guide and chosen Full access
 * for every agent Ambio runs, for specs that are not about the first-use
 * introduction (agent-delivery.spec.ts covers that).
 */
export async function skipAgentGuides(page: Page): Promise<void> {
  const ids = [...new Set([CHAT_DELIVERY, ...Object.keys(DESTINATION_GUIDE)])]
  await page.evaluate(({ seen, runs }) => {
    localStorage.setItem('ambio:destination-guides-seen', JSON.stringify(seen))
    for (const id of runs) localStorage.setItem(`ambio:access:${id}`, 'full')
  }, { seen: ids, runs: CLI_CLIENTS.map(client => client.id) })
}

/**
 * Choose what the chosen agent may do without asking, in its guide opened
 * from the agent menu's info button. Returns the levels it offered.
 */
export async function setAgentAccess(scope: Locator, label: string, level: string): Promise<string[]> {
  const menu = agentMenu(scope)
  await menu.open()
  await menu.menu.getByRole('button', { name: `About ${label}` }).click()
  const guide = scope.page().getByRole('dialog', { name: `About ${label}` })
  const choices = guide.getByRole('group', { name: `What ${label} may do without asking` })
  const offered = await choices.getByRole('radio').evaluateAll(items => items.map(item => (item as HTMLInputElement).value))
  await choices.getByRole('radio', { name: new RegExp(`^${level}`) }).check()
  await guide.getByRole('button', { name: 'Done' }).click()
  return offered
}

/** The agent menu (message box, guide, first-use introduction), driven like a person would. */
export function agentMenu(scope: Locator, label = 'Work-order destination') {
  const trigger = scope.getByRole('button', { name: new RegExp(`^${label}:`) })
  const menu = scope.page().getByRole('menu', { name: label })
  const open = async () => { if (!(await menu.isVisible())) await trigger.click() }
  return {
    trigger,
    menu,
    items: () => menu.getByRole('menuitemradio'),
    group: (name: string) => menu.getByRole('group', { name }).getByRole('menuitemradio'),
    open,
    close: async () => { if (await menu.isVisible()) await trigger.click() },
    /** Choose by the agent's value: a host ID, '@chat:<service>', '@watching' or '' for by hand. */
    choose: async (value: string) => { await open(); await menu.locator(`[data-value="${value}"]`).click() },
    /** Choose by the label shown in the menu. */
    chooseLabel: async (text: string) => { await open(); await menu.getByRole('menuitemradio').filter({ hasText: text }).first().click() },
  }
}
