import { _electron as electron, expect, test, type Page } from '@playwright/test'

type Order = Record<string, any>

async function openMockProject(fixture: 'commerce' | 'service' | 'operations', height = 900) {
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, AMBIO_E2E: '1', AMBIO_E2E_FIXTURE: fixture } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height })
  const orders: Order[] = []
  const workspaceId = `fixture-${fixture}`
  const sheet: Order | null = fixture === 'commerce' ? {
    id: 'sheet-checkout', workspaceId, name: 'Checkout flow', purpose: 'Move payment retry into Checkout', kind: 'structure', folder: '', createdBy: 'user', revision: 3, createdAt: 1, updatedAt: 1,
  } : null
  let equivalent = false
  await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
    const url = new URL(route.request().url())
    let body: any = []
    if (url.pathname === '/api/sheets') body = sheet ? [sheet] : []
    if (sheet && url.pathname === `/api/sheets/${sheet.id}`) body = { sheet, elements: [], annotations: [], planned: [], plannedEdges: [], layouts: [] }
    if (sheet && url.pathname === `/api/sheets/${sheet.id}/compare`) body = {
      sheetId: sheet.id, name: sheet.name, revision: sheet.revision, token: `comparison-${sheet.revision}`, equivalent, resolvedAt: sheet.resolvedAt, checked: 2,
      differences: equivalent ? [] : [{ kind: 'nesting', nodeId: 'payment-retry', name: 'Payment retry', actual: 'outside', expected: 'checkout', detail: 'Move under Checkout' }],
      nodes: [{ id: 'checkout', name: 'Checkout' }], mappings: {},
    }
    if (sheet && url.pathname === '/api/canvas/snapshot-comparison') body = {
      messageId: url.searchParams.get('messageId'), sheetId: sheet.id, name: sheet.name, revision: 3,
      equivalent, checked: 2,
      differences: equivalent ? [] : [{ kind: 'nesting', nodeId: 'payment-retry', name: 'Payment retry', detail: 'Move under Checkout' }], mappings: {},
    }
    if (sheet && url.pathname === `/api/sheets/${sheet.id}/resolve`) { sheet.resolvedAt = Date.now(); body = sheet }
    if (url.pathname === '/api/canvas/history') body = { messages: [...orders].reverse(), nextCursor: '', availableCount: orders.filter(order => order.status === 'queued').length }
    if (url.pathname === '/api/canvas/send') {
      const sent = route.request().postDataJSON()
      if (!orders.some(order => order.id === sent.id)) orders.push({ ...sent, status: 'queued', createdAt: Date.now() })
      body = orders.find(order => order.id === sent.id)
    }
    if (url.pathname === '/api/canvas/review') {
      const review = route.request().postDataJSON()
      const order = orders.find(item => item.id === review.msgId)
      if (order) {
        order.review = { id: review.reviewId, decision: review.decision, note: review.note, createdAt: Date.now() }
        order.reviews = [...(order.reviews ?? []), order.review]
        if (review.decision === 'reopened') {
          order.priorReplies = [...(order.priorReplies ?? []), order.reply]
          delete order.reply
          order.status = 'queued'
        }
      }
      body = { message: order }
    }
    if (url.pathname === '/api/canvas/cancel') {
      const cancel = route.request().postDataJSON()
      const order = orders.find(item => item.id === cancel.msgId)
      if (order) order.status = 'cancelled'
      body = order
    }
    if (url.pathname === '/api/agent/presence') body = { connected: true, connections: [{ hostId: 'codex' }] }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.evaluate(id => {
    localStorage.removeItem(`ambio:inbox-draft:${id}`)
    localStorage.removeItem(`ambio:inbox-draft:${id}:pending`)
    localStorage.removeItem(`ambio:inbox-draft:${id}:sheet`)
  }, workspaceId)
  await page.reload()
  return { app, page, orders, sheet, setEquivalent: (value: boolean) => { equivalent = value } }
}

async function openInbox(page: Page) {
  await page.getByRole('button', { name: /^Message agent/ }).click()
  return page.getByRole('complementary', { name: 'Agent inbox' })
}

