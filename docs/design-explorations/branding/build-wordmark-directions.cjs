const fs = require('node:fs')
const path = require('node:path')

const a = {width:94,offset:17,d:'M17 108 48 31Q52 20 62 20V40L49 74Q56 68 64 68Q72 68 79 74L66 40V20Q76 20 80 31L111 108H89L85 96Q80 83 64 83Q48 83 43 96L39 108Z'}
// Symmetric about x57. Both crowns and both counters are exact reflections;
// sloping supports and rounded crowns follow A rather than a font-style m.
const m = {width:114,d:'M0 108 22 53Q26 42 34 42Q42 42 46 53L57 84L68 53Q72 42 80 42Q88 42 92 53L114 108H94L83 79Q82 76 80 76Q78 76 77 79L66 108H48L37 79Q36 76 34 76Q32 76 31 79L20 108Z'}
// Each direction is its own drawn alphabet. The logo's notch remains exclusive
// to A; shared weight, curve tension and counter proportions establish kinship.
const directions = [
  {id:'round',name:'Round & balanced',tag:'01 / Natural letterforms',note:'Round bowls, mirrored sloping arches and a circular dot. The family resemblance comes from weight and open counters.',gap:7,letters:[
    m,
    {width:73,d:'M0 20H18V50Q27 41 40 41Q73 41 73 75Q73 110 40 110Q26 110 18 100V108H0ZM18 75Q18 93 37 93Q55 93 55 75Q55 58 37 58Q18 58 18 75Z'},
    {width:23,d:'M2 44H21V108H2ZM1 29A10.5 10.5 0 1 0 22 29A10.5 10.5 0 1 0 1 29Z'},
    {width:72,d:'M0 75Q0 41 36 41Q72 41 72 75Q72 110 36 110Q0 110 0 75ZM18 75Q18 93 36 93Q54 93 54 75Q54 58 36 58Q18 58 18 75Z'},
  ]},
  {id:'precision',name:'Quiet precision',tag:'02 / Compact & squared',note:'The same mirrored m with tighter, squared bowls. Square terminals bring structure without adding ornamental cuts.',gap:8,letters:[
    m,
    {width:68,d:'M0 20H18V47Q25 42 36 42Q68 42 68 66V85Q68 110 36 110Q24 110 18 104V108H0ZM18 66V86Q18 93 33 93Q50 93 50 84V68Q50 59 33 59Q18 59 18 66Z'},
    {width:22,d:'M2 44H20V108H2ZM2 20H20V36H2Z'},
    {width:68,d:'M0 66Q0 42 34 42Q68 42 68 66V85Q68 110 34 110Q0 110 0 85ZM18 68V84Q18 93 34 93Q50 93 50 84V68Q50 59 34 59Q18 59 18 68Z'},
  ]},
  {id:'portal',name:'Arched rhythm',tag:'03 / Custom portal forms',note:'The m is two open arches; b and o use taller oval counters. Rounded crowns echo the A through the silhouette itself.',gap:9,letters:[
    m,
    {width:70,d:'M0 108V29Q0 20 9 20Q18 20 18 29V49Q27 42 38 42Q70 42 70 75Q70 110 38 110Q26 110 18 102V108ZM18 74V78Q18 94 35 94Q52 94 52 76Q52 58 35 58Q18 58 18 74Z'},
    {width:22,d:'M2 108V53Q2 44 11 44Q20 44 20 53V108ZM0 29Q0 20 11 20Q22 20 22 29Q22 38 11 38Q0 38 0 29Z'},
    {width:68,d:'M0 75Q0 40 34 40Q68 40 68 75Q68 110 34 110Q0 110 0 75ZM18 75Q18 94 34 94Q50 94 50 75Q50 56 34 56Q18 56 18 75Z'},
  ]},
]
function word(s,fill='currentColor'){
  let x=0
  const paths=[a,...s.letters].map(g=>{const p=`<path fill-rule="evenodd" transform="translate(${x-(g.offset||0)},0)" d="${g.d}"/>`;x+=g.width+s.gap;return p}).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 12 ${x-s.gap+8} 104" fill="${fill}" role="img" aria-label="Ambio — ${s.name}">${paths}</svg>`
}
for(const s of directions){
  for(const [suffix,fill] of [['','currentColor'],['-teal','#244b45'],['-reversed','#f5f3ed']])fs.writeFileSync(path.join(__dirname,`wordmark-${s.id}${suffix}.svg`),word(s,fill))
  for(const [index,g] of [a,...s.letters].entries())fs.writeFileSync(path.join(__dirname,`letter-${s.id}-${'Ambio'[index]}.svg`),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 12 ${g.width+8} 104" fill="currentColor" role="img" aria-label="${'Ambio'[index]}"><path fill-rule="evenodd" transform="translate(${-(g.offset||0)},0)" d="${g.d}"/></svg>`)
}
const cards=directions.map(s=>`<article><header><span>${s.tag}</span><h2>${s.name}</h2></header><div class="hero">${word(s)}</div><div class="reverse">${word(s)}</div><p>${s.note}</p><div class="glyphs">${[a,...s.letters].map(g=>`<svg viewBox="-4 12 ${g.width+8} 104" fill="currentColor"><path fill-rule="evenodd" transform="translate(${-(g.offset||0)},0)" d="${g.d}"/></svg>`).join('')}</div><div class="sizes">${[24,40].map(n=>`<div>${word(s).replace('<svg ','<svg style="height:'+n+'px" ')}<small>${n}px</small></div>`).join('')}</div><nav><a href="wordmark-${s.id}-teal.svg">Teal SVG</a><a href="wordmark-${s.id}-reversed.svg">Reversed SVG</a></nav></article>`).join('')
fs.writeFileSync(path.join(__dirname,'wordmark-directions.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ambio / custom wordmark directions</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#244b45;font-family:'Segoe UI',sans-serif}main{max-width:1540px;margin:auto;padding:36px 44px}.mast{display:flex;justify-content:space-between;border-bottom:1px solid #ccd4ca;padding-bottom:18px}.mast b{font-size:24px;font-weight:500}.mast span,header span{font-size:10px;letter-spacing:1px;text-transform:uppercase}h1{font-size:32px;font-weight:400;letter-spacing:-.6px;margin:24px 0 8px}.intro{font-size:14px;line-height:1.6;color:#62736a;margin:0 0 28px;max-width:920px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}article{background:#e8ebe3;padding:24px 20px}header span{color:#62736a}h2{font-size:22px;font-weight:500;margin:8px 0 12px}.hero{height:156px;display:flex;align-items:center;justify-content:center}.hero svg{width:100%;height:auto}.reverse{background:#244b45;color:#f5f3ed;padding:24px 12px;display:flex;align-items:center;justify-content:center}.reverse svg{width:100%;height:auto}p{font-size:13px;line-height:1.6;color:#62736a;min-height:83px;margin:20px 0 12px}.glyphs{display:flex;justify-content:space-between;gap:8px;padding:14px 0;border-top:1px solid #cbd3c8;border-bottom:1px solid #cbd3c8}.glyphs svg{height:53px;max-width:24%}.sizes{padding:20px 0;display:flex;flex-direction:column;gap:20px}.sizes>div{display:flex;align-items:center;justify-content:space-between;gap:12px}.sizes svg{width:auto;max-width:90%}small{font-size:10px;color:#62736a}nav{display:flex;gap:22px}a{color:inherit;font-size:11px;text-underline-offset:4px}footer{font-size:11px;color:#62736a;margin-top:24px}@media(max-width:950px){main{padding:24px}.grid{grid-template-columns:1fr}article{max-width:620px;width:100%;margin:auto}.hero svg{max-width:470px}.reverse svg{max-width:470px}.mast span{max-width:130px;text-align:right}p{min-height:0}}</style><main><div class="mast"><b>ambio</b><span>Custom wordmark / second pass</span></div><h1>A shared language, with less repetition.</h1><p class="intro">Three lowercase directions around the same finished A and a corrected, symmetric m. Its split crown stays distinctive; the other letters share proportions, weight and curve tension. No typeface substitutions or generated imagery.</p><div class="grid">${cards}</div><footer>All artwork is editable SVG. A geometry is identical in every direction. These are alternatives for review; none replaces the selected standalone mark.</footer></main></html>`)

