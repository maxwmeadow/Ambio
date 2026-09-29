import { _electron as electron, expect, test } from '@playwright/test'

test('work-order review distinguishes the sent sheet from a later revision', async () => {
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, AXIOM_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    const sheet = { id: 'sheet_design', workspaceId: 'demo', name: 'Checkout revised', purpose: 'New scope', kind: 'structure', folder: '', createdBy: 'user', revision: 5, createdAt: 1, updatedAt: 2 }
    let sheetAvailable = true
    const message = {
      id: 'order-with-sheet', workspaceId: 'demo', deliveryMode: 'addressed', sheetId: sheet.id,
      sentSheetName: 'Checkout original', sentSheetRevision: 4,
      note: 'Implement the original checkout plan.', selection: '[]', changeSummary: '', sheetContext: '', buildSpec: '',
      status: 'answered', deliveredTo: 'codex', answerAnnotationId: null, createdAt: Date.now(),
      reply: { body: 'Ready for review.', agent: 'codex', createdAt: Date.now() },
    }
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      let body: unknown = []
      if (url.pathname === '/api/sheets') body = sheetAvailable ? [sheet] : []
      if (url.pathname === '/api/canvas/history') body = { messages: [message], nextCursor: '', availableCount: 0 }
      if (url.pathname === '/api/canvas/snapshot') body = {
        sheetContext: JSON.stringify({ sheet: { name: 'Checkout original', purpose: 'Original checkout scope', revision: 4 }, nodes: [{ id: 'planned:checkout', name: 'Checkout service', type: 'system', planned: true }], edges: [], notes: [] }),
        buildSpec: 'Build the original checkout service.',
      }
      if (url.pathname === '/api/canvas/snapshot-comparison') body = {
        messageId: message.id, sheetId: sheet.id, name: 'Checkout original', revision: 4,
        equivalent: false, checked: 1, differences: [{ kind: 'nesting', nodeId: 'planned:checkout', name: 'Checkout service', detail: 'The sent parent is not present in the live architecture' }], mappings: {},
      }
      if (url.pathname === '/api/sheets/sheet_design/compare') body = {
        sheetId: sheet.id, name: sheet.name, revision: sheet.revision, token: 'current', equivalent: false,
        checked: 1, differences: [{ kind: 'nesting', nodeId: 'child', name: 'Checkout', detail: 'Current revision differs' }], nodes: [], mappings: {},
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const panel = page.getByRole('complementary', { name: 'Agent inbox' })
    await expect(panel.getByText('Checkout original · sent r4')).toBeVisible()
    await panel.getByRole('button', { name: /Review result/ }).click()
    await expect(panel.getByText('Checkout original · revision 4')).toBeVisible()
    await expect(panel.getByText(/Current sheet is revision 5/)).toBeVisible()
    await expect(panel.getByText('Current sheet structure')).toBeVisible()
    await expect(panel.getByText('1 structural difference')).toBeVisible()
    await expect(panel.getByText('1 sent-plan structural difference')).toBeVisible()
    await panel.getByRole('button', { name: /1 sent-plan structural difference/ }).click()
    await expect(panel.getByText('The sent parent is not present in the live architecture')).toBeVisible()
    await panel.getByRole('button', { name: 'View sent plan' }).click()
    await expect(panel.getByText('Build the original checkout service.')).toBeVisible()
    await expect(panel.getByText('Checkout service · system · planned')).not.toBeVisible()
    await panel.getByText('Nodes sent (1)').click()
    await expect(panel.getByText('Checkout service · system · planned')).toBeVisible()
    await page.screenshot({ path: 'test-results/sheet-review-revision.png' })
    sheetAvailable = false
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await panel.getByRole('button', { name: /Review result/ }).click()
    await expect(panel.getByText('The current sheet is unavailable. The agent received its frozen context when this order was sent.')).toBeVisible()
    await panel.getByRole('button', { name: 'View sent plan' }).click()
    await expect(panel.getByText('Build the original checkout service.')).toBeVisible()
    await expect(panel.getByText('Current sheet structure')).toHaveCount(0)
  } finally { await app.close() }
})

