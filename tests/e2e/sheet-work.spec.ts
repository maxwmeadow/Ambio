import { _electron as electron, expect, test } from '@playwright/test'

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
