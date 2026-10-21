import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { canvasScaleFixture } from '../fixtures/canvasScale'
import { createHash } from 'node:crypto'
import { canvasComponentCounts, installCanvasCameraTrace } from './canvasComponentCounts'
import { isCanvasSourceFile } from '../../src/shared/fileKinds'

// Large tiers are explicit opt-in. Failed tiers remain failures with artifacts.
const enabled = process.env.AMBIO_SCALE === '1'
const sizes = (process.env.AMBIO_SCALE_SIZES ?? '1000,10000,100000').split(',').map(Number)
const shape = process.env.AMBIO_SCALE_SHAPE ?? 'saved'
const coldTimeout = Number(process.env.AMBIO_SCALE_TIMEOUT_MS ?? 30000)
const cycles = Number(process.env.AMBIO_SCALE_CYCLES ?? 2)
const runName = process.env.AMBIO_SCALE_RUN ?? new Date().toISOString().replace(/[:.]/g,'-')
const outputDir = resolve(process.env.AMBIO_SCALE_OUTPUT ?? join('out','canvas-scale',runName))
function quantiles(values: number[]) {
  const sorted = [...values].sort((a,b)=>a-b)
  return { count:sorted.length, p50:sorted[Math.floor(sorted.length*.5)]??null,
    p95:sorted[Math.floor(sorted.length*.95)]??null,p99:sorted[Math.floor(sorted.length*.99)]??null,max:sorted.at(-1)??null }
}
function growthRatio(values: Array<number|null>) {
  if(values.length<12||values.some(value=>value===null||!Number.isFinite(value)||value<=0))return null
  return quantiles(values.slice(-5) as number[]).p50!/quantiles(values.slice(5,10) as number[]).p50!
}
async function deadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})]) }
  finally { clearTimeout(timer!) }
}
async function closeFixture(app: ElectronApplication) {
  try { await deadline(app.close(),4000,'fixture shutdown timeout') }
  catch { await deadline(app.evaluate(({app})=>app.exit(0)),4000,'fixture exit timeout').catch(()=>{}) }
}

