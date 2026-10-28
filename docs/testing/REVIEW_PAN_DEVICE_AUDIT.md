# Review pan follow-up on the desktop — 2026-10-26

## Finding

The desktop checkout is still at **`0b5071d`**. Fetching origin confirmed remote
main **`c42de0d`**, the merged performance delivery. Both the desktop source and
its built renderer omit the Review pointer-capture and pan-shadow fix. The
running Electron app launches from that desktop checkout. This is strong
evidence of a delivery/version mismatch; the already-open renderer's URL and
loaded JavaScript were not inspected directly.

A same-device isolated control reproduces the reported direction: mouse pan
is slower than WASD in the local build. Running the delivered build improves
that mouse case substantially. Dense Review remains a separate open limit.
This audit does not certify the user's live Ambio self-map or resolve the
broader scalability items.

## What was reviewed

- [Consolidated handoff](CANVAS_PERFORMANCE_HANDOFF.md), including its explicit
  remaining dense-view, memory, cold-input and real-project acceptance limits.
- [Previous mouse-pan investigation](REVIEW_POINTER_PAN.md) and the canonical,
  cold-adoption and final-adoption reports referenced by the handoff.
- The initial-mapping review adapter, shared canvas camera/projection paths,
  render-budget wrappers, shadow CSS, WASD implementation and installed XYFlow
  pan implementation. This concerns proposal approval/send-back, not Review Changes.
- The existing native `canvas-pan.spec.ts` harness and its fixture/measurement
  assumptions. Production renderer sources were not changed by this audit.

The remote merge contains the initial Review pan fix (`2e223a7`), staged cold
adoption/retention repair (`08a9d18`) and cooperative canonical-index adoption
(`092d190`). The old preparation effect-replay hang is already a separate fix;
it does not explain an otherwise prepared scene stalling during warm panning.

## Current-device measurements

Windows, Ryzen 9 9900X, Electron 31.7.7 / Chromium 126, 1400×900, device scale
approximately 1. Serial production-build tests; no concurrent build/profile
workload. Other user applications remained open. The delivered renderer HTML
fingerprint matches the handoff exactly:
`d80065db78eedeed5c9ee1888cf4077e0e9b0702ef4a583b28187e3da5ec4d10`.
The local built control fingerprint is
`6d4ae1cce6845d2d8d0f1337cb6bd19da99443fcd6d22547b4bd5144eee70fa8`.

| Native Review case | Mounted nodes at endpoint | Frame p95 | Frame p99 | Largest interval | Long tasks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Local built control, 96 systems, mouse | 672 | 37.4 ms | 46.0 ms | 58.4 ms | 2 |
| Local built control, 96 systems, WASD | 672 | 29.1 ms | 33.4 ms | 33.4 ms | 0 |
| Delivered, 96 systems, mouse, first run | 672 | 16.6 ms | 25.1 ms | 33.5 ms | 0 |
| Delivered, 96 systems, mouse, second run | 672 | 16.6 ms | 25.1 ms | 37.5 ms | 0 |
| Delivered, 96 systems, WASD, first / second | 672 | 29.2 / 25.1 ms | 29.3 / 25.2 ms | 29.3 / 25.2 ms | 0 / 0 |
| Delivered, 256 systems, mouse | 828 | 29.2 ms | 33.4 ms | 45.9 ms | 0 |
| Delivered, 256 systems, WASD | 828 | 41.7 ms | 54.3 ms | 54.3 ms | 1 |

The 96-system fixture contains six files per system: 672 entities and about
12,100 DOM elements. The 256-system fixture has 1,792 canonical entities but
only 828 mounted at the endpoint, about 15,500–15,700 DOM elements. Its camera
reaches the 0.02 zoom floor; do not describe it as all 1,792 nodes remaining
onscreen or as a pure fixed-density comparison.

Every measured Review gesture reported zero canvas renders and zero semantic
visibility passes; the checks also assert no numeric geometry post and no layout
save during the gesture. Worker query maxima were 0.2–0.5 ms in these native
cases. These observations rule out repeated numeric preparation and canvas
projection as the cause of these particular warm-pan tails. They do not rule
out those costs during concurrent indexing, layout edits or proposal updates.

Raw curated cases and browser diagnostic summaries:
[current-device measurements](review-pan-device-audit-2026-10-26.json).
The first run's summary above was retained from command output; the JSON includes
the logged second 96-system run, larger case and local control.

## Why mouse and WASD differ

`ProposalReviewCanvas` feeds the real `AmbioCanvas`. Its review projection uses
`makeFullyVisible` for every node instead of normal semantic child hiding.
Viewport culling and detail tiers still apply, but a fitted overview can leave
hundreds of separate editable wrappers and SVG shapes visible together.
Zooming in reduces that simultaneous browser workload.

