# Dense Review frame cost — 2026-10-26–27

Implementation: `040d89c` and `068158d` on `codex/review-pan-audit`.
Control: exact renderer `25d2599`, the preceding cold-input checkpoint.
This improves the existing Architecture Canvas presentation without introducing
a renderer adapter or changing its resting artwork, geometry or edit policy.

## Measured result

Five fresh serial runs per input/build, 256 systems plus six files per system,
production Electron on the same desktop. Values below are medians of per-run
measurements, except the explicitly labelled largest intervals:

| Measurement | Previous build | Updated build |
| --- | ---: | ---: |
| Mouse frame p95 | 29.2 ms | **16.7 ms** |
| Mouse frame p99 | 33.4 ms | **20.9 ms** |
| Mouse largest interval across runs | 46.0 ms | **33.5 ms** |
| Mouse runs passing both frame gates | 0 / 5 | **5 / 5** |
| Mouse script duration over the scripted gesture | 1,224 ms | **448 ms** |
| WASD frame p95 | 37.6 ms | **29.3 ms** |
| WASD largest interval across runs | 58.5 ms | **33.5 ms** |
| WASD script duration over the scripted gesture | 437 ms | **166 ms** |
| WASD runs passing both frame gates | 0 / 5 | **0 / 5** |
| Mouse endpoint document elements | 15,515 | **8,935** |
| Mounted nodes at endpoint | 828 | **828** |
| Mounted connection handles | 6,624 | **0** |

Mouse p95 is **42.8% lower**, and mouse script work is **63.4% lower** for the
same 97 observed camera moves and scripted trajectory. The document-element
median is about **42% lower**. The canonical model remains **1,792 entities**;
this fixture reaches the existing 0.02 zoom floor, so it is not an all-1,792-node
onscreen test. Endpoint counts and fixture fingerprints agree across builds.

The mouse p95 values are 29.2/29.2/29.2/29.2/29.2 ms before and
16.8/16.7/16.7/16.8/16.7 ms after. The recorded gate is p95 <=16.7 ms and
p99 <=33.3 ms with an explicit **0.1 ms timestamp/scheduling tolerance**.
All five updated mouse runs pass, as does a separate run with the gate enforced
as a test assertion. This is a reference-machine result, not a physical-display
refresh-rate certification.

WASD p95 improves from 37.6/37.6/41.8/37.6/37.6 to
29.2/29.2/33.3/29.3/29.3 ms, but **still fails the p95 target in every run**.
There is no full dense-rendering acceptance claim. Its fixed-duration key holds
produce 23–25 observed moves before and 32 after: the existing WASD speed is
per frame, so the improved build traverses a different distance during those
holds. Mouse and WASD are separate before/after cases, not matched trajectories.
The WASD percentages must not be treated as an isolated fixed-workload speedup.

The 96-system / 672-mounted-node check uses three fresh runs per input/build:

| Median per-run frame p95 | Previous | Updated |
| --- | ---: | ---: |
| Mouse | 16.6 ms | **12.5 ms** |
| WASD | 25.1 ms | **25.0 ms** |

One smaller-scene mouse control already reaches 12.6 ms; these distributions
overlap, so do not infer a universal 25% improvement at this density. WASD frame
timing is effectively unchanged there despite much less script work. Its
largest interval also rises from 29.2 to 33.3 ms; that result is retained.

## Cause and implementation

The previous CSS fix kept disabled Review connection handles out of browser
layout/hit testing. It still mounted **eight React Flow Handle components per
node**. Their external-store selectors executed on camera updates even when
no React component needed to rerender. A zero AmbioCanvas render count therefore
did not mean zero per-node state-consumer work.

The correlated browser/CPU control shows significant time in React Flow's
external-store snapshot selectors, shallow comparisons and connection selectors,
fed by viewport updates and node-internals measurements. That supports the
measured reduction after removing these inactive components.

Review now stamps `omitConnectionHandles` on its presentation data. Full system,
file and infrastructure nodes, plus compact budget tiers, omit those handles.
The flag is independent of `isConnectable`: disabled Floor/sheet endpoints still
mount for existing relationships and their measured geometry. Selection,
promotion, node dragging, resizing and proposal decisions retain their paths.
No daemon model or persisted layout field was added.

WASD previously called `document.elementFromPoint` in every camera frame to
resolve ownership. The document already receives browser pointer-move/boundary
events, so ownership now follows their target and related target. This avoids
the explicit synchronous hit test after viewport transforms and still follows
overlapping/nested surfaces. A browser test verifies that an overlay inserted
under a stationary pointer stops the underlying camera, removing it resumes
that camera, and typing in an input does not pan it.

The handle-only exploratory mouse runs already measure 16.7 ms p95. The
pointer-event change reduces WASD script work further, from about 212–219 ms
to 162–176 ms in the exploratory runs, without a clear independent frame-p95
win. The final comparison covers the combined implementation, not an attributed
percentage for each change.

All final runs retain zero AmbioCanvas renders and semantic-visibility passes
during these gestures, no geometry preparation post and no layout save. Browser
style, hit-testing, paint and compositing work remains. In the diagnostic mouse
trace, inclusive FunctionCall spans fall from about 1,427 to 500 ms, while
Layerize spans stay about 554 versus 540 ms. These are nested/threaded diagnostic
sums, not additive wall time. WASD performs more moves after the change, so its
larger aggregate rendering spans are not a fixed-workload comparison.

