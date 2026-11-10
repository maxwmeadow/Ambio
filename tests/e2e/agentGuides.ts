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

/**
 * The agent menu (message box, guide, first-use introduction), driven like a
 * person would. In the message box it is the Agent row of the one agent and
 * model control (agentSetup); in a guide it is its own field.
 */
export function agentMenu(scope: Locator, label = 'Work-order destination') {
  const composer = label === 'Work-order destination'
  const setup = agentSetup(scope)
  const trigger = composer ? setup.trigger : scope.getByRole('button', { name: new RegExp(`^${label}:`) })
  const menu = scope.page().getByRole('menu', { name: label })
  const open = async () => {
    if (await menu.isVisible()) return
    if (!composer) { await trigger.click(); return }
    await setup.open()
    await setup.panel.getByRole('button', { name: /^Agent: / }).click()
  }
  return {
    trigger,
    menu,
    items: () => menu.getByRole('menuitemradio'),
    group: (name: string) => menu.getByRole('group', { name }).getByRole('menuitemradio'),
    open,
    close: async () => { if (composer) await setup.close(); else if (await menu.isVisible()) await trigger.click() },
    /** Choose by the agent's value: a host ID, '@chat:<service>', '@watching' or '' for by hand. */
    choose: async (value: string) => { await open(); await menu.locator(`[data-value="${value}"]`).click() },
    /** Choose by the label shown in the menu. */
    chooseLabel: async (text: string) => { await open(); await menu.getByRole('menuitemradio').filter({ hasText: text }).first().click() },
  }
}

/**
 * The message box's one control for the agent, its model and thinking level.
 * Its name reads "Agent and model: <agent>, <model>, <level> thinking".
 */
export function agentSetup(scope: Locator) {
  const trigger = scope.getByRole('button', { name: /^Agent and model:/ })
  const panel = scope.getByRole('dialog', { name: 'Agent and model' })
  const open = async () => { if (!(await panel.isVisible())) await trigger.click() }
  const models = scope.getByRole('menu', { name: 'Model' })
  return {
    trigger,
    panel,
    open,
    close: async () => { if (await panel.isVisible()) await trigger.click() },
    models,
    /** Open the model list (from the control's Model row). */
    openModels: async () => { if (await models.isVisible()) return; await open(); await panel.getByRole('button', { name: /^Model: / }).click() },
    /** Choose a model by its label; the control comes back to its rows, open. */
    chooseModel: async (label: string) => {
      if (!(await models.isVisible())) { await open(); await panel.getByRole('button', { name: /^Model: / }).click() }
      await models.getByRole('menuitemradio', { name: label, exact: true }).click()
    },
    /** Choose a thinking level by its label; the control closes. */
    chooseThinking: async (label: string) => { await open(); await panel.getByRole('menuitemradio', { name: `Thinking: ${label}`, exact: true }).click() },
  }
}
