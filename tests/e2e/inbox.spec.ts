import { _electron as electron, expect, test } from '@playwright/test'
import { skipAgentGuides } from './agentGuides'

test('canvas inbox attaches selection, retries a lost response, and restores the reply after reload', async () => {
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, AMBIO_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await skipAgentGuides(page)
    await page.setViewportSize({ width: 1400, height: 900 })
    const messages: any[] = []
    const sends: any[] = []
    let loseResponse = true
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = route.request().url()
      let body: unknown = []
      if (url.includes('/api/canvas/history')) body = { messages: [...messages].reverse(), nextCursor: '' }
      if (url.endsWith('/api/canvas/send')) {
        const sent = route.request().postDataJSON(); sends.push(sent)
        if (!messages.some(message => message.id === sent.id)) messages.push({ ...sent, status: 'queued', createdAt: Date.now() })
        if (loseResponse) { loseResponse = false; await route.abort('failed'); return }
        body = messages[0]
      }
      if (url.endsWith('/api/canvas/review')) {
        const review = route.request().postDataJSON()
        const message = messages.find(item => item.id === review.msgId)
        if (message) {
          message.review = { id: review.reviewId, decision: review.decision, note: review.note, createdAt: Date.now() }
          message.reviews = [...(message.reviews ?? []), message.review]
          if (review.decision === 'reopened') {
            message.priorReplies = [...(message.priorReplies ?? []), message.reply]
            delete message.reply
            message.status = 'queued'
          }
        }
        body = { message }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.evaluate(() => {
      localStorage.removeItem('ambio:inbox-draft:demo')
      localStorage.removeItem('ambio:inbox-draft:demo:pending')
      localStorage.removeItem('ambio:inbox-draft:demo:sheet')
    })
    await page.reload()
    await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore.getState().currentProject?.name)).toBe('Ambio Canvas Fixture')
    await expect(page.locator('.react-flow__node-system').first()).toBeVisible()
    await page.waitForTimeout(800)
    // Select two actual canvas systems; the composer must see both.
    const nodes = page.locator('.react-flow__node-system')
    await nodes.nth(0).click({ position: { x: 18, y: 16 } })
    await nodes.nth(1).click({ position: { x: 18, y: 16 }, modifiers: ['Shift'] })
    await page.locator('.ambio-selection-actions').getByRole('button', { name: 'Message agent', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Agent inbox' })
    await expect(panel).toBeVisible()
    await expect(panel.locator('.ambio-inbox__compose .ambio-inbox__targets button')).toHaveCount(2)
    const textbox = panel.getByRole('textbox', { name: 'Instruction for your agent' })
    await textbox.fill('Explain how these systems communicate.')
    await panel.getByRole('button', { name: 'Send to inbox', exact: true }).click()
    await expect(panel.getByRole('alert')).toBeVisible()
    await expect(textbox).toHaveValue('Explain how these systems communicate.')
    // Reload with an uncertain send: retain its original ID and attachments.
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await expect(textbox).toHaveValue('Explain how these systems communicate.')
    await expect(panel.locator('.ambio-inbox__compose .ambio-inbox__targets button')).toHaveCount(2)
    await panel.getByRole('button', { name: 'Send to inbox', exact: true }).click()
    await expect(textbox).toHaveValue('')
    // Readiness is said for the chosen destination, never as MCP status.
    // Readiness is said only when something needs the user; copying a handoff needs nothing.
    await expect(panel.getByRole('region', { name: 'Agent readiness' })).toHaveCount(0)
    // One line says where the turn stands; the message box waits with a Stop in place of Send.
    await expect(panel.locator('.ambio-inbox__turn-status')).toContainText('Waiting for an agent.')
    await expect(panel.getByRole('button', { name: 'Copy handoff' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    await expect(textbox).toBeDisabled()
    await expect(panel.locator('.ambio-inbox__work-order')).toHaveCount(0)
    expect(sends).toHaveLength(2)
    expect(sends[0].id).toBe(sends[1].id)
    expect(sends[0].deliveryMode).toBe('addressed')
    expect(JSON.parse(sends[0].selection)).toHaveLength(2)
    expect(messages).toHaveLength(1)
    messages[0].status = 'delivered'
    messages[0].sessions = [{ id: 'session-a', messageId: sends[0].id, agent: 'Test agent', goal: 'Trace both systems', notes: [{ ts: Date.now(), text: 'Mapped their shared API boundary.' }], startedAt: Date.now(), endedAt: 0 }]
    await expect(panel.getByRole('region', { name: 'Work progress: Trace both systems' })).toContainText('Mapped their shared API boundary.', { timeout: 10000 })
    messages[0].status = 'answered'
    messages[0].sessions[0].endedAt = Date.now()
    messages[0].sessions[0].summary = 'Explained the API boundary.'
    messages[0].reply = { body: 'They communicate through the project API.', agent: 'Test agent', createdAt: Date.now(), result: { changedFiles: ['src/project-api.ts'], checks: [{ command: 'npm test', outcome: 'passed' }], remaining: ['Confirm timeout behavior'] } }
    messages[0].changes = [{ kind: 'file.updated', subjectLabel: 'project-api.ts', count: 1, at: Date.now() }]
    await expect(panel.getByText('They communicate through the project API.')).toBeVisible({ timeout: 10000 })
    await panel.getByRole('button', { name: /Review result/ }).click()
    await expect(panel.getByText('Explained the API boundary.')).toBeVisible()
    await expect(panel.getByText('Map changes')).toBeVisible()
    await expect(panel.locator('.ambio-inbox__review-changes li')).toHaveText('Changed project-api.ts')
    await expect(panel.getByText('Agent report')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Accept result' })).toBeVisible()
    await panel.getByRole('button', { name: 'Request changes' }).click()
    await panel.getByLabel('What needs to change?').fill('Include the timeout path.')
    await panel.getByRole('button', { name: 'Reopen work order' }).click()
    await expect(panel.locator('.ambio-inbox__turn-status')).toContainText('Changes requested, waiting for agent.')
    await expect(panel.getByText('Include the timeout path.')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Copy handoff' })).toBeVisible()
    messages[0].status = 'answered'
    messages[0].reply = { body: 'The timeout path also uses the project API.', agent: 'Test agent', createdAt: Date.now() }
    await expect(panel.getByText('The timeout path also uses the project API.')).toBeVisible({ timeout: 10000 })
    await panel.getByRole('button', { name: /Review result/ }).click()
    await panel.getByRole('button', { name: 'Accept result' }).click()
    await expect(panel.getByText('Accepted', { exact: true }).first()).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Message agent', exact: true }).click()
    await expect(page.getByText('The timeout path also uses the project API.')).toBeVisible()
    await page.screenshot({ path: 'test-results/inbox-complete.png' })
    // A remembered sheet can disappear between sessions. Show it clearly and
    // require the user to remove it before creating a new request.
    await page.evaluate(() => localStorage.setItem('ambio:inbox-draft:demo:sheet', JSON.stringify('deleted_sheet')))
    await page.reload()
    await page.getByRole('button', { name: 'Message agent', exact: true }).click()
    await expect(panel.locator('.ambio-inbox__attachment')).toContainText('Sheet unavailable')
    await panel.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Another task')
    await panel.getByRole('button', { name: 'Send to inbox' }).click()
    await expect(panel.getByRole('alert')).toContainText('no longer available')
    expect(sends).toHaveLength(2)
    await panel.getByRole('button', { name: 'Remove attached sheet' }).click()
    await expect(panel.locator('.ambio-inbox__attachment')).toHaveCount(0)
  } finally { await app.close() }
})

test('what an agent outside Ambio does shows in Message agent: a turn it took, and work in no conversation', async () => {
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, AMBIO_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await skipAgentGuides(page)
    await page.setViewportSize({ width: 1400, height: 900 })
    const now = Date.now()
    const call = (id: number, ts: number, extra: Record<string, unknown>) => ({ id, workspaceId: 'demo', ts, tool: 'get_architecture', kind: 'read', summary: 'overview', targets: [], durationMs: 3, status: 'ok', ...extra })
    // Cursor took a handoff and answered; Codex, in a terminal, used Ambio with no conversation.
    const message = { id: 'outside-1', workspaceId: 'demo', sheetId: null, note: 'How is the canvas drawn?', selection: '[]', changeSummary: '', sheetContext: '', buildSpec: '',
      status: 'answered', mode: 'ask', threadId: 'outside-1', createdAt: now - 600_000, deliveredTo: null, answerAnnotationId: null,
      reply: { agent: 'cursor', body: 'The canvas is drawn by **Canvas Renderer**.', createdAt: now - 400_000 },
      sessions: [{ id: 'sess-cursor', workspaceId: 'demo', agent: 'cursor', goal: 'Explain the canvas', notes: [], focusSystemIds: [], focusFileIds: [], startedAt: now - 590_000, endedAt: now - 400_000 }] }
    const actions = [
      call(3, now - 30_000, { agent: 'codex', tool: 'edit_systems', kind: 'write', summary: 'Put 2 files in Canvas Renderer', targets: ['sys_canvas'],
        detail: JSON.stringify({ input: '{\n  "op": "assign"\n}', output: '{\n  "assigned": 2\n}' }) }),
      call(2, now - 450_000, { agent: 'cursor', sessionId: 'sess-cursor', detail: JSON.stringify({ input: '{\n  "scope": "overview"\n}', output: '3 systems' }) }),
      call(1, now - 500_000, { agent: 'cursor', sessionId: 'sess-cursor', tool: 'get_inbox', kind: 'plan', summary: 'Read a request' }),
    ]
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      const body = url.pathname === '/api/canvas/history' ? { messages: [message], nextCursor: '' }
        : url.pathname === '/api/agent/actions' ? actions
        : url.pathname === '/api/agent/presence' ? { connections: [] } : []
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.reload()
    await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore.getState().currentProject?.name)).toBe('Ambio Canvas Fixture')
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const panel = page.getByRole('complementary', { name: 'Agent inbox' })

    // The turn Cursor took shows its Ambio calls as its steps, above its answer.
    const turn = panel.locator('.ambio-turn').filter({ hasText: 'The canvas is drawn by' })
    await expect(turn).toContainText('Cursor')
    await turn.getByText(/Worked for/).click()
    await expect(turn.locator('.ambio-turn__step-list > li')).toHaveCount(2)
    await expect(turn.locator('.ambio-turn__step-list > li').last()).toContainText('Get architecture')

    // Codex's work outside any conversation is one line at the top, opening to its steps.
    const outside = panel.getByRole('region', { name: 'Agents working outside Ambio' })
    const line = outside.getByRole('button', { expanded: false })
    await expect(line).toContainText(/Codex.*is working outside Ambio/)
    await expect(line).toContainText('1 step')
    await line.click()
    const step = outside.locator('.ambio-turn__step-list > li')
    await expect(step).toContainText('Edit systems')
    await expect(step).toContainText('Put 2 files in Canvas Renderer')
    await step.getByRole('button', { expanded: false }).click()
    await expect(step).toContainText('"assigned": 2')
    await page.screenshot({ path: 'test-results/outside-agents.png' })
    await step.getByRole('button', { name: 'Show on map' }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore.getState().selectedNodeId)).toBe('sys_canvas')

    // The old log is gone from the menus.
    expect(await page.evaluate(() => document.body.innerText.includes('Agent Log'))).toBe(false)
  } finally { await app.close() }
})

test('the attach picker adds systems and files as context, and the Unsorted window opens above its button beside the panel', async () => {
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, AMBIO_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await skipAgentGuides(page)
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      const body = url.pathname === '/api/canvas/history' ? { messages: [], nextCursor: '' } : url.pathname === '/api/agent/presence' ? { connections: [] } : []
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.reload()
    await expect.poll(() => page.evaluate(() => (window as any).__ambioGraphStore.getState().currentProject?.name)).toBe('Ambio Canvas Fixture')
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const panel = page.getByRole('complementary', { name: 'Agent inbox' })
    const chips = panel.locator('.ambio-inbox__compose .ambio-inbox__targets button')
    await expect(chips).toHaveCount(0)

    // Before typing it offers the map's systems, under a heading, with no extra explanations.
    await panel.getByRole('button', { name: 'Attach context' }).click()
    const picker = panel.getByRole('dialog', { name: 'Attach context' })
    await expect(picker.locator('.ambio-inbox__picker-label').first()).toHaveText('Systems')
    await expect(picker).not.toContainText(/Snapshot|live comparison|Select a sheet/)
    const search = picker.getByRole('combobox', { name: 'Search for context to attach' })
    await search.fill('mcp')
    await page.screenshot({ path: 'test-results/attach-context.png' })
    await picker.getByRole('option', { name: /MCP Server/ }).first().click()
    await expect(picker).toHaveCount(0)
    await expect(chips).toHaveCount(1)
    await expect(chips.first()).toContainText('MCP Server')

    // A file the same way; what is attached shows as attached in the picker.
    await panel.getByRole('button', { name: 'Attach context' }).click()
    await search.fill('AmbioCanvas')
    await picker.getByRole('option', { name: /AmbioCanvas\.tsx/ }).first().click()
    await expect(chips).toHaveCount(2)
    await panel.getByRole('button', { name: 'Attach context' }).click()
    await search.fill('mcp')
    await expect(picker.getByRole('option', { name: /MCP Server/ }).first().locator('svg').last()).toBeVisible()
    await search.press('Escape')

    // With the panel open the bins sit left of it; Unsorted opens right above them.
    const bins = await page.locator('.ambio-bins__row').boundingBox()
    await page.getByRole('button', { name: 'Unsorted files' }).click()
    const window = await page.locator('[data-bin-window]').boundingBox()
    expect(bins && window).toBeTruthy()
    expect(Math.abs((window!.x + window!.width) - (bins!.x + bins!.width))).toBeLessThan(2)
    expect(window!.y + window!.height).toBeLessThanOrEqual(bins!.y)
    expect(bins!.y - (window!.y + window!.height)).toBeLessThan(20)
  } finally { await app.close() }
})