Mouse pane dragging follows XYFlow/D3 mouse events. Before the delivered fix,
the browser repeatedly hit-tests the exposed tree, including disabled transparent
handles, while compositing filtered SVG shadows. WASD uses a requestAnimationFrame
loop to set the viewport, without a new physical pointer target at each step.
The WASD ownership check does call `elementFromPoint` each frame, so it is not
free of hit testing. Mouse and keyboard also have different event pacing.

The delivered fix captures an actual Review pane mouse pan, removes disabled
Review handles from layout and suspends shadows while the pane is dragging.
It preserves node drag/resize and Shift selection. Shadows remain enabled for
WASD, helping explain why keyboard panning can become slower than mouse on
the delivered build. This reverses the old mouse disadvantage without removing
the underlying dense browser workload.

Separate traced mouse runs corroborate that mechanism:

| Inclusive browser spans | Local built control | Delivered |
| --- | ---: | ---: |
| HitTest | 309 spans / 1,207 ms | 110 spans / 147 ms |
| Layerize | 896 ms | 426 ms |
| GPUTask | 2,172 ms | 671 ms |

These are diagnostic sums across threads and nested spans, not additive wall
time or native acceptance timings. They support browser hit/compositing costs;
they do not independently apportion the benefit among the three changes.

## Limits in the current tests

1. The pan test records timing but **does not assert a frame/input performance
   budget**. A passing test proves gesture/correctness checks, not smoothness.
2. Mouse positions are awaited and spaced by a requested 8 ms. Backpressure can
   slow the script; it does not represent high-polling physical input. WASD uses
   four 200 ms holds. Durations and trajectories are not matched, and sampled
   rAF intervals are not input-to-paint or compositor presentation measurements.
3. The benchmark deliberately starts on empty pane. The capture fix does not
   cover dragging a node, modifiers, touch, or every embedded surface. Node
   dragging has a different hot path: `onNodeDrag` builds parent/selection maps,
   scans drop candidates and can restamp highlighting. An accidental node grab
   in a crowded overview must be distinguished from camera panning before
   attributing a new report to the pane path. This is an unmeasured possibility,
   not a diagnosis of Max's gesture.
4. Six files per system and no dependencies do not reproduce Ambio's actual
   nested proposal, active agent updates, language mix or a long session.
5. On this device the full four-case pan suite was not green: the first run had
   one Floor startup timeout and the second had two, all waiting for the first
   mounted node before Fit. Review cases passed. The Floor startup failure is
   separate from the warm Review measurements and needs its own investigation.

## Next steps

1. Bring the desktop checkout to the delivered merge while preserving its
   unrelated mapping-completion edits, then rebuild and relaunch. Do not hard
   reset or stash an actively edited checkout without coordinating its owner.
   This audit instead used an attached isolated worktree and isolated test homes.
2. Recheck the actual Ambio proposal on that build. Record loaded build,
   canonical/mounted counts, zoom, pointer target, pane-drag/capture state and
   whether updates are arriving. Capture physical-input latency and a browser
   trace if freezes remain. Avoid treating synthetic improvement as human signoff.
3. Continue `canvas-dense-overview-budget`: compare a batched overview with
   editable overlays against the current per-node DOM presentation. Preserve
   identity, selection, resize/drop, accessibility and review decisions. Measure
   the real proposal and visible density before choosing Canvas 2D/WebGL or
   changing boundaries. More numeric worker work alone will not remove the
   measured hit/compositing costs.
4. Establish separate frame/input gates for dense Review and sparse large maps;
   include physical-input-rate stress, matched keyboard/mouse paths, zoom
   transitions and node gestures. Keep the Floor startup failure visible.

## Reproduction and validation scope

At `c42de0d`, build the production app, then run serially:

```powershell
npx.cmd playwright test tests/e2e/canvas-pan.spec.ts --workers=1
$env:AMBIO_PAN_SYSTEMS='256'
npx.cmd playwright test tests/e2e/canvas-pan.spec.ts --grep 'review (mouse|wasd)' --workers=1
Remove-Item Env:AMBIO_PAN_SYSTEMS
$env:AMBIO_PAN_TIMELINE='1'
npx.cmd playwright test tests/e2e/canvas-pan.spec.ts --grep 'review mouse' --workers=1
Remove-Item Env:AMBIO_PAN_TIMELINE
```

The local control used the same harness with the app argument and fingerprint
path pointed at the desktop build. Its capture/shadow expectations were inverted
and the delivered hidden-handle assertion omitted. Those diagnostic copies live
under ignored `out/`; the source test and application were not modified.

Production Electron/Vite compilation passed. Review native cases passed in
both 96-system runs, both larger cases and both local controls. One separate
timeline test per build passed. The Floor startup failures above remain failures.
This documentation-only audit did not rerun full unit/Go/MCP/chat suites.
The Ambio investigation recorded the version check; its workspace restriction
prevented executing the isolated worktree through that recorder, so the actual
Electron measurements used Playwright/CDP directly.
