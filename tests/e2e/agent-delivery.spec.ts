import { _electron as electron, expect, test } from '@playwright/test'
import { agentMenu } from './agentGuides'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_CLIENTS, CLI_CLIENTS } from '../../src/shared/agentDelivery'

test('Send launches the selected CLI after saving, preserves failures, and supports editor handoff', async () => {
  test.setTimeout(90000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-delivery-ui-'))
  const root = path.join(home, 'project')
  const bin = path.join(home, 'bin')
  fs.mkdirSync(root); fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.ambio'))
  fs.writeFileSync(path.join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Delivery fixture', rootPath: root, ignoredPaths: [], createdAt: 1 }]))
  const fakeAgent = 'const fs=require("fs");const host=process.env.AMBIO_AGENT_HOST;const prompt=host==="copilot-cli"?process.argv[process.argv.indexOf("--prompt")+1]:fs.readFileSync(0,"utf8");fs.writeFileSync("captured-"+host+".json",JSON.stringify({args:process.argv.slice(2),prompt,cwd:process.cwd(),workspace:process.env.AMBIO_WORKSPACE_ID}));fs.writeSync(1,"Fixture agent started");process.exit(host==="copilot-cli"?7:0)'
  // Claude Code reads its turn as stream-json and is sent nothing more after
  // its result. With steer.flag in the project, the stand-in keeps working
  // after its first message: it takes later messages in and answers them
  // until Stop interrupts it.
  const fakeClaude = 'const fs=require("fs");const out=v=>console.log(JSON.stringify(v));let first=true;require("readline").createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);'
    + 'if(m.type==="control_request"){out({type:"result",is_error:true,subtype:"error_during_execution"});return}if(m.type!=="user")return;out({type:"user",isReplay:true,uuid:m.uuid,message:m.message});'
    + 'if(first){first=false;fs.writeFileSync("captured-claude-code.json",JSON.stringify({args:process.argv.slice(2),prompt:m.message.content,cwd:process.cwd(),workspace:process.env.AMBIO_WORKSPACE_ID}));if(fs.existsSync("steer.flag")){out({type:"assistant",message:{content:[{type:"text",text:"Working on the fixture."}]}});return}out({type:"result",is_error:false,result:"ok"});return}'
    + 'out({type:"assistant",message:{content:[{type:"text",text:"Heard: "+m.message.content}]}})}).on("close",()=>process.exit(0))'
  const scripts: Record<string, string> = { claude: '@anthropic-ai/claude-code/cli.js', codex: '@openai/codex/bin/codex.js', copilot: '@github/copilot/index.js' }
  for (const [name, entry] of Object.entries(scripts)) {
    const script = path.join(bin, 'node_modules', entry)
    const source = name === 'claude' ? fakeClaude : name === 'codex' ? fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-app-server.cjs'), 'utf8') : fakeAgent
    fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, source)
    if (process.platform !== 'win32') fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 })
  }
  const protocolPeer = fs.readFileSync(path.join(__dirname, 'fixtures', 'grok-muse-agent.cjs'), 'utf8')
  const grokBootstrap = path.join(bin, 'node_modules', '@xai-official', 'grok', 'bin', 'grok-bootstrap.js')
  fs.mkdirSync(path.dirname(grokBootstrap), { recursive: true })
  fs.writeFileSync(grokBootstrap, protocolPeer)
  if (process.platform !== 'win32') fs.writeFileSync(path.join(bin, 'grok'), `#!${process.execPath}\n${protocolPeer}`, { mode: 0o755 })
  // A native Node executable called muse runs the fixture's `serve` script.
  // This exercises native CLI discovery on Windows too, without a shell shim.
  fs.copyFileSync(process.execPath, path.join(bin, process.platform === 'win32' ? 'muse.exe' : 'muse'))
  fs.writeFileSync(path.join(root, 'serve'), protocolPeer)
  if (process.platform !== 'win32') fs.writeFileSync(path.join(bin, 'zed'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(root, 'editor-opened.json'))},JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 })
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  // Only the stand-in agents are on PATH. Windows also needs its own system
  // folder there, or Electron cannot start its crash handler and exits.
  const launchPath = process.platform === 'win32' ? [bin, path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')].join(path.delimiter) : bin
  // Electron resolves its data folders from these on Windows; they must exist
  // under the stand-in home or it has nowhere to keep its crash database.
  const windowsProfile = process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}
  for (const dir of Object.values(windowsProfile)) fs.mkdirSync(dir, { recursive: true })
  const app = await electron.launch({
    args: ['.', ...(process.env.AMBIO_HEADLESS_E2E === '1' && process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])],
    env: { ...env, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, '.grok'), XDG_CONFIG_HOME: path.join(home, '.config'), ...windowsProfile, PATH: launchPath, AMBIO_E2E: '1', AMBIO_E2E_AGENTS: '1', AMBIO_API_TOKEN: 'ambio-isolated-ui-delivery-test-token-12345' },
  })
  try {
    const page = await app.firstWindow()
    expect(await page.evaluate(() => window.ambio.listDeliveryHosts())).toHaveLength(APP_CLIENTS.length + CLI_CLIENTS.length)
    await page.setViewportSize({ width: 1280, height: 1000 })
    const orders: any[] = []
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      let body: any = []
      if (url.pathname === '/api/canvas/send') {
        const sent = route.request().postDataJSON()
        orders.push({ ...sent, status: 'queued', createdAt: Date.now() }); body = orders.at(-1)
        // Main reads the durable request, independently of renderer routing.
        await app.evaluate((_, order) => {
          const runtime = globalThis as any
          runtime.deliveryOrders ??= {}
          runtime.deliveryOrders[order.id] = order
          runtime.fetch = async (input: string) => {
            const url = new URL(String(input))
            const found = runtime.deliveryOrders[url.searchParams.get('messageId') ?? '']
            return new Response(JSON.stringify(found ?? { error: 'not found' }), { status: found ? 200 : 404 })
          }
        }, body)
      }
      if (url.pathname === '/api/canvas/cancel') {
        const { msgId } = route.request().postDataJSON()
        const order = orders.find(item => item.id === msgId)
        if (order) order.status = 'cancelled'
      }
      if (url.pathname === '/api/canvas/history') body = { messages: [...orders].reverse(), nextCursor: '', availableCount: orders.length }
      if (url.pathname === '/api/agent/presence') body = { connected: false, connections: [] }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
    const destination = agentMenu(inbox)
    const pillWidths: number[] = []
    // The first time an agent is chosen, its guide stands in front of everything until confirmed.
    const intro = page.getByRole('dialog', { name: /^Before you use / })
    const confirm = () => intro.getByRole('button', { name: 'Got it' }).click()
    await expect(intro).toBeVisible()
    await confirm()
    // The agent menu lists every destination, in Ambio's own menu.
    await destination.open()
    await expect(destination.items()).toHaveCount(APP_CLIENTS.length + CLI_CLIENTS.length + 2)
    await page.screenshot({ path: 'test-results/agent-menu.png' })
    await destination.close()
    await destination.choose('codex')
    await expect(intro).toHaveAccessibleName('Before you use Codex CLI')
    await expect(intro).toContainText('Choose Codex and send.')
    // An agent Ambio runs is sent nothing until the person chooses what it may
    // do without asking. Nothing is preselected; one level is recommended.
    const codexAccess = intro.getByRole('group', { name: 'What Codex CLI may do without asking' })
    await expect(codexAccess.getByRole('radio')).not.toHaveCount(0)
    await expect(codexAccess.getByRole('radio', { checked: true })).toHaveCount(0)
    await expect(codexAccess.locator('label', { hasText: 'Recommended' })).toHaveCount(1)
    await expect(intro.getByRole('button', { name: 'Got it' })).toBeDisabled()
    await page.screenshot({ path: 'test-results/agent-delivery-introduction.png' })
    await codexAccess.getByRole('radio', { name: /^Full access/ }).check()
    await confirm()
    await expect(intro).toBeHidden()
    // The message box keeps no info button or access menu; each agent's guide is on its row in the menu.
    await expect(inbox.getByRole('button', { name: /^Access:/ })).toHaveCount(0)
    await expect(inbox.getByRole('button', { name: 'How each agent works here' })).toHaveCount(0)
    await destination.open()
    await destination.menu.locator('[data-value="codex"]').hover()
    await destination.menu.getByRole('button', { name: 'About Codex CLI' }).hover()
    await page.screenshot({ path: 'test-results/agent-menu-info.png' })
    await destination.menu.getByRole('button', { name: 'About Codex CLI' }).click()
    const guide = page.getByRole('dialog', { name: 'About Codex CLI' })
    const guidePicker = agentMenu(guide, 'Agent to read about')
    await expect(guidePicker.trigger).toHaveAttribute('data-value', 'codex')
    await expect(guide.getByRole('group', { name: 'What Codex CLI may do without asking' }).getByRole('radio', { name: /^Full access/ })).toBeChecked()
    await page.screenshot({ path: 'test-results/agent-delivery-guide.png' })
    // Reading about another agent does not choose it; Use does.
    await guidePicker.choose('claude-code')
    const claudeGuide = page.getByRole('dialog', { name: 'About Claude Code CLI' })
    await expect(claudeGuide).toContainText('Choose Claude Code and send.')
    await expect(destination.trigger).toHaveAttribute('data-value', 'codex')
    const claudeAccess = claudeGuide.getByRole('group', { name: 'What Claude Code CLI may do without asking' })
    await expect(claudeAccess.locator('label', { hasText: 'Recommended' })).toContainText('Auto')
    await expect(claudeAccess.getByRole('radio')).toHaveCount(4)
    await claudeAccess.getByRole('radio', { name: /^Ask me/ }).check()
    await claudeGuide.getByRole('button', { name: 'Use Claude Code CLI' }).click()
    await expect(destination.trigger).toHaveAttribute('data-value', 'claude-code')
    // Read and given a level from its guide, it is not introduced again.
    await expect(intro).toBeHidden()
    await destination.choose('codex')
    await expect(intro).toBeHidden()
    await destination.open()
    await destination.menu.getByRole('button', { name: 'About Codex CLI' }).click()
    await page.keyboard.press('Escape')
    await expect(guide).toBeHidden()
    await expect(inbox).toBeVisible()
    // Once every agent it shows has a level, the guide closes from its corner too,
    // also after reading about another agent in it.
    await destination.open()
    await destination.menu.getByRole('button', { name: 'About Codex CLI' }).click()
    await guide.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(guide).toBeHidden()
    await destination.open()
    await destination.menu.getByRole('button', { name: 'About Codex CLI' }).click()
    await agentMenu(guide, 'Agent to read about').choose('claude-code')
    await claudeGuide.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(claudeGuide).toBeHidden()
    await expect(inbox).toBeVisible()
    for (const [host, label] of [['claude-code', 'Claude Code CLI'], ['codex', 'Codex CLI'], ['grok', 'Grok Build CLI'], ['muse', 'Muse Code CLI'], ['copilot-cli', 'GitHub Copilot CLI']]) {
      await destination.choose(host)
      if (['grok', 'muse', 'copilot-cli'].includes(host)) await confirm()
      // The agent pill keeps one shape whichever agent and model are chosen.
      // Claude Code and Codex carry more beside the model, so their pill gives
      // up some room; nothing in the row is cut off for that.
      if (host === 'claude-code' || host === 'codex') {
        const clipped = await inbox.locator('.ambio-inbox__compose-tools').evaluate(tools => [...tools.querySelectorAll<HTMLElement>('.ambio-inbox__mode-button, .ambio-inbox__model-label')].filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.textContent))
        expect(clipped).toEqual([])
      } else pillWidths.push(Math.round((await inbox.locator('.ambio-inbox__agent-group').boundingBox())!.width))
      await inbox.locator('.ambio-inbox__compose-tools').screenshot({ path: `test-results/pill-${host}.png` })
      // Claude Code's models are offered beside the request type; the choice reaches its command line.
      if (host === 'claude-code') {
        await inbox.getByRole('button', { name: 'Model: Default' }).click()
        // The model menu opens inside the panel, checkmark and scrollbar in view.
        const menuBox = (await inbox.getByRole('menu', { name: 'Model' }).boundingBox())!
        const panelBox = (await inbox.boundingBox())!
        expect(menuBox.x).toBeGreaterThanOrEqual(panelBox.x)
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
        await page.screenshot({ path: 'test-results/model-menu.png' })
        await inbox.getByRole('menuitemradio', { name: 'Opus' }).click()
        // Its effort levels are chosen in the same menu; none is chosen for it.
        await expect(inbox.getByRole('menuitemradio', { name: /^Thinking: / })).toHaveCount(5)
        await inbox.getByRole('menuitemradio', { name: 'Thinking: Extra high' }).click()
        await expect(inbox.getByRole('button', { name: 'Model: Opus, Extra high thinking' })).toBeVisible()
        await page.locator('.ambio-inbox__compose').screenshot({ path: 'test-results/composer-claude.png' })
      }
      await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill(`Handle only the ${host} fixture.`)
      const sentBefore = orders.length
      await inbox.locator('form').getByRole('button', { name: `Start ${label}` }).click()
      // The previous unanswered turn is withdrawn first, so the new order lands a moment later.
      await expect.poll(() => orders.length).toBe(sentBefore + 1)
      const captured = path.join(root, `captured-${host}.json`)
      // Copilot is first tried as an agent session; the stand-in cannot hold one,
      // so the same turn then runs in print mode. Wait for the run that got the prompt.
      await expect.poll(() => { try { return String(JSON.parse(fs.readFileSync(captured, 'utf8')).prompt) } catch { return '' } }).toContain(orders.at(-1).id)
      const actual = JSON.parse(fs.readFileSync(captured, 'utf8'))
      expect(actual.workspace).toBe('demo'); expect(actual.cwd).toBe(fs.realpathSync(root))
      if (host === 'grok' || host === 'muse') {
        expect(actual.permissionHook).toBeUndefined()
        const mcp = host === 'grok' ? actual.mcpServers[0] : actual.mcpServers.ambio
        expect(mcp.args).toContain(`--ambio-host=${host}`)
        const mcpEnv = host === 'grok' ? Object.fromEntries(mcp.env.map((entry: { name: string; value: string }) => [entry.name, entry.value])) : mcp.env
        expect(mcpEnv).toEqual({ AMBIO_WORKSPACE_ID: 'demo' })
        if (host === 'muse') expect(actual.args).toEqual(['serve'])
      }
      if (host === 'claude-code') {
        expect(actual.args[actual.args.indexOf('--model') + 1]).toBe('opus')
        expect(actual.args[actual.args.indexOf('--effort') + 1]).toBe('xhigh')
        // Ask me: Claude's own default mode, its questions answered in Ambio.
        expect(actual.args[actual.args.indexOf('--permission-mode') + 1]).toBe('default')
        expect(actual.args[actual.args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__ambio__approve_action')
      }
      expect(actual.prompt).toContain(orders.at(-1).id)
      expect(actual.prompt).toContain('expectedWorkspaceId "demo"')
      // The stand-in exits without replying: the turn says so in one line, and the next message replaces it.
      await expect(inbox.locator('.ambio-inbox__turn-status').last()).toContainText(host === 'copilot-cli' ? `${label} stopped without an answer.` : `${label} finished without replying.`)
      await expect(inbox.locator('.ambio-turn').last().getByRole('button', { name: 'Try again' })).toBeVisible()
    }
    // The nonzero process exit leaves one saved work order, with output and handoff.
    expect(orders).toHaveLength(5)
    // Earlier turns whose runs ended unanswered were withdrawn when the next message went.
    await expect(inbox.locator('.ambio-inbox__turn-status[data-state="stopped"]')).toHaveText(['Cancelled', 'Cancelled', 'Cancelled', 'Cancelled'])
    await expect(inbox.getByRole('button', { name: 'Show output' })).toHaveCount(1)
    expect(new Set(pillWidths).size).toBe(1)
    const firstMessageId = orders.at(-1).id
    const modifiedAt = fs.statSync(path.join(root, 'captured-copilot-cli.json')).mtimeMs
    await page.evaluate(messageId => window.ambio.deliverWorkOrder({ workspaceId: 'demo', messageId, hostId: 'copilot-cli' }), firstMessageId)
    expect(fs.statSync(path.join(root, 'captured-copilot-cli.json')).mtimeMs).toBe(modifiedAt)
    expect(orders.at(-1).id).toBe(firstMessageId)
    // While Claude Code works the message box stays open: a message joins the
    // turn under way and shows once Claude has taken it in; Stop still ends it.
    fs.writeFileSync(path.join(root, 'steer.flag'), '')
    await destination.choose('claude-code')
    const box = inbox.getByRole('textbox', { name: 'Instruction for your agent' })
    await box.fill('Handle the steering fixture.')
    await inbox.locator('form').getByRole('button', { name: 'Start Claude Code CLI' }).click()
    await expect(inbox.locator('.ambio-inbox__activity').last()).toContainText('Working on the fixture.')
    await expect(box).toBeEnabled()
    await expect(box).toHaveAttribute('placeholder', 'Send a correction while Claude Code CLI works…')
    await box.fill('Also check the tests.')
    await box.press('Enter')
    await expect(inbox.locator('.ambio-inbox__activity').last().locator('li[data-kind="sent"]')).toContainText('Also check the tests.')
    await expect(inbox.locator('.ambio-inbox__activity').last()).toContainText('Heard: Also check the tests.')
    await expect(box).toHaveValue('')
    await page.locator('.ambio-inbox__compose').screenshot({ path: 'test-results/composer-steering.png' })
    // The work streams in the agent's own card, in the conversation's type, not a status box.
    await expect(inbox.locator('.ambio-turn').last()).toHaveAttribute('data-state', 'working')
    await expect(inbox.locator('.ambio-turn').last().getByRole('status')).toContainText('Working')
    await inbox.locator('.ambio-turn').last().screenshot({ path: 'test-results/turn-steered.png' })
    await inbox.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(inbox.locator('.ambio-inbox__turn-status[data-state="stopped"]').last()).toHaveText('Cancelled')
    fs.rmSync(path.join(root, 'steer.flag'))
    // Once the agent answers, its work folds into one line above the answer.
    Object.assign(orders.at(-1), { status: 'answered', reply: { agent: 'claude-code', body: 'Fixture answer: the tests pass.', createdAt: Date.now() } })
    await inbox.getByRole('button', { name: 'Close agent inbox' }).click()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const answered = inbox.locator('.ambio-turn').last()
    await expect(answered).toHaveAttribute('data-state', 'answered')
    await expect(answered.locator('.ambio-inbox__reply-heading')).toContainText('Claude Code CLI')
    await expect(answered).toContainText('Fixture answer: the tests pass.')
    const fold = answered.locator('.ambio-turn__fold')
    await expect(fold.locator('summary')).toContainText(/^Worked for /)
    await expect(fold.getByRole('list', { name: 'What the agent is doing' })).toBeHidden()
    await answered.screenshot({ path: 'test-results/turn-answered.png' })
    await fold.locator('summary').click()
    await expect(fold.getByRole('list', { name: 'What the agent is doing' })).toContainText('Heard: Also check the tests.')
    await answered.screenshot({ path: 'test-results/turn-answered-open.png' })
    if (process.platform !== 'win32') {
      await destination.choose('zed')
      await confirm()
      await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Discuss this in Zed.')
      await inbox.locator('form').getByRole('button', { name: 'Copy + open Zed Editor' }).click()
      await expect.poll(() => fs.existsSync(path.join(root, 'editor-opened.json'))).toBe(true)
      expect(JSON.parse(fs.readFileSync(path.join(root, 'editor-opened.json'), 'utf8'))).toEqual([root])
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(orders.at(-1).id)
      await expect(inbox.getByRole('status').filter({ hasText: 'work has not started yet' })).toBeVisible()
    }
    await page.screenshot({ path: 'test-results/agent-delivery.png' })
    // The panel widens from its left edge, and keeps that width.
    const before = (await inbox.boundingBox())!
    const handle = (await inbox.getByRole('separator', { name: 'Resize the agent panel' }).boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 200, handle.y + handle.height / 2, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await inbox.boundingBox())!.width - before.width)).toBeGreaterThan(190)
    expect(Number(await page.evaluate(() => localStorage.getItem('ambio:sidebar-width')))).toBeGreaterThan(before.width + 190)
    await page.locator('.ambio-inbox__compose').screenshot({ path: 'test-results/composer-wide.png' })
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }) }
})
