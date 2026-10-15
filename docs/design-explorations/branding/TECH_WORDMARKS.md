# Typography-led revision

The tapered b/i/o studies were rejected. They forced the symbol's silhouette
onto letters and lost typographic clarity. Keep them only as exploration history.
Use `tech-wordmarks.html` for the current review.

Reference pages reviewed visually and through their published material:

- [Anthropic](https://www.anthropic.com/): wordmark in the site header.
- [Linear](https://linear.app/brand): restrained logotype and monochrome guidance.
- [Vercel / Geist](https://vercel.com/font): geometric typography foundation.

Our design inference from these references is to let one distinctive glyph carry
identity while the remaining letters maintain a consistent reading rhythm. None
of their marks is reproduced in the Ambio artwork.

Three alternatives use Geist 740, Manrope 780 and Space Grotesk 700 as their
foundations. b/o and the i stem are preserved typeface outlines. In 02 (Manrope),
the i dot is circular, retaining the original centre with a diameter 1.12 times
the stem width for optical balance; Max preferred everything else about this direction. The earlier
square-dot export is preserved as `tech-manrope-square-dot.svg`.
The m is a custom, symmetric
glyph whose two shoulders and two counters are mirrored. Its stem width is
measured from the companion i, and its height from the font's x-height. The A's
original path is unchanged; it shares the font's baseline and b ascender height.
Round-letter overshoot is preserved. Gaps are set between visible outlines.

All nine exports are self-contained SVGs, in currentColor, teal or reversed ivory.
`build-tech-wordmarks.py` reproduces them with fontTools. Sources and OFL licenses
are in `fonts/`; measurements are in `tech-wordmark-metrics.json`.

Max approved direction 02 with the proportional circular i dot for production
on 2026-10-08. Canonical assets and usage are documented in `docs/BRANDING.md`.
