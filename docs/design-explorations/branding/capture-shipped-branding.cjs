const { chromium, expect } = require('@playwright/test')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

// Capture the actual production renderer bundle with a local fixture bridge.
// Native assets/tray are checked separately by native-icon-smoke.cjs.
async function main() {
  const root = path.resolve('out/renderer')
  const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff':'font/woff', '.woff2':'font/woff2', '.wasm':'application/wasm' }
  const server = http.createServer((request,response) => {
    const url = new URL(request.url, 'http://localhost')
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return }
    response.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream')
    response.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const browser = await chromium.launch(process.platform === 'win32' ? { channel:'msedge', headless:true } : {headless:true})
  try {
    const page = await browser.newPage({viewport:{width:1400,height:900}})
    const failures=[]
    page.on('pageerror', error=>failures.push(error.message))
    page.on('console', message=>{ if(message.type()==='error') console.error(message.text()) })
    await page.addInitScript(() => {
      const noop = () => {}
      window.ambio = new Proxy({
        platform:'win32',
        archdPortsSync:()=>({api:7743,ws:7744}),
        listRecentProjects:async()=>JSON.parse(localStorage.getItem('brand-review-projects') || '[]'),
        listTrash:async()=>[],
        getUpdateStatus:async()=>({state:'idle'}),
        getAppInfo:async()=>({version:'0.1.0',platform:'win32',isPackaged:false}),
      },{get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? ()=>noop : async()=>null})
    })
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//,route=>route.fulfill({status:200,contentType:'application/json',body:'[]'}))
    const url=`http://127.0.0.1:${server.address().port}/?e2e=1&home=1`
    await page.goto(url)
    await expect(page.locator('.ambio-launcher__body')).toHaveAttribute('data-mode','first-run')
    await expect(page.getByRole('heading',{name:'Ambio',exact:true})).toBeVisible()
    await page.evaluate(()=>document.fonts.ready)
    const broken = await page.locator('.ambio-wordmark').evaluateAll(images=>images.some(image=>!image.complete || !image.naturalWidth))
    if(broken)throw new Error('A wordmark failed to load')
    await page.screenshot({path:path.join(__dirname,'shipped-launcher.png')})
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('ambio:command',{detail:'app.about'})))
    await expect(page.locator('.ambio-about .ambio-wordmark')).toBeVisible()
    await page.screenshot({path:path.join(__dirname,'shipped-about.png')})
    await page.keyboard.press('Escape')
    await page.evaluate(()=>localStorage.setItem('brand-review-projects',JSON.stringify([{id:'branding-fixture',name:'Brand review',rootPath:'C:/brand-review',ignoredPaths:[],languageOverrides:{},openedAt:1}])))
    await page.reload()
    await expect(page.locator('.ambio-launcher__body')).toHaveAttribute('data-mode','projects')
    await page.screenshot({path:path.join(__dirname,'shipped-projects.png')})
    await page.setViewportSize({width:900,height:600})
    await page.screenshot({path:path.join(__dirname,'shipped-projects-compact.png')})
    await page.setViewportSize({width:1400,height:900})
    await page.goto(url.replace('&home=1',''))
    await expect(page.locator('.ambio-title-strip .ambio-wordmark')).toBeVisible()
    await page.locator('.ambio-toolbar').screenshot({path:path.join(__dirname,'shipped-toolbar.png')})
    if(failures.length)throw new Error(failures.join('\n'))
    console.log('Built launcher, projects, About and toolbar branding verified at desktop and minimum window sizes')
  } finally {
    await browser.close()
    server.close()
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
