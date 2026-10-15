"""Build outlined type studies. Requires fontTools; downloaded fonts keep their licenses."""
from pathlib import Path
from urllib.request import urlopen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
import json

ROOT = Path(__file__).resolve().parent
FONTS = ROOT / 'fonts'
FONTS.mkdir(exist_ok=True)
MARK = 'M17 108 48 31Q52 20 62 20V40L49 74Q56 68 64 68Q72 68 79 74L66 40V20Q76 20 80 31L111 108H89L85 96Q80 83 64 83Q48 83 43 96L39 108Z'

def download(folder, filename):
    target = FONTS / filename
    if not target.exists():
        url = f'https://raw.githubusercontent.com/google/fonts/main/ofl/{folder}/{filename.replace("[", "%5B").replace("]", "%5D")}'
        target.write_bytes(urlopen(url, timeout=30).read())
    license_path = FONTS / f'{folder}-OFL.txt'
    if not license_path.exists():
        license_path.write_bytes(urlopen(f'https://raw.githubusercontent.com/google/fonts/main/ofl/{folder}/OFL.txt', timeout=30).read())
    return target

families = [
    ('plex', 'IBM Plex Sans', ROOT.parents[2] / 'node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff', 700, 4, 5, 'Humanist / technical', 'Angular shoulders; closest to the existing application typography.'),
    ('space', 'Space Grotesk', download('spacegrotesk', 'SpaceGrotesk[wght].ttf'), 700, 3, 4, 'Grotesque / technical', 'Square shoulders and compact rhythm; a sharper display direction.'),
    ('manrope', 'Manrope', download('manrope', 'Manrope[wght].ttf'), 800, 4, 5, 'Geometric / substantial', 'More weight and round counters; tests a closer balance with the pillars.'),
    ('outfit', 'Outfit', download('outfit', 'Outfit[wght].ttf'), 750, 3, 4, 'Geometric / soft', 'Rounded forms echo the curved span; the most relaxed pairing.'),
]

def kern(font, left, right):
    # Apply horizontal pair positioning from the font's default kern feature.
    if 'GPOS' not in font: return 0
    table = font['GPOS'].table
    indexes = set()
    for record in table.FeatureList.FeatureRecord:
        if record.FeatureTag == 'kern': indexes.update(record.Feature.LookupListIndex)
    amount = 0
    for index in sorted(indexes):
        lookup = table.LookupList.Lookup[index]
        for sub in lookup.SubTable:
            if lookup.LookupType == 9: sub = sub.ExtSubTable
            if not hasattr(sub, 'PairSet') and not hasattr(sub, 'Class1Record'): continue
            if left not in sub.Coverage.glyphs: continue
            if sub.Format == 1:
                pairset = sub.PairSet[sub.Coverage.glyphs.index(left)]
                pairs = [p for p in pairset.PairValueRecord if p.SecondGlyph == right]
                if not pairs: continue
                value = pairs[0].Value1
            else:
                c1 = sub.ClassDef1.classDefs.get(left, 0)
                c2 = sub.ClassDef2.classDefs.get(right, 0)
                value = sub.Class1Record[c1].Class2Record[c2].Value1
            amount += getattr(value, 'XAdvance', 0) if value else 0
            break
    return amount

