const fs = require('node:fs')
const path = require('node:path')

// Shared drawing coordinates: cap/ascender y20, x-height y40, baseline y108,
// 4-unit crown apertures and rounded architectural counters. A is unchanged.
const letters = [
  {letter:'a',width:94,d:'M17 108 48 31Q52 20 62 20V40L49 74Q56 68 64 68Q72 68 79 74L66 40V20Q76 20 80 31L111 108H89L85 96Q80 83 64 83Q48 83 43 96L39 108Z',offset:17},
  {letter:'m',width:102,d:'M0 108V60Q0 40 20 40H27V58H24Q20 58 20 64V108ZM31 40H34Q47 40 51 51Q55 40 68 40H71V58H68Q61 58 61 67V108H41V67Q41 58 34 58H31ZM75 40H82Q102 40 102 60V108H82V64Q82 58 78 58H75Z',offset:0},
  {letter:'b',width:74,d:'M0 108V30Q0 20 8 20V38H12V20Q20 20 20 30V45Q28 40 39 40Q74 40 74 74Q74 110 39 110Q28 110 20 104V108ZM20 73V78Q20 92 37 92Q54 92 54 75Q54 58 37 58Q20 58 20 73Z',offset:0},
  {letter:'i',width:24,d:'M0 29Q0 20 10 20V31H14V20Q24 20 24 29Q24 38 12 38Q0 38 0 29ZM2 48H22V108H2Z',offset:0},
  {letter:'o',width:76,d:'M36 40V58Q20 58 20 74Q20 92 38 92Q56 92 56 74Q56 58 40 58V40Q76 40 76 74Q76 110 38 110Q0 110 0 74Q0 40 36 40Z',offset:0},
]
const gap = 10
let advance = 0
const pieces = letters.map(g => {
  const piece = `<path fill-rule="evenodd" transform="translate(${advance-g.offset},0)" d="${g.d}"/>`
  advance += g.width + gap
  return piece
}).join('')
const width = advance-gap
function word(fill='currentColor') {return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 12 ${width+8} 104" fill="${fill}" role="img" aria-label="Ambio custom architectural wordmark">${pieces}</svg>`}
for (const [name,fill] of [['custom-ambio','currentColor'],['custom-ambio-teal','#244b45'],['custom-ambio-reversed','#f5f3ed']]) fs.writeFileSync(path.join(__dirname,`${name}.svg`),word(fill))
for(const g of letters) fs.writeFileSync(path.join(__dirname,`custom-letter-${g.letter}.svg`),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 12 ${g.width+8} 104" fill="currentColor" role="img" aria-label="Ambio letter ${g.letter==='a'?'A':g.letter}"><path fill-rule="evenodd" transform="translate(${-g.offset},0)" d="${g.d}"/></svg>`)
const glyphs=letters.map(g=>`<div><svg viewBox="-4 12 ${g.width+8} 104" fill="currentColor"><path fill-rule="evenodd" transform="translate(${-g.offset},0)" d="${g.d}"/></svg><span>${g.letter==='a'?'A':g.letter}</span></div>`).join('')
fs.writeFileSync(path.join(__dirname,'custom-wordmark.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ambio / custom lettering</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#244b45;font-family:'Segoe UI',sans-serif}main{max-width:1280px;margin:auto;padding:36px 48px}header{display:flex;justify-content:space-between;border-bottom:1px solid #ccd4ca;padding-bottom:18px}header b{font-size:24px;font-weight:500}header span{font-size:11px;letter-spacing:1px;text-transform:uppercase}h1{font-size:32px;font-weight:400;margin:24px 0 8px}p{font-size:14px;line-height:1.6;color:#62736a;margin:0 0 24px}.hero{padding:46px;background:#e8ebe3;display:flex;justify-content:center}.hero svg{width:85%;max-height:180px}.dark{background:#244b45;color:#f5f3ed;margin-top:14px}.glyphs{display:flex;justify-content:space-between;gap:24px;padding:26px 20px;border-bottom:1px solid #ccd4ca}.glyphs>div{display:flex;flex-direction:column;align-items:center;gap:12px;flex:1}.glyphs svg{height:94px;max-width:100%}.glyphs span{font-size:11px;color:#62736a}.sizes{display:flex;gap:35px;align-items:flex-end;padding:24px 0}.sizes>div{display:flex;flex-direction:column;gap:12px;align-items:flex-start}.sizes svg{width:auto}.sizes span{font-size:11px;color:#62736a}nav{display:flex;gap:24px;border-top:1px solid #ccd4ca;padding-top:18px}a{font-size:12px;color:inherit;text-underline-offset:4px}footer{font-size:11px;color:#62736a;margin-top:20px}@media(max-width:650px){main{padding:24px}.hero{padding:28px 16px}.hero svg{width:100%}.glyphs{gap:12px;padding:20px 0}.glyphs svg{height:65px}.sizes{flex-wrap:wrap}header span{max-width:130px;text-align:right}}</style><main><header><b>ambio</b><span>Custom lettering / 08 October 2026</span></header><h1>One architectural alphabet.</h1><p>A complete custom wordmark: the finished A, paired with purpose-drawn lowercase m, b, i and o. Shared weight, split crowns and curved openings carry the idea through every letter.</p><div class="hero">${word()}</div><div class="hero dark">${word()}</div><div class="glyphs">${glyphs}</div><div class="sizes">${[24,40,64].map(n=>`<div>${word().replace('<svg ','<svg style="height:'+n+'px" ')}<span>${n}px display height</span></div>`).join('')}</div><nav><a href="custom-ambio-teal.svg">Teal SVG</a><a href="custom-ambio-reversed.svg">Reversed SVG</a><a href="custom-ambio.svg">Inheriting-colour SVG</a></nav><footer>Original A silhouette preserved. All five letters are editable vector paths; no font dependency. Display wordmark study.</footer></main></html>`)

