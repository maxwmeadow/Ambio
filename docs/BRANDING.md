# Ambio branding

Approved by Max on 2026-10-08: Open Arch standalone mark and wordmark direction
02 (Geometric), with a proportional round dot on the i.

## Canonical assets

`src/renderer/assets/branding/` contains the production SVGs:

- `wordmark.svg` — solid teal #244b45.
- `wordmark-reversed.svg` — ivory #f5f3ed for dark backgrounds.
- `mark.svg` / `mark-reversed.svg` — standalone A.

The wordmark incorporates the original A as the initial letter, a symmetric
custom m and lowercase bio derived from Manrope 780. The circular i dot is
centred on its stem and has a diameter of 1.12 times the stem width. All letters
are outlines; no font download or substitution is involved.

Use `AmbioWordmark` from `components/ui/AmbioBrand.tsx` for visual product titles.
Use the standalone A for app icons and tight icon-only contexts. Choose the
reversed asset on dark surfaces. Preserve aspect ratio; do not independently
resize, reposition or colour letters. Keep ordinary mentions of Ambio in copy,
menus and accessible names as text.

The Manrope OFL notice is kept alongside the artwork and included in packaged
Help → Acknowledgements by `scripts/third-party-notices.mjs`. The logo artwork
itself follows the repository license.

## Desktop assets

`resources/branding/` contains an ivory A on a teal tile as PNG, ICO and ICNS,
plus tray PNGs at 1x/2x. macOS uses a black transparent template A so the system
can adapt it to the menu-bar appearance. Other platforms use the teal tile.

Regenerate from the production mark with `npm run brand:icons`. This uses
Playwright with Edge on Windows or installed Chromium on other platforms;
native icon containers are assembled from the rendered PNG representations.
Generated assets are checked in, so normal builds need no browser or font tools.
Electron Builder copies these into `resources/branding` outside asar and uses
the platform icon for packaged applications. The native tray remains present
while the app runs and restores the window on click; background agent presence
and a close-to-tray preference remain separate planned work.

## Verification and exploration history

`docs/design-explorations/branding/tech-wordmarks.html` holds the final comparison.
Production assets are copies of the approved 02 exports, not imports from that
exploration directory. Earlier custom-letter studies were rejected.

`capture-shipped-branding.cjs` checks the built renderer bundle with a fixture
bridge and captures launcher, projects, About and toolbar views.
`native-icon-smoke.cjs` checks image loading and tray creation in Electron.
The full-app Playwright launch was blocked on this Windows host by an Electron
Crashpad startup failure; the built renderer and native tray were verified
separately. macOS/Linux native appearance still needs a platform smoke pass.
