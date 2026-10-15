"""Typography-led alternatives: original A, mirrored m, mature b/i/o outlines."""
from pathlib import Path
from urllib.request import urlopen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen, replayRecording
import json

ROOT = Path(__file__).resolve().parent
FONTS = ROOT / 'fonts'
MARK = 'M17 108 48 31Q52 20 62 20V40L49 74Q56 68 64 68Q72 68 79 74L66 40V20Q76 20 80 31L111 108H89L85 96Q80 83 64 83Q48 83 43 96L39 108Z'

def source(folder, filename):
    target = FONTS / filename
    if not target.exists():
        encoded = filename.replace('[','%5B').replace(']','%5D')
        target.write_bytes(urlopen(f'https://raw.githubusercontent.com/google/fonts/main/ofl/{folder}/{encoded}', timeout=30).read())
    license_file = FONTS / f'{folder}-OFL.txt'
    if not license_file.exists():
        license_file.write_bytes(urlopen(f'https://raw.githubusercontent.com/google/fonts/main/ofl/{folder}/OFL.txt',timeout=30).read())
    return target

def bounds(glyphs, name):
    pen=BoundsPen(glyphs)
    glyphs[name].draw(pen)
    return pen.bounds

def round_i_dot(glyphs, name, xheight, stem):
    recording=RecordingPen()
    glyphs[name].draw(recording)
    contours=[]
    current=[]
    for operation in recording.value:
        current.append(operation)
        if operation[0] in ('closePath','endPath'):
            contours.append(current)
            current=[]
    if current:
        raise ValueError('Unclosed i contour')
    parts=[]
    dots=0
    for contour in contours:
        bp=BoundsPen(glyphs)
        replayRecording(contour,bp)
        left,bottom,right,top=bp.bounds
        if bottom>xheight:
            cx=(left+right)/2
            cy=(bottom+top)/2
            # A circle needs optical overshoot relative to a rectangular stem.
            # Inscribing it in the former square made the dot visibly too light.
            radius=stem*1.12/2
            parts.append(f'M{cx-radius:.8f},{cy:.8f}a{radius:.8f},{radius:.8f} 0 1 0 {2*radius:.8f},0a{radius:.8f},{radius:.8f} 0 1 0 {-2*radius:.8f},0Z')
            dots+=1
        else:
            pen=SVGPathPen(glyphs)
            replayRecording(contour,pen)
            parts.append(pen.getCommands())
    if dots!=1:
        raise ValueError(f'Expected one dot, found {dots}')
    return ''.join(parts)

def stem_width(glyphs, name, y):
    # Sample the i stem at mid x-height. Quadratics/cubics are
    # flattened only for measurement; original outlines are retained for export.
    from fontTools.pens.basePen import BasePen
    class CrossSection(BasePen):
        def __init__(self):
            super().__init__(glyphs); self.lines=[]; self.current=None; self.start=None
        def _moveTo(self,p): self.current=p; self.start=p
        def _lineTo(self,p): self.lines.append((self.current,p)); self.current=p
        def _curveToOne(self,p1,p2,p3):
            p0=self.current
            for i in range(1,101):
                t=i/100; u=1-t
                self._lineTo(tuple(u**3*p0[j]+3*u*u*t*p1[j]+3*u*t*t*p2[j]+t**3*p3[j] for j in range(2)))
        def _qCurveToOne(self,p1,p2):
            p0=self.current
            for i in range(1,101):
                t=i/100; u=1-t
                self._lineTo(tuple(u*u*p0[j]+2*u*t*p1[j]+t*t*p2[j] for j in range(2)))
        def _closePath(self): self._lineTo(self.start)
    pen=CrossSection(); glyphs[name].draw(pen)
    xs=[]
    for p,q in pen.lines:
        if min(p[1],q[1])<=y<max(p[1],q[1]):
            xs.append(p[0]+(y-p[1])*(q[0]-p[0])/(q[1]-p[1]))
    xs.sort()
    return xs[1]-xs[0]

