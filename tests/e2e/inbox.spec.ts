import { _electron as electron, expect, test } from '@playwright/test'

test('canvas inbox attaches selection, retries a lost response, and restores the reply after reload', async () => {
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, AXIOM_E2E: '1' } })
  try {
    const page = await app.firstWindow()
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
      localStorage.removeItem('axiom:inbox-draft:demo')
      localStorage.removeItem('axiom:inbox-draft:demo:pending')
      localStorage.removeItem('axiom:inbox-draft:demo:sheet')
    })
    await page.reload()
    await expect(page.getByText('Axiom Canvas Fixture')).toBeVisible()
    await expect(page.locator('.react-flow__node-system').first()).toBeVisible()
    await page.waitForTimeout(800)
    // Select two actual canvas systems; the composer must see both.
    const nodes = page.locator('.react-flow__node-system')
    await nodes.nth(0).click({ position: { x: 18, y: 16 } })
    await nodes.nth(1).click({ position: { x: 18, y: 16 }, modifiers: ['Shift'] })
    await page.locator('.axiom-selection-actions').getByRole('button', { name: 'Message agent', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Agent inbox' })
    await expect(panel).toBeVisible()
    await expect(panel.locator('.axiom-inbox__compose .axiom-inbox__targets button')).toHaveCount(2)
    const textbox = panel.getByRole('textbox', { name: 'Instruction for your agent' })
    await textbox.fill('Explain how these systems communicate.')
    await panel.getByRole('button', { name: 'Send to inbox', exact: true }).click()
    await expect(panel.getByRole('alert')).toBeVisible()
    await expect(textbox).toHaveValue('Explain how these systems communicate.')
    // Reload with an uncertain send: retain its original ID and attachments.
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await expect(textbox).toHaveValue('Explain how these systems communicate.')
    await expect(panel.locator('.axiom-inbox__compose .axiom-inbox__targets button')).toHaveCount(2)
    await panel.getByRole('button', { name: 'Send to inbox', exact: true }).click()
    await expect(textbox).toHaveValue('')
    await expect(panel.getByRole('region', { name: 'Agent connection and handoff' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Copy handoff' })).toBeVisible()
    await expect(panel.locator('.axiom-inbox__work-order code')).toHaveText(sends[0].id)
    await expect(panel.getByRole('button', { name: 'Connections' })).toBeVisible()
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
    await expect(panel.getByText('Indexed changes')).toBeVisible()
    await expect(panel.getByText('Agent report')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Accept result' })).toBeVisible()
    await panel.getByRole('button', { name: 'Request changes' }).click()
    await panel.getByLabel('What needs to change?').fill('Include the timeout path.')
    await panel.getByRole('button', { name: 'Reopen work order' }).click()
    await expect(panel.getByText('Changes requested · waiting for agent')).toBeVisible()
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
    await page.evaluate(() => localStorage.setItem('axiom:inbox-draft:demo:sheet', JSON.stringify('deleted_sheet')))
    await page.reload()
    await page.getByRole('button', { name: 'Message agent', exact: true }).click()
    await expect(panel.locator('.axiom-inbox__attachment')).toContainText('Sheet unavailable')
    await panel.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Another task')
    await panel.getByRole('button', { name: 'Send to inbox' }).click()
    await expect(panel.getByRole('alert')).toContainText('no longer available')
    expect(sends).toHaveLength(2)
    await panel.getByRole('button', { name: 'Remove attached sheet' }).click()
    await expect(panel.locator('.axiom-inbox__attachment')).toHaveCount(0)
  } finally { await app.close() }
})