test('Harbor Checkout: sheet request, linked work, structural match, submission and acceptance', async () => {
  test.setTimeout(90000)
  const mock = await openMockProject('commerce')
  try {
    const { page, orders, sheet } = mock
    await expect(page.getByText('Harbor Checkout')).toBeVisible()
    await expect(page.locator('.react-flow__node-system').getByText('Checkout', { exact: true }).first()).toBeVisible()
    const inbox = await openInbox(page)
    const instruction = inbox.getByRole('textbox', { name: 'Instruction for your agent' })
    await instruction.press('@')
    await inbox.getByRole('dialog', { name: 'Attach a sheet' }).getByRole('option', { name: /Checkout flow/ }).click()
    await expect(inbox.locator('.ambio-inbox__attachment')).toContainText('Checkout flow')
    await instruction.fill('Implement the checkout sheet and verify payment retry.')
    await inbox.getByRole('button', { name: 'Send to inbox' }).click()
    await expect.poll(() => orders.length).toBe(1)
    expect(orders[0].sheetId).toBe(sheet!.id)
    await expect(inbox.getByRole('button', { name: 'Copy handoff' })).toBeVisible()
    await expect(inbox.getByText('1 structural difference', { exact: true })).toBeVisible()
    orders[0].status = 'delivered'; orders[0].agent = 'Codex'; orders[0].leaseExpiresAt = Date.now() + 60000
    orders[0].sessions = [{ id: 'commerce-session', agent: 'Codex', goal: 'Implement checkout flow', notes: [{ ts: Date.now(), text: 'Moved payment retry into Checkout.' }], startedAt: Date.now(), endedAt: 0 }]
    await expect(inbox.getByText('Picked up by Codex')).toBeVisible({ timeout: 12000 })
    await expect(inbox.getByRole('region', { name: 'Work progress: Implement checkout flow' })).toContainText('Moved payment retry')
    mock.setEquivalent(true)
    await expect(inbox.getByText('Structure matches the live canvas')).toBeVisible({ timeout: 12000 })
    await inbox.getByRole('button', { name: /Structure matches the live canvas/ }).click()
    await inbox.getByRole('button', { name: 'Resolve sheet' }).click()
    await expect(inbox.getByText('Sheet resolved · saved in history')).toBeVisible()
    orders[0].status = 'answered'; orders[0].sessions[0].endedAt = Date.now(); orders[0].sessions[0].summary = 'Checkout flow implemented.'
    orders[0].reply = { body: 'Checkout flow is implemented and the sheet is resolved.', agent: 'Codex', createdAt: Date.now(), result: { changedFiles: ['src/checkout/retry.ts'], checks: [{ command: 'npm test -- checkout', outcome: 'passed' }], remaining: [] } }
    orders[0].changes = [{ kind: 'file.updated', subjectLabel: 'retry.ts', count: 1, at: Date.now() }]
    await expect(inbox.getByRole('button', { name: /Review result/ })).toBeVisible({ timeout: 12000 })
    await page.screenshot({ path: 'test-results/work-order-commerce-ready.png' })
    await inbox.getByRole('button', { name: /Review result/ }).click()
    await expect(inbox.getByRole('button', { name: 'Accept result' })).toBeVisible({ timeout: 12000 })
    await expect(inbox.getByText('Sent structure matches the live architecture')).toBeVisible()
    await expect(inbox.getByText('Indexed changes')).toBeVisible()
    await page.screenshot({ path: 'test-results/work-order-commerce-review.png' })
    await inbox.getByRole('button', { name: 'Accept result' }).click()
    await expect(inbox.getByText('Accepted', { exact: true }).first()).toBeVisible()
  } finally { await mock.app.close() }
})