specs=[
    ('geist','Instrument',source('geist','Geist[wght].ttf'),740,'Geist 740','Crisp terminals and steady stroke weight. The most restrained direction.'),
    ('manrope','Geometric',source('manrope','Manrope[wght].ttf'),780,'Manrope 780','Rounder bowls and a larger x-height. A warmer, substantial wordmark.'),
    ('space','Technical',source('spacegrotesk','SpaceGrotesk[wght].ttf'),700,'Space Grotesk 700','Tighter curves and a squarer rhythm. More angular without deforming the letters.'),
]
cards=[]
metrics=[]
for ident,title,filename,weight,font_label,note in specs:
    font=instantiateVariableFont(TTFont(filename),{'wght':weight},inplace=False)
    glyphs=font.getGlyphSet(); cmap=font.getBestCmap()
    bname=cmap[ord('b')]
    scale=88/bounds(glyphs,bname)[3]
    xheight=bounds(glyphs,cmap[ord('x')])[3]*scale
    stem=stem_width(glyphs,cmap[ord('i')],bounds(glyphs,cmap[ord('x')])[3]*0.5)*scale
    # Construct one mirrored m, matching this font's x-height and i stem weight.
    # Coordinates normalised to 66 units tall; the two counters are reflections.
    sy=xheight/66; t=stem/sy; w=5.5*t; c=w/2; shoulder=w/4
    def f(v): return f'{v:.5f}'
    left_inner=t; mid_left=c-t/2; mid_right=c+t/2; right_inner=w-t
    crown=0; bottom=66; inner_top=t; center_drop=t*0.75
    mpath=(f'M0 66V{f(1.6*t)}Q0 0 {f(shoulder)} 0Q{f(c-t*.55)} 0 {f(c)} {f(center_drop)}'
           f'Q{f(c+t*.55)} 0 {f(w-shoulder)} 0Q{f(w)} 0 {f(w)} {f(1.6*t)}V66H{f(right_inner)}V{f(2*t)}'
           f'Q{f(right_inner)} {f(inner_top)} {f(w-shoulder)} {f(inner_top)}Q{f(mid_right)} {f(inner_top)} {f(mid_right)} {f(2.5*t)}V66H{f(mid_left)}V{f(2.5*t)}'
           f'Q{f(mid_left)} {f(inner_top)} {f(shoulder)} {f(inner_top)}Q{f(left_inner)} {f(inner_top)} {f(left_inner)} {f(2*t)}V66Z')
    mwidth=w*sy
    # Place by visible boundaries, without the font sidebearings. Individual
    # gaps account for i's narrow stem, dot and adjacent round letters.
    positions=[]
    pieces=[f'<path d="{MARK}"/>']
    x=111+4
    pieces.append(f'<path transform="translate({f(x)},{f(108-xheight)}) scale({f(sy)})" d="{mpath}"/>')
    x+=mwidth
    for ch,gap in [('b',8),('i',9),('o',8)]:
        name=cmap[ord(ch)]; bb=bounds(glyphs,name)
        x+=gap
        tx=x-bb[0]*scale
        pen=SVGPathPen(glyphs); glyphs[name].draw(pen)
        outline=round_i_dot(glyphs,name,xheight/scale,stem/scale) if ident=='manrope' and ch=='i' else pen.getCommands()
        pieces.append(f'<path transform="translate({f(tx)},108) scale({scale:.8f},-{scale:.8f})" d="{outline}"/>')
        positions.append({'letter':ch,'visibleLeft':x,'visibleWidth':(bb[2]-bb[0])*scale,'gap':gap})
        x+=(bb[2]-bb[0])*scale
    def art(fill='currentColor'):
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="9 12 {x-9+4:.3f} 104" fill="{fill}" role="img" aria-label="Ambio {title} wordmark">{"".join(pieces)}</svg>'
    for suffix,fill in [('', 'currentColor'),('-teal','#244b45'),('-reversed','#f5f3ed')]:
        (ROOT/f'tech-{ident}{suffix}.svg').write_text(art(fill),encoding='utf-8')
    metrics.append({'id':ident,'font':font_label,'xHeight':xheight,'stemWidth':stem,'mWidth':mwidth,'letters':positions})
    cards.append(f'<article><header><span>0{len(cards)+1} / {font_label}</span><h2>{title}</h2></header><div class="hero">{art()}</div><div class="reverse">{art()}</div><p>{note}</p><div class="sizes">'+''.join(f'<div>{art().replace("<svg ", f"<svg style=\"height:{h}px\" ")}<small>{h}px</small></div>' for h in [24,40])+f'</div><nav><a href="tech-{ident}-teal.svg">Teal SVG</a><a href="tech-{ident}-reversed.svg">Reversed SVG</a></nav></article>')