cards = []
metrics = []
for ident, name, source, weight, lower_gap, caps_gap, category, note in families:
    font = TTFont(source)
    if 'fvar' in font: font = instantiateVariableFont(font, {'wght': weight}, inplace=False)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    cap_pen = BoundsPen(glyphs)
    glyphs[cmap[ord('H')]].draw(cap_pen)
    cap_height = cap_pen.bounds[3]
    scale = 88 / cap_height
    variants = {}
    for label, text, gap in [('lower', 'mbio', lower_gap), ('caps', 'MBIO', caps_gap)]:
        # Lowercase ascenders can exceed cap height (notably Plex). Match the b's
        # visible ascender for mixed case; retain H height for the capitals.
        if label == 'lower':
            ascender_pen = BoundsPen(glyphs)
            glyphs[cmap[ord('b')]].draw(ascender_pen)
            alignment_height = ascender_pen.bounds[3]
        else:
            alignment_height = cap_height
        scale = 88 / alignment_height
        cursor = 0
        pieces = []
        names = [cmap[ord(c)] for c in text]
        first_bounds = BoundsPen(glyphs)
        glyphs[names[0]].draw(first_bounds)
        # Place the visible first stem, not its advance box, relative to the A's right foot.
        start = 111 + gap - first_bounds.bounds[0] * scale
        for i, glyph_name in enumerate(names):
            pen = SVGPathPen(glyphs)
            glyphs[glyph_name].draw(pen)
            pieces.append(f'<path transform="translate({cursor},0)" d="{pen.getCommands()}"/>')
            cursor += font['hmtx'].metrics[glyph_name][0]
            if i + 1 < len(names): cursor += kern(font, glyph_name, names[i+1])
        width = start + cursor * scale + 10
        body = f'<path d="{MARK}"/><g transform="translate({start:.5f},108) scale({scale:.8f},-{scale:.8f})">{"".join(pieces)}</g>'
        art = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="7 8 {width-7:.3f} 112" role="img" aria-label="Ambio in {name}" fill="currentColor">{body}</svg>'
        filename = f'integrated-{ident}-{label}.svg'
        (ROOT / filename).write_text(art, encoding='utf-8')
        variants[label] = (art, filename)
        metrics.append({'font': name, 'weight': weight, 'case': label, 'capHeight': cap_height, 'alignmentHeight': alignment_height, 'scale': scale, 'baseline': 108, 'markTop': 20, 'visibleGap': gap})
    lower, caps = variants['lower'], variants['caps']
    cards.append(f'<article><header><div><span>{category}</span><h2>{name} <small>{weight}</small></h2></div><b>0{len(cards)+1}</b></header><div class="sample lower">{lower[0]}</div><div class="sample caps">{caps[0]}</div><div class="reverse">{lower[0]}</div><p>{note}</p><div class="small">{lower[0]}<span>Actual display height: 32px</span></div><nav><a href="{lower[1]}">Lowercase SVG</a><a href="{caps[1]}">Caps SVG</a></nav></article>')
(ROOT / 'integrated-wordmark-metrics.json').write_text(json.dumps(metrics, indent=2), encoding='utf-8')
(ROOT / 'integrated-wordmarks.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ambio / Integrated A studies</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#244b45;font-family:'Segoe UI',sans-serif}main{max-width:1440px;margin:auto;padding:36px 48px}.mast{display:flex;justify-content:space-between;padding-bottom:18px;border-bottom:1px solid #ccd4ca}.mast b{font-size:23px;font-weight:500}.mast span,header span{font-size:11px;letter-spacing:1px;text-transform:uppercase}h1{font-size:32px;font-weight:400;letter-spacing:-.6px;margin:22px 0 8px}.intro{font-size:14px;color:#62736a;max-width:950px;line-height:1.6;margin-bottom:25px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}article{padding:23px 28px;background:#eceee7}header{display:flex;justify-content:space-between;align-items:center}header span{color:#62736a}header b{font-size:12px;font-weight:400;color:#62736a}h2{font-size:20px;font-weight:500;margin:6px 0 0}h2 small{font-size:12px;font-weight:400;color:#62736a}.sample{display:flex;align-items:center;justify-content:center;height:109px}.sample svg{width:auto;height:100px;max-width:100%}.caps{height:90px}.caps svg{height:77px}.reverse{background:#244b45;color:#f5f3ed;padding:14px;display:flex;justify-content:center;align-items:center}.reverse svg{height:63px;width:auto;max-width:100%}p{font-size:12px;line-height:1.5;color:#62736a;margin:14px 0}.small{display:flex;align-items:center;justify-content:space-between;border-top:1px solid #ccd4ca;padding-top:12px}.small svg{height:32px;width:auto}.small span{font-size:10px;color:#62736a}nav{display:flex;gap:22px;margin-top:15px}a{font-size:11px;color:inherit;text-underline-offset:4px}footer{font-size:11px;line-height:1.6;color:#62736a;margin-top:20px}@media(max-width:800px){main{padding:24px}.grid{grid-template-columns:1fr}.sample svg{height:80px}.mast span{max-width:160px;text-align:right}}
</style><main><div class="mast"><b>ambio</b><span>Integrated A / typography studies</span></div><h1>The mark becomes the first letter.</h1><p class="intro">Same finished Open Arch geometry in every study. The crown aligns to the lowercase ascender or capital H; the feet sit on the font baseline. Letter spacing is set from the actual outlines. Each row shows lowercase continuation, capitals, reversal and a smaller reproduction.</p><div class="grid">''' + ''.join(cards) + '''</div><footer>All lettering converted to vector outlines; no font loading or substitution. Typeface names identify the sources; these are proposed custom wordmarks, not changes to the app's UI font. Sources and licenses are saved in fonts/. Selected logo geometry is unchanged.</footer></main></html>''', encoding='utf-8')
print('Built 8 outlined SVG wordmarks and integrated-wordmarks.html')