test('Northstar API: selected systems, failed check, feedback, second attempt and acceptance', async () => {
  test.setTimeout(90000)
  const mock = await openMockProject('service', 720)
  try {
    const { page, orders } = mock
    await expect(page.getByText('Northstar API')).toBeVisible()
    await expect(page.locator('.react-flow__node-system').getByText('Public API', { exact: true }).first()).toBeVisible()
    const systems = page.locator('.react-flow__node-system')
    await systems.nth(0).click({ position: { x: 18, y: 16 } })
    await systems.nth(1).click({ position: { x: 18, y: 16 }, modifiers: ['Shift'] })
    await page.locator('.ambio-selection-actions').getByRole('button', { name: 'Message agent', exact: true }).click()
    const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
    await expect(page.locator('.ambio-selection-actions')).toBeHidden()
    await expect(inbox.locator('.ambio-inbox__compose .ambio-inbox__targets button')).toHaveCount(2)
    await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Add a timeout response to the selected API system.')
    await inbox.getByRole('button', { name: 'Send to inbox' }).click()
    await expect.poll(() => orders.length).toBe(1)
    expect(JSON.parse(orders[0].selection)).toHaveLength(2)
    orders[0].status = 'answered'
    orders[0].sessions = [{ id: 'api-1', agent: 'Claude Code', goal: 'Add timeout response', notes: [], startedAt: Date.now(), endedAt: Date.now(), summary: 'Response added; one check failed.' }]
    orders[0].reply = { body: 'Added the timeout response. The integration check still fails.', agent: 'Claude Code', createdAt: Date.now(), result: { changedFiles: ['api/timeout.ts'], checks: [{ command: 'npm run test:integration', outcome: 'failed' }], remaining: ['Fix integration check'] } }
    await expect(inbox.getByRole('button', { name: /Review result/ })).toBeVisible({ timeout: 12000 })
    await inbox.getByRole('button', { name: /Review result/ }).click()
    await expect(inbox.getByText(/npm run test:integration.*failed/)).toBeVisible({ timeout: 12000 })
    await inbox.getByRole('button', { name: 'Request changes' }).click()
    await inbox.getByLabel('What needs to change?').fill('Fix the integration check before I accept this.')
    await inbox.getByRole('button', { name: 'Reopen work order' }).click()
    await expect(inbox.getByText('Changes requested · waiting for agent')).toBeVisible()
    orders[0].status = 'delivered'; orders[0].agent = 'Codex'; orders[0].leaseExpiresAt = Date.now() + 60000
    orders[0].sessions.push({ id: 'api-2', agent: 'Codex', goal: 'Fix integration check', notes: [{ ts: Date.now(), text: 'Reproduced the failure.' }], startedAt: Date.now(), endedAt: 0 })
    await expect(inbox.getByRole('region', { name: 'Work progress: Fix integration check' })).toBeVisible({ timeout: 12000 })
    orders[0].status = 'answered'; orders[0].sessions[1].endedAt = Date.now(); orders[0].reply = { body: 'The timeout response and integration check now pass.', agent: 'Codex', createdAt: Date.now(), result: { checks: [{ command: 'npm run test:integration', outcome: 'passed' }] } }
    await expect(inbox.getByText('The timeout response and integration check now pass.')).toBeVisible({ timeout: 12000 })
    await inbox.getByRole('button', { name: /Review result/ }).click()
    await expect(inbox.getByText('Earlier submissions')).toBeVisible()
    await page.screenshot({ path: 'test-results/work-order-service-review.png' })
    await inbox.getByRole('button', { name: 'Accept result' }).click()
    await expect(inbox.getByText('Accepted', { exact: true }).first()).toBeVisible()
  } finally { await mock.app.close() }
})

test('Relay Operations: project question without files, then cancellation of a separate request', async () => {
  test.setTimeout(90000)
  const mock = await openMockProject('operations', 700)
  try {
    const { page, orders } = mock
    await expect(page.getByText('Relay Operations')).toBeVisible()
    await expect(page.locator('.react-flow__node-system').getByText('Incident Console', { exact: true }).first()).toBeVisible()
    const inbox = await openInbox(page)
    await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Explain the current incident route. Do not edit code.')
    await inbox.getByRole('button', { name: 'Send to inbox' }).click()
    await expect.poll(() => orders.length).toBe(1)
    expect(JSON.parse(orders[0].selection)).toEqual([])
    expect(orders[0].sheetId).toBeNull()
    orders[0].status = 'answered'; orders[0].reply = { body: 'The incident route goes through the API and SQLite audit store.', agent: 'Codex', createdAt: Date.now() }
    await expect(inbox.getByText('The incident route goes through the API and SQLite audit store.')).toBeVisible({ timeout: 12000 })
    await inbox.getByRole('button', { name: /Review result/ }).click()
    await expect(inbox.getByText('Agent report')).toHaveCount(0)
    await inbox.getByRole('button', { name: 'Accept result' }).click()
    await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Investigate the old job queue.')
    await inbox.getByRole('button', { name: 'Send to inbox' }).click()
    await expect.poll(() => orders.length).toBe(2)
    await inbox.getByRole('button', { name: 'Cancel request' }).click()
    await expect(inbox.getByText('Cancelled', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: 'test-results/work-order-operations.png' })
  } finally { await mock.app.close() }
})