(ROOT/'tech-wordmark-metrics.json').write_text(json.dumps(metrics,indent=2),encoding='utf-8')
(ROOT/'tech-wordmarks.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ambio / typography-led wordmarks</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#244b45;font-family:'Segoe UI',sans-serif}main{max-width:1540px;margin:auto;padding:36px 44px}.mast{display:flex;justify-content:space-between;border-bottom:1px solid #ccd4ca;padding-bottom:18px}.mast b{font-size:24px;font-weight:500}.mast span,header span{font-size:10px;letter-spacing:1px;text-transform:uppercase}h1{font-size:32px;font-weight:400;letter-spacing:-.6px;margin:24px 0 8px}.intro{font-size:14px;line-height:1.6;color:#62736a;margin:0 0 28px;max-width:900px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}article{background:#e8ebe3;padding:24px 20px}header span{color:#62736a}h2{font-size:23px;font-weight:500;margin:8px 0 12px}.hero{height:170px;display:flex;align-items:center;justify-content:center}.hero svg{width:100%;height:auto}.reverse{background:#244b45;color:#f5f3ed;padding:30px 12px;display:flex;align-items:center;justify-content:center}.reverse svg{width:100%;height:auto}p{font-size:13px;line-height:1.6;color:#62736a;min-height:62px;margin:20px 0}.sizes{padding:20px 0;display:flex;flex-direction:column;gap:20px;border-top:1px solid #cbd3c8}.sizes>div{display:flex;align-items:center;justify-content:space-between;gap:12px}.sizes svg{width:auto;max-width:90%}small{font-size:10px;color:#62736a}nav{display:flex;gap:22px}a{color:inherit;font-size:11px;text-underline-offset:4px}.references{font-size:12px;line-height:1.7;color:#62736a;margin-top:28px;max-width:980px}.references a{font-size:12px}footer{font-size:11px;color:#62736a;margin-top:20px}@media(max-width:950px){main{padding:24px}.grid{grid-template-columns:1fr}article{max-width:620px;width:100%;margin:auto}.hero svg{max-width:470px}.reverse svg{max-width:470px}.mast span{max-width:130px;text-align:right}p{min-height:0}}</style><main><div class="mast"><b>ambio</b><span>Typography-led / reference study</span></div><h1>The A carries the identity.</h1><p class="intro">Three clean wordmarks with the original A, a mirrored custom m and crisp lowercase b, i and o. Each m matches its companion lettering's stem weight and x-height. All artwork is outlined SVG.</p><div class="grid">''' + ''.join(cards) + '''</div><div class="references">Reference lens: <a href="https://www.anthropic.com/">Anthropic</a>, <a href="https://linear.app/brand">Linear</a> and <a href="https://vercel.com/font">Vercel / Geist</a>. The design interpretation here is consistent letterforms, controlled spacing and a distinctive focal mark. Ambio retains its own symbol; no reference logo has been copied.</div><footer>A geometry unchanged. b/i/o use typeface outlines; m is redrawn with mirrored counters and shoulders. Font sources and licenses are in fonts/. These alternatives supersede the distorted custom lettering studies.</footer></main></html>''',encoding='utf-8')
print('Built three typography-led SVG wordmarks')