## Experiments rejected

- Promoting the entire viewport with `will-change: transform` worsens the
  256-system probe to 58.4 ms mouse / 66.7 ms WASD p95.
- Per-node layout/style containment stays around 29.4 / 41.7 ms on the control.
- Removing all shadows in the handle-only WASD probe reaches about 25 ms, still
  above budget and with an intentional artwork difference.
- A translated silhouette-shadow prototype reaches 25–29 ms WASD while adding
  DOM. It was reverted. No new shadow implementation or motion appearance ships.

These probes are retained separately from adopted-build native results. The
measurements favor fixing inactive components before a renderer migration;
they do not close the planned batched-overview prototype/adoption decision.

## Controls, evidence and limitations

[Curated evidence](dense-review-frame-cost-2026-10-26.json) retains **69 measured
cases**: 57 uninstrumented adopted/control cases, eight rejected experiments
and four instrumented recordings. It also records one original control startup
failure before measurement. Raw logs, timelines and CPU profiles remain under
ignored `out/`. Failed targets remain false in the evidence.

The initial 96-system control attempt used an immediate hidden-handle assertion
and failed once before recording a measurement. Restoring the pre-existing
asynchronous polling for that legacy control check gives six passing recheck
cases. The original failure and its other five measurements are retained in a
separate cohort, rather than folded into the successful control summary.

Control renderer HTML SHA-256:
`3a8cd578e853290d487d94154e8fb7cab7fa753f249b9ad5f1bbc5707a0cd0a1`.
Updated renderer HTML SHA-256:
`134e5424be913eb42fafe04ec3cb5155755847b477183ef0d76d008b98fcaeaa`.
Both builds used the same input loop and frame sampler; the legacy flag changes
only the pre-measurement endpoint-presence assertion for the control. Later
harness refinements restore polling in that legacy startup check and add GPU
metadata to diagnostic runs without changing the native measurement loop.

Windows, Ryzen 9 9900X, 1400×900, approximately unit device scale, Electron
31.7.7 / Chromium 126. The app's existing E2E mode conventionally renders a
window positioned off the desktop using `showInactive()`. rAF intervals and
Playwright-dispatched events are not physical input-to-display measurements.
Mouse events are awaited with a requested 8 ms pause; backpressure changes their
delivery rate. The sampler includes the gesture and 250 ms settling period.

The diagnostic records Electron GPU feature flags and basic adapter metadata.
Compositing is reported enabled, while basic info lists an in-process GPU,
`gl=none,angle=none` and no active adapter. Physical hardware includes an RTX
5070 Ti and integrated Radeon graphics; these fields do not establish which
physical rendering path serviced the test. `GPUTask` sums are not presented as
physical GPU timing. Real on-screen/device acceptance remains necessary.

Production controls and updated native measurements ran serially without
concurrent build/test jobs; other user applications remained open. The updated
source was committed before temporarily rebuilding the old renderer in this
isolated worktree, then restored and rebuilt. This is a same-session block
comparison, not randomized AB testing. The Ambio connector is bound to the main
checkout and rejects this worktree as a run directory, so runtime measurements
were executed directly with Playwright/CDP and summarized in the investigation.

To reproduce, build and run serially with `AMBIO_PAN_SYSTEMS=256` (or `96`):

```powershell
npx.cmd playwright test tests/e2e/canvas-pan.spec.ts --grep 'review (mouse|wasd)' --repeat-each=5 --workers=1
```

Use `AMBIO_PAN_ENFORCE_FRAMES=1` to enforce both recorded frame gates; WASD is
expected to fail its current gate. For exact old-source controls only, set
`AMBIO_PAN_LEGACY_HANDLES=1`. Optional `AMBIO_PAN_TIMELINE=1` /
`AMBIO_PAN_CPU=1` are diagnostic runs, excluded from native summaries.
`AMBIO_PAN_STYLE` is a reported diagnostic-only CSS probe, not a product option.

## Preservation and remaining work

- TypeScript and the complete production build pass; the restored build matches
  the final measured fingerprint.
- Unit/renderer/shared/adapter suite: **768 passed, 12 skipped**.
- **13 focused UI/work-bound checks pass**: Floor screenshot, route rasterization
  at ordinary/extreme zoom, pointer ownership, proposal approval/edit/resize,
  resize chrome, root drag, reparenting, Floor dependency drawing, and the five
  Floor/sheet/proposal/navigation/fallback work-bound scenarios.
- Review tests assert zero mounted endpoints before and after promotion/editing;
  Floor pan checks retain endpoint-presence assertions. All 16 final native
  dense cases pass their correctness checks. A separate large mouse run passes
  with both frame gates enforced.
- Navigation/fallback work-bound checks still retain long frame tails. They
  test correctness/work bounds, not universal latency acceptance. Go, daemon
  schema, MCP and chat runtime layers are unchanged.

Mouse panning now meets the recorded reference frame gate at these densities.
WASD frame p95, matched/time-based input paths, batched-overview comparison,
high-polling physical input, relationship-heavy/nested real maps, long-session
memory and platform/device acceptance remain open. Existing shadows are still
present during WASD; artwork and input behavior were preserved rather than
using the rejected shadow probes as an acceptance shortcut.
