const fs = require('node:fs')
const path = require('node:path')

// Each mark is drawn as filled paths. Colour is optional; the geometry carries the identity.
const studies = [
  {
    id: 'shared-span', name: 'Shared span', note: 'A continuous silhouette. Two sides meet at a quiet stepped seam.',
    paths: [
      'M18 108 54 20H64V72H71V80H64V84H43L34 108ZM49 68H64V39Z',
      'M64 20H74L110 108H94L85 84H64V80H71V72H64V68H79L64 39Z',
    ],
  },
  {
    id: 'open-arch', name: 'Open arch', note: 'A split crown and an arched span. Architectural, with a softer cadence.',
    paths: [
      'M17 108 48 31Q52 20 62 20V40L49 74Q56 68 64 68V83Q48 83 43 96L39 108Z',
      'M66 20Q76 20 80 31L111 108H89L85 96Q80 83 64 83V68Q72 68 79 74L66 40Z',
    ],
  },
  {
    id: 'reciprocal', name: 'Reciprocal', note: 'Two equal members overlap at the span. A small offset makes the exchange visible.',
    paths: [
      'M17 108 52 20H63L45 70H72V84H40L32 108Z',
      'M65 20H76L111 108H96L86 80H56V66H81Z',
    ],
  },
]
const mark = (s, two = false) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Ambio ${s.name}" style="color:inherit"><path fill="${two ? '#244b45' : 'currentColor'}" d="${s.paths[0]}"/><path fill="${two ? '#7d9f8e' : 'currentColor'}" d="${s.paths[1]}"/></svg>`
for (const s of studies) {
  fs.writeFileSync(path.join(__dirname, `${s.id}.svg`), mark(s))
  fs.writeFileSync(path.join(__dirname, `${s.id}-two-tone.svg`), mark(s, true))
}
const cards = studies.map((s, i) => `<article><header><span>0${i + 1}</span><h2>${s.name}</h2></header><div class="hero">${mark(s, true)}</div><div class="lockup">${mark(s)}<b>ambio</b></div><p>${s.note}</p><div class="proof"><div class="mono">${mark(s)}<small>One colour</small></div><div class="reverse">${mark(s)}<small>Reversed</small></div></div><div class="sizes">${[16,24,32,48].map(n => `<div>${mark(s).replace('style="color:inherit"', `style="color:inherit;width:${n}px;height:${n}px"`)}<small>${n}px</small></div>`).join('')}</div><a href="${s.id}.svg">SVG / mono</a> <a href="${s.id}-two-tone.svg">SVG / two tone</a></article>`).join('')
fs.writeFileSync(path.join(__dirname, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ambio — vector identity studies</title><style>
@font-face{font-family:Plex;src:url('../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2')}@font-face{font-family:Plex;src:url('../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2');font-weight:500}
*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#244b45;font-family:Plex,'Segoe UI',sans-serif}main{max-width:1440px;margin:auto;padding:46px 56px} .mast{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #cdd4ca;padding-bottom:24px}.mast b{font-size:28px;font-weight:500;letter-spacing:-1px}.mast span{font-size:12px;letter-spacing:1.6px;text-transform:uppercase}h1{font-size:38px;line-height:1.2;letter-spacing:-1px;font-weight:400;margin:30px 0 8px}.intro{color:#62736a;font-size:15px;margin:0 0 35px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:34px}article{min-width:0}article+article{border-left:1px solid #d4d9d0;padding-left:34px}header{display:flex;align-items:center;gap:12px}header span{font-size:12px;color:#708c7c}h2{font-size:20px;font-weight:400;margin:0}.hero{height:235px;display:flex;align-items:center;justify-content:center}.hero svg{width:220px;height:220px}.lockup{display:flex;gap:14px;align-items:center;justify-content:center;height:64px}.lockup svg{width:48px;height:48px}.lockup b{font-size:44px;font-weight:500;letter-spacing:-1.9px}p{font-size:14px;line-height:1.6;color:#62736a;min-height:46px;margin:22px 0}.proof{display:grid;grid-template-columns:1fr 1fr;gap:8px}.proof>div{height:124px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px}.proof svg{width:72px;height:72px}.mono{background:#e8ebe3}.reverse{background:#244b45;color:#f5f3ed}small{font-size:10px;letter-spacing:.4px}.sizes{display:flex;justify-content:space-around;align-items:flex-end;height:92px;padding-bottom:14px;margin-bottom:16px;border-bottom:1px solid #d4d9d0}.sizes>div{display:flex;flex-direction:column;align-items:center;gap:9px}a{font-size:11px;color:#244b45;margin-right:14px;text-underline-offset:4px}footer{margin-top:30px;font-size:11px;color:#62736a}@media(max-width:800px){main{padding:24px}.grid{grid-template-columns:1fr}article+article{border-left:0;border-top:1px solid #d4d9d0;padding:24px 0 0}.mast span{max-width:150px;text-align:right}}
</style><main><div class="mast"><b>ambio</b><span>Identity exploration / 06 October 2026</span></div><h1>Two sides. One shared structure.</h1><p class="intro">Three vector studies of the A and its joining span. Flat geometry, optional colour, actual-size checks.</p><div class="grid">${cards}</div><footer>Exploratory artwork · Editable SVG paths · Wordmark study set in IBM Plex Sans · No generated imagery</footer></main></html>`)