for (const entities of sizes) test(`scale ${shape} ${entities} entities`, async ({}, info) => {
  test.skip(!enabled,'Set AMBIO_SCALE=1 for controlled scale measurements')
  expect(Number.isSafeInteger(cycles)&&cycles>0&&cycles<=500).toBe(true)
  expect(['saved','unsaved','deep','edges','hub']).toContain(shape)
  test.setTimeout(coldTimeout+Math.max(60000,cycles*4000))
  const home=mkdtempSync(join(tmpdir(),'ambio-scale-'))
  const appData=join(home,'AppData','Roaming'),localData=join(home,'AppData','Local')
  mkdirSync(appData,{recursive:true});mkdirSync(localData,{recursive:true})
  const report:any={schemaVersion:1,status:'running',entities,shape,cycles,mockedEndpoints:true,events:[],memory:[],
    cameraIntentTrace:process.env.AMBIO_SCALE_CAMERA_TRACE==='1',
    buildFingerprint:createHash('sha256').update(readFileSync('out/renderer/index.html')).digest('hex'),
    reference:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,
      logicalCpus:cpus().length,hostRamBytes:totalmem(),viewport:{width:1400,height:900}},
    memoryUnit:'Sampled Electron process metrics: KiB; page JavaScript heap: bytes. Worker heap is included in process memory, not separately measured.',
    budgets:{frameP95Ms:16.7,frameP99Ms:33.3,frameToleranceMs:0.25,inputP95Ms:50,memoryGrowthRatio:1.1}}
  let app:ElectronApplication|undefined,memoryTimer:ReturnType<typeof setTimeout>|undefined
  let stopProfile:(()=>Promise<void>)|undefined
  let collecting=true,samplingMemory=false,peakPrivateKiB=0,latestPrivateKiB:number|null=null
  const {ELECTRON_RUN_AS_NODE:_node,ELECTRON_RENDERER_URL:_url,...env}=process.env
  try {
    app=await electron.launch({args:['.','--js-flags=--max-old-space-size=1536'],
      env:{...env,HOME:home,USERPROFILE:home,APPDATA:appData,LOCALAPPDATA:localData,AMBIO_E2E:'1',AMBIO_E2E_HOME:'1'}})
    const page=await app.firstWindow()
    page.setDefaultTimeout(8000)
    page.on('pageerror',error=>{report.pageErrors??=[];if(report.pageErrors.length<10)report.pageErrors.push(error.message)})
    page.on('console',message=>{
      if(message.text().startsWith('AMBIO_PERF_STAGE')) {
        if(report.events.length===64)report.events.shift()
        try {report.events.push(JSON.parse(message.text().slice('AMBIO_PERF_STAGE'.length).trim()))}catch{}
      }
    })
    await page.waitForURL(/e2e=1/);await page.setViewportSize(report.reference.viewport)
    let apiOrigin=''
    const snapshot=process.env.AMBIO_PERF_SNAPSHOT?JSON.parse(readFileSync(process.env.AMBIO_PERF_SNAPSHOT,'utf8'))
      :canvasScaleFixture({entities,roots:4,depth:shape==='deep'?20:1,
        edges:shape==='hub'?'hub':shape==='edges'?'chain':'none',saved:shape!=='unsaved',
        visibleSystems:Number(process.env.AMBIO_SCALE_LOCAL_SYSTEMS??8)})
    const body=JSON.stringify(snapshot)
    // Floor dependencies are not persistent React Flow edges. Exercise real
    // relationship paths through an active sheet, rather than timing metadata.
    const edgeSheet=['edges','hub'].includes(shape)?{
      sheet:{id:'scale-relationships',workspaceId:'demo',name:'Scale Relationships',purpose:'',kind:'structure',
        folder:'',createdBy:'user',revision:1,createdAt:1,updatedAt:1},
      elements:[],annotations:[],planned:[],layouts:[],removals:[],
      plannedEdges:snapshot.dependencies.map((edge:any)=>({id:edge.id,sheetId:'scale-relationships',
        kind:'DEPENDS_ON',srcPlanned:null,dstPlanned:null,note:'',
        srcLive:edge.src,dstLive:edge.dst,approvalStatus:'approved',createdBy:'user'})),
    }:null
    if(edgeSheet)report.sheetFingerprint=createHash('sha256').update(JSON.stringify(edgeSheet)).digest('hex')
    report.fixtureFingerprint=createHash('sha256').update(body).digest('hex')
    report.fixture={source:process.env.AMBIO_PERF_SNAPSHOT?'snapshot-replay':'synthetic',systems:snapshot.systems.length,files:snapshot.files.length,edges:snapshot.dependencies.length,
      layouts:snapshot.floorLayouts?.length??0,roots:new Set(snapshot.files.map((f:any)=>f.rootId)).size,bytes:Buffer.byteLength(body)}
    await page.route(/^http:\/\/127\.0\.0\.1:\d+\//,async route=>{
      const url=new URL(route.request().url());apiOrigin=url.origin
      if(url.pathname==='/api/snapshot/scale-fixture')await route.fulfill({body,contentType:'application/json'})
      else if(edgeSheet&&url.pathname==='/api/sheets')await route.fulfill({json:[edgeSheet.sheet]})
      else if(edgeSheet&&url.pathname==='/api/sheets/scale-relationships')await route.fulfill({json:edgeSheet})
      else await route.fulfill({json:url.pathname==='/api/agent/presence'?{connected:false,connections:[]}
        :url.pathname==='/api/canvas/history'?{messages:[],availableCount:0,nextCursor:''}:[]})
    })
    const url=new URL(page.url());url.searchParams.delete('home');await page.goto(url.toString())
    await page.waitForFunction(()=>Boolean((window as any).__ambioGraphStore&&(window as any).__ambioPerfTrace))
    await expect.poll(()=>apiOrigin).not.toBe('')
    const canvas=page.locator('[data-ambio-canvas]').first();await expect(canvas).toBeVisible()
    if(process.env.AMBIO_SCALE_SOLID_EDGES==='1'){
      report.diagnosticSolidEdges=true
      await page.addStyleTag({content:'.react-flow__edge-path { stroke-dasharray: none !important; }'})
    }
    report.reference.browser=await page.evaluate(()=>({userAgent:navigator.userAgent,pixelRatio:devicePixelRatio,
      hardwareConcurrency:navigator.hardwareConcurrency,visibility:document.visibilityState,focused:document.hasFocus()}))
    report.reference.refreshIntervalMs=await page.evaluate(async()=>{
      const values:number[]=[];let previous=0
      await new Promise<void>(resolve=>{const frame=(now:number)=>{if(previous)values.push(now-previous);previous=now;
        if(values.length<30)requestAnimationFrame(frame);else resolve()};requestAnimationFrame(frame)})
      return values.sort((a,b)=>a-b)[Math.floor(values.length/2)]
    })
    const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable')
    if(process.env.AMBIO_SCALE_CAMERA_TRACE==='1')await page.evaluate(installCanvasCameraTrace)
    if(process.env.AMBIO_SCALE_PROFILE==='1'){
      report.instrumented=true
      await cdp.send('Profiler.enable');await cdp.send('Profiler.start')
      stopProfile=async()=>{
        const result=await deadline(cdp.send('Profiler.stop'),3000,'CPU profile unavailable')
        mkdirSync(outputDir,{recursive:true})
        writeFileSync(join(outputDir,`${shape}-${entities}-${info.repeatEachIndex}.cpuprofile`),JSON.stringify(result.profile))
      }
    }
    const before=await cdp.send('Performance.getMetrics')
    const sampleMemory=async()=>{
      if(!collecting||samplingMemory)return
      samplingMemory=true
      try {
        const processes=await deadline(app!.evaluate(({app})=>app.getAppMetrics().map(p=>({type:p.type,pid:p.pid,memory:p.memory}))),1500,'memory unavailable')
        if(processes.some(p=>typeof p.memory.privateBytes==='number')){
          latestPrivateKiB=processes.reduce((n,p)=>n+(p.memory.privateBytes??0),0)
          peakPrivateKiB=Math.max(peakPrivateKiB,latestPrivateKiB)
        }
        if(report.memory.length<128)report.memory.push({at:Date.now(),processes})
        if(peakPrivateKiB>2*1024*1024){
          report.resourceFailure='isolated fixture exceeded 2 GiB private-memory guard'
          collecting=false
          await app!.evaluate(({app})=>app.exit(0)).catch(()=>{})
        }
      }catch{report.memorySampleMisses=(report.memorySampleMisses??0)+1}
      finally{samplingMemory=false;if(collecting)memoryTimer=setTimeout(sampleMemory,500)}
    }
    await sampleMemory()
    await page.evaluate(()=>{
      const w=window as any;w.__ambioPerfTrace.start({events:true})
      w.__scale={frames:[],phaseFrames:{cold:[],navigation:[],warm:[]},phase:'cold',inputs:[],selection:[],longTasks:[],peakDom:0,peakNodes:0,running:true}
      const observer=new PerformanceObserver(list=>{
        for(const task of list.getEntries())if(w.__scale.longTasks.length<512)
          w.__scale.longTasks.push({at:task.startTime,ms:task.duration,phase:w.__scale.phase})
      })
      observer.observe({type:'longtask'});w.__scale.stopObserving=()=>observer.disconnect()
      let previous=performance.now(),sampled=0
      const frame=(now:number)=>{const s=w.__scale;if(!s.running)return
        const elapsed=now-previous;previous=now
        if(s.frames.length<20000)s.frames.push(elapsed)
        const phase=s.phaseFrames[s.phase];if(phase.length<20000)phase.push(elapsed)
        if(now-sampled>250){sampled=now;s.peakDom=Math.max(s.peakDom,document.querySelectorAll('*').length);
          s.peakNodes=Math.max(s.peakNodes,document.querySelectorAll('.react-flow__node').length)}
        requestAnimationFrame(frame)};requestAnimationFrame(frame)
      window.addEventListener('pointerdown',event=>{
        const dispatched=event.timeStamp,received=performance.now()
        const node=(event.target as Element)?.closest('.react-flow__node')
        if(node&&!node.classList.contains('selected')){
          const observer=new MutationObserver(()=>{
            if(!node.classList.contains('selected'))return
            observer.disconnect()
            requestAnimationFrame(()=>requestAnimationFrame(()=>{if(w.__scale?.running)
              w.__scale.selection.push(performance.now()-dispatched)}))
          })
          observer.observe(node,{attributes:true,attributeFilter:['class']})
          setTimeout(()=>observer.disconnect(),2000)
        }
        requestAnimationFrame(()=>requestAnimationFrame(()=>{if(w.__scale?.running&&w.__scale.inputs.length<1000)
          w.__scale.inputs.push({queueMs:received-dispatched,paintOpportunityMs:performance.now()-dispatched})}))
      },true)
    })
    const started=Date.now(),box=(await canvas.boundingBox())!
    const opening=page.evaluate(async url=>{
      const w=window as any,trace=w.__ambioPerfTrace,start=performance.now()
      let at=performance.now();trace.begin('snapshot.fetch')
      const response=await fetch(url);trace.record('snapshot.fetch',performance.now()-at)
      at=performance.now();trace.begin('snapshot.decode')
      const snapshot=await response.json();trace.record('snapshot.decode',performance.now()-at,snapshot.files.length+snapshot.systems.length)
      w.__ambioGraphStore.getState().applySnapshot(snapshot)
      return{applyReturnedMs:performance.now()-start}
    },`${apiOrigin}/api/snapshot/scale-fixture`)
    let probing=true
    const coldInput=(async()=>{while(probing){await page.mouse.click(box.x+20,box.y+20).catch(()=>{});await new Promise(r=>setTimeout(r,100))}})()
    try{report.cold=await deadline(opening,coldTimeout,'cold preparation exceeded deadline')}
    catch(error){probing=false;report.failureStage=report.events.at(-1);throw error}
    try{
      await deadline(page.waitForFunction(()=>{
        const w=window as any
        return Boolean(w.__ambioPerfTrace.summary().stages['scene.geometry'])
      }),coldTimeout,'scene materialization exceeded deadline')
      // A valid camera can be between distant roots. Prove two frame opportunities
      // here; require a visible, centered, selectable destination after search.
      await deadline(page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))),
        coldTimeout,'scene frame opportunity exceeded deadline')
      report.initialView=await page.evaluate(()=>({nodes:document.querySelectorAll('.react-flow__node').length,
        transform:document.querySelector('.react-flow__viewport')?.getAttribute('style')}))
    }finally{
      probing=false
      await deadline(coldInput,2000,'cold input probe remained queued').catch(()=>{report.coldProbeIncomplete=true})
    }
    report.cold.wallMs=Date.now()-started
    if(edgeSheet){
      await page.getByRole('button',{name:'Scale Relationships STR',exact:true}).click()
      await page.getByLabel('Show All Sheet Relationships',{exact:true}).check()
    }
    await page.evaluate(()=>(window as any).__scale.phase='navigation')
    const target=snapshot.systems.find((s:any)=>!s.parentId)!
    await page.keyboard.press('ControlOrMeta+K')
    await page.getByRole('textbox',{name:'Search the map'}).fill(target.name)
    await page.getByRole('option').filter({hasText:target.name}).first().click()
    const targetNode=canvas.locator(`.react-flow__node[data-id="${target.id}"]`)
    await expect(targetNode).toBeVisible();await page.waitForTimeout(1200)
    await expect.poll(()=>targetNode.evaluate(el=>{const r=el.getBoundingClientRect(),map=el.closest('.react-flow')!.getBoundingClientRect();
      return r.width>20&&Math.abs((r.left+r.right-map.left-map.right)/2)<12})).toBe(true)
    if(edgeSheet){
      // Frame the common hub before asserting actual paths. Fully offscreen
      // chain edges are correctly culled; a hub has every path in this view.
      const paths=canvas.locator('.react-flow__edge-path')
      if(shape==='hub')await expect(paths).toHaveCount(edgeSheet.plannedEdges.length)
      else await expect.poll(()=>paths.count()).toBeGreaterThan(0)
      for(const edge of shape==='hub'?[edgeSheet.plannedEdges[0],edgeSheet.plannedEdges.at(-1)!]:[edgeSheet.plannedEdges[0]]){
        const path=canvas.locator(`.react-flow__edge[data-id="pedge:${edge.id}"] .react-flow__edge-path`)
        expect(await path.getAttribute('d')).toMatch(/^M/)
        expect(await path.getAttribute('d')).not.toContain('NaN')
      }
      report.fixture.renderedRelationships=await paths.count()
    }
    report.cold.usableMs=Date.now()-started
    await page.evaluate(()=>(window as any).__scale.phase='warm')
    for(let cycle=0;cycle<cycles;cycle++){
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
      for(const direction of[-1,1,-1,1]){await page.mouse.wheel(0,direction*80);await page.waitForTimeout(30)}
      await page.waitForTimeout(250)
      const clearPoint=await canvas.evaluate(root=>{
        const pane=root.querySelector('.react-flow__pane')!,r=pane.getBoundingClientRect()
        for(const x of [20,60,r.width-20])for(const y of [20,60,r.height-20])
          if(document.elementFromPoint(r.left+x,r.top+y)===pane)return{x:r.left+x,y:r.top+y}
        throw Error('No exposed pane point for a real deselection click')
      })
      await page.mouse.click(clearPoint.x,clearPoint.y)
      await expect(targetNode).not.toHaveClass(/selected/)
      // A container's center can correctly be covered by a nested child.
      await targetNode.click({position:{x:10,y:10}})
      await expect.poll(()=>page.evaluate(()=>(window as any).__ambioGraphStore.getState().selectedNodeId)).toBe(target.id)
      report.pageHeap??=[];report.pageHeap.push((await cdp.send('Runtime.getHeapUsage')).usedSize)
      report.processPrivateKiB??=[];report.processPrivateKiB.push(latestPrivateKiB)
      if(peakPrivateKiB>2*1024*1024)throw Error('isolated fixture exceeded 2 GiB private-memory guard')
    }
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
    report.observed=await page.evaluate(()=>{
      const w=window as any,s=w.__scale;s.running=false;s.stopObserving()
      return{frames:s.frames,phaseFrames:s.phaseFrames,inputs:s.inputs,selection:s.selection,peakDom:s.peakDom,peakNodes:s.peakNodes,
        longTasks:s.longTasks,cameraTrace:w.__canvasCameraTrace,finalEdges:document.querySelectorAll('.react-flow__edge-path').length,
        finalNodes:document.querySelectorAll('.react-flow__node').length,metrics:{...w.__ambioPerfMetrics},trace:w.__ambioPerfTrace.summary()}
    })
    report.components=await page.evaluate(canvasComponentCounts)
    expect(report.components.canonicalNodes).toBe(snapshot.files.filter((file:any)=>file.systemId&&isCanvasSourceFile(file)).length+
      snapshot.systems.length+snapshot.infraNodes.length)
    expect(report.components.wrappers).toBeGreaterThan(0)
    expect(report.components.wrappers).toBeLessThanOrEqual(Math.max(64,report.components.domNodes*2))
    expect(report.components.minimapWrappers).toBe(0)
    report.frames=quantiles(report.observed.frames);delete report.observed.frames
    report.phaseFrames=Object.fromEntries(Object.entries(report.observed.phaseFrames).map(([phase,values])=>[phase,quantiles(values as number[])]))
    delete report.observed.phaseFrames
    report.selectionFeedback=quantiles(report.observed.selection);delete report.observed.selection
    report.inputQueue=quantiles(report.observed.inputs.map((i:any)=>i.queueMs))
    report.inputToPaintOpportunity=quantiles(report.observed.inputs.map((i:any)=>i.paintOpportunityMs));delete report.observed.inputs
    const after=await cdp.send('Performance.getMetrics')
    report.browserWork=Object.fromEntries(after.metrics.filter(m=>['ScriptDuration','TaskDuration','LayoutDuration','RecalcStyleDuration','LayoutCount'].includes(m.name))
      .map(m=>[m.name,m.value-(before.metrics.find(b=>b.name===m.name)?.value??0)]))
    report.sampledPeakPrivateKiB=peakPrivateKiB||null
    report.memoryGrowthRatio=growthRatio(report.pageHeap)
    report.processMemoryGrowthRatio=growthRatio(report.processPrivateKiB)
    expect(report.observed.finalNodes).toBeGreaterThan(0)
    expect(report.observed.metrics.maxBudgetBatch).toBeLessThanOrEqual(6)
    expect(report.pageErrors??[]).toEqual([])
    report.status='measured'
    report.targets={frameP95:report.phaseFrames.warm.count>=60?report.phaseFrames.warm.p95<=16.7+report.budgets.frameToleranceMs:null,
      frameP99:report.phaseFrames.warm.count>=60?report.phaseFrames.warm.p99<=33.3+report.budgets.frameToleranceMs:null,
      selection:report.selectionFeedback.count>=20?report.selectionFeedback.p95<=50:null,
      inputPaint:report.inputToPaintOpportunity.count?report.inputToPaintOpportunity.p95<=50:null,
      memory:cycles>=50&&report.memoryGrowthRatio!==null&&report.processMemoryGrowthRatio!==null
        ?report.memoryGrowthRatio<=1.1&&report.processMemoryGrowthRatio<=1.1:null}
    report.performanceAccepted=Object.values(report.targets).every(v=>v===true)
    if(process.env.AMBIO_SCALE_ENFORCE==='1')expect(Object.values(report.targets).every(v=>v===true)).toBe(true)
  }catch(error){
    report.status='failed';report.failureStage??=report.events.at(-1);report.sampledPeakPrivateKiB=peakPrivateKiB||null;report.error=String(error)
    if(app)try{
      const page=await deadline(app.firstWindow(),1000,'window unavailable')
      report.failureDiagnostics=await deadline(page.evaluate(()=>({
        nodes:document.querySelectorAll('.react-flow__node').length,
        transform:document.querySelector('.react-flow__viewport')?.getAttribute('style'),
        longTasks:(window as any).__scale?.longTasks,
        trace:(window as any).__ambioPerfTrace?.summary(),metrics:(window as any).__ambioPerfMetrics,
        cameraTrace:(window as any).__canvasCameraTrace,
      })),1500,'renderer did not respond to diagnostic probe')
    }catch(probe){report.failureDiagnostics={error:String(probe)}}
    throw error
  }
  finally{
    collecting=false;clearTimeout(memoryTimer)
    if(stopProfile)try{await stopProfile()}catch(error){report.profileError=String(error)}
    const path=info.outputPath('canvas-scale.json');writeFileSync(path,JSON.stringify(report,null,2))
    mkdirSync(outputDir,{recursive:true})
    const persistentPath=join(outputDir,`${shape}-${entities}-${info.repeatEachIndex}.json`)
    writeFileSync(persistentPath,JSON.stringify(report,null,2))
    await info.attach('canvas-scale',{path,contentType:'application/json'})
    console.log('CANVAS_SCALE',JSON.stringify({entities,shape,status:report.status,cold:report.cold,frames:report.frames,
      targets:report.targets,failureStage:report.failureStage,error:report.error,report:persistentPath}))
    if(app)await closeFixture(app)
    if(dirname(resolve(home))===resolve(tmpdir())&&basename(home).startsWith('ambio-scale-')){
      try{rmSync(home,{recursive:true,force:true})}catch{console.warn('Isolated fixture cleanup remains at',home)}
    }
  }
})