test('sheet attachment follows live differences, survives Floor navigation, and archives/restores', async () => {
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, AXIOM_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 1000 })
    const sheet: any = { id:'sheet_design',workspaceId:'demo',name:'Checkout redesign',purpose:'Restructure checkout',kind:'structure',folder:'',createdBy:'user',revision:4,createdAt:1,updatedAt:1 }
    let equivalent = false
    const sent: any[] = []
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      let body: any = []
      if (url.pathname === '/api/sheets') body = [sheet]
      if (url.pathname === '/api/sheets/sheet_design') body = {sheet,elements:[],annotations:[],planned:[],plannedEdges:[],layouts:[]}
      if (url.pathname.endsWith('/compare')) body = {
        sheetId:sheet.id,name:sheet.name,revision:sheet.revision,token:'comparison',equivalent,resolvedAt:sheet.resolvedAt,checked:2,
        differences:equivalent?[]:[{kind:'nesting',nodeId:'child',name:'Checkout service',actual:'old',expected:'new',detail:'Move inside Checkout'}],
        nodes:[{id:'old',name:'Old system'},{id:'new',name:'Checkout'}],mappings:{},
      }
      if (url.pathname.endsWith('/reopen')) { delete sheet.resolvedAt; sheet.revision++; body=sheet }
      if (url.pathname === '/api/canvas/history') body = {messages:sent,nextCursor:'',availableCount:sent.length}
      if (url.pathname === '/api/canvas/send') {
        const message = route.request().postDataJSON()
        sent.push({...message,status:'queued',createdAt:Date.now()});body=sent.at(-1)
      }
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})
    })
    await page.evaluate(() => {
      localStorage.removeItem('axiom:inbox-draft:demo')
      localStorage.removeItem('axiom:inbox-draft:demo:pending')
      localStorage.removeItem('axiom:inbox-draft:demo:sheet')
    })
    await page.reload()
    await expect(page.getByText('Axiom Canvas Fixture')).toBeVisible()
    const rail = page.getByRole('complementary',{name:'Drawings'})
    await rail.getByRole('button',{name:/Checkout redesign STR/}).click()
    await rail.getByRole('button',{name:'Attach Checkout redesign to agent message'}).click()
    const panel = page.getByRole('complementary',{name:'Agent inbox'})
    const attachment = panel.locator('.axiom-inbox__attachment')
    await expect(attachment).toContainText(sheet.name)
    await panel.getByRole('button',{name:'Remove attached sheet'}).click()
    await expect(attachment).toHaveCount(0)
    const instruction = panel.getByRole('textbox',{name:'Instruction for your agent'})
    await instruction.press('@')
    const picker = panel.getByRole('dialog',{name:'Attach a sheet'})
    await expect(picker).toBeVisible()
    await picker.getByRole('combobox',{name:'Search sheets'}).fill('checkout')
    await page.screenshot({path:'test-results/inbox-picker.png'})
    await picker.getByRole('combobox',{name:'Search sheets'}).press('Enter')
    await expect(picker).toHaveCount(0)
    await expect(attachment).toContainText(sheet.name)
    await expect(panel.getByText('1 structural difference',{exact:true})).toBeVisible()
    await expect(panel.getByText('Old system → Checkout')).toHaveCount(0)
    await panel.getByRole('button',{name:/1 structural difference/}).click()
    await expect(panel.getByText('Old system → Checkout')).toBeVisible()
    await panel.getByRole('button',{name:'Watch live canvas'}).click()
    await expect(rail.getByRole('button',{name:/The Floor/})).toHaveAttribute('aria-current','page')
    await expect(attachment).toContainText(sheet.name)
    await instruction.fill('Implement this sheet and resolve it when the structure matches.')
    await panel.getByRole('button',{name:'Send to inbox',exact:true}).click()
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0].sheetId).toBe(sheet.id)
    equivalent = true
    await expect(panel.getByText('Structure matches the live canvas')).toBeVisible({timeout:10000})
    // Simulate the agent's checked resolve response arriving through refresh.
    sheet.resolvedAt = Date.now()
    await expect(panel.getByText('Sheet resolved · saved in history')).toBeVisible({timeout:10000})
    await expect(rail.getByRole('button',{name:/Checkout redesign STR/})).toHaveCount(0,{timeout:10000})
    await rail.getByRole('button',{name:'Resolved sheets (1)'}).click()
    await rail.getByRole('button',{name:'Restore Checkout redesign'}).click()
    await expect(rail.getByRole('button',{name:/Checkout redesign STR/})).toBeVisible()
    await expect(attachment).toContainText(sheet.name)
    await expect(panel.getByText('Structure matches the live canvas')).toBeVisible({timeout:10000})
    await page.screenshot({path:'test-results/sheet-work.png'})
  } finally { await app.close() }
})
