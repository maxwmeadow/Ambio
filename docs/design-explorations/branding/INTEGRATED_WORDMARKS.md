# Integrated Open Arch wordmarks

Review `integrated-wordmarks.html` for four typeface pairings in lowercase and
capitals, reversed and at a smaller display size. Each downloadable SVG includes
outlined lettering: no installed font, remote CSS, or font-loading dependency.

The approved Open Arch path is unchanged. Its visible bounds are x=17–111,
y=20–108. Alignment uses the actual glyph outlines, not a padded SVG element:

- Feet are at the font baseline, y=108.
- Capitals use the H outline height. Lowercase uses the b ascender height;
  this matters for Plex, whose ascender exceeds its cap height.
- Font scale is 88 / alignment height. Round glyph overshoot is retained.
- A-to-m/M spacing is measured between visible outlines, then adjusted per
  pairing. It is not the spacing for a standalone icon plus a full wordmark.
- Font kerning is applied to the trailing letters. No letter is stretched.

Sources:

- IBM Plex Sans Bold 700: existing `@fontsource/ibm-plex-sans` package.
- [Space Grotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk), 700.
- [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope), 800.
- [Outfit](https://github.com/google/fonts/tree/main/ofl/outfit), 750.

Downloaded variable fonts and their OFL licenses are in `fonts/`. Outfit 750
is an instance of the variable font, rather than a named static weight.

Rebuild with `python docs/design-explorations/branding/build-integrated-wordmarks.py`
(requires fontTools). Font sources are downloaded only if missing. Geometry and
placement measurements are saved in `integrated-wordmark-metrics.json`.

These are proposed display wordmarks, not a replacement for Study A or the app's
UI typography. Manrope lowercase and Outfit lowercase are the leading candidates
from this pass; final selection and optical refinements remain open.
