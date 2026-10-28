# Canvas component budget after consolidation — 2026-10-20

Started from remote main `1f59e44`, including the Git branch/worktree feature
merge; rebased onto remote main `995f20c` before final integration checks.
Branch: `codex/canvas-scene-scale`. First phase-2 slice of the approved
[scalability plan](../CANVAS_SCALABILITY_PLAN.md); worker layout, progressive
data and the batched overview decision remain open.

Next implementation and measured limits: [canonical scene and background preparation](CANVAS_CANONICAL_WORKER.md).

## Findings and implementation

The previous profile identified hidden React components, rather than visible
DOM alone, as the dominant 100k adoption failure. Passing all nodes to React
Flow with `onlyRenderVisibleElements=false` creates a NodeWrapper per ID even
when each hidden wrapper returns null. The upstream minimap independently
creates another subscribed wrapper per ID. Its bounds selector also scans the
whole lookup on camera updates. A small DOM count was insufficient evidence
that work was bounded.

- Enable React Flow's component visibility culler above the existing 40-node
  threshold. Keep its complete node collection and canonical internal geometry:
  Fit, search, selection, nesting and drop controllers retain their data.
  During an existing layout glide, retain the previous rendering path until
  its 500 ms phase finishes so final-position culling cannot cut off moving
  cards. Initial mount has no prior layout and does not enter that phase.
  Large layout transitions therefore remain an explicit unbounded case for the
  later scene-controller work; the measured wrapper bounds apply after settling.
- Replace the passive minimap with one surface subscription, memoized absolute
  geometry and SVG marks only for admitted nodes. Retain its presentation,
  aspect ratio, mask, colors, dimensions and accessibility label. This is not
  the proposed Canvas2D/WebGL overview renderer or a complete renderer migration.
- Preserve spatial record identities when selection or live chrome changes but
  geometry does not. Eliminate full-scene JSON signatures and duplicate initial
  worker submissions. Compute retention membership per spatial revision.
- Reuse the visibility projection cache and unchanged node arrays. Release its
  contents when switching to a scene below the culling threshold. Full-array
  scans still remain; this is not bounded canonical scene materialization.
- Make the investigative full-geometry mutation tracer opt-in through
  `window.__ambioSceneDebug = true`. A 100k CPU profile attributed 616 ms of
  self time to `diffScene`; the follow-up profile records no `diffScene` samples.
  Scene-integrity checks and recovery remain active. The ordinary E2E suite
  verifies tracing is absent by default and still records when explicitly enabled.
- Keep checkout marks on compact file cards. The new checkout model already
  preserves unchanged per-node derived values; it does not repack the Floor on
  every unchanged poll. Remove repeated array copying while building arrivals
  and compute branch tints once per overlay projection. The daemon currently
  caps each checkout's response at 400 files, so this was preventative work,
  rather than the measured dominant renderer bottleneck.
- Stabilize React Flow defaults and callback identities. An inline
  `fitViewOptions` object overwrote a queued search fit during a live render:
  the Kohler reproduction selected its target but fitted the whole neighborhood
  without the intended duration. A bounded camera-intent trace confirmed the
  missing 850 ms options; stable defaults fix it. The ordinary navigation and
  fallback tests inject a live update into the queued fit and assert its duration.
- Clip very long static dashed routes before SVG strokes them. A million-unit
  path with a ten-unit dash period can demand about 100,000 dash segments;
  142 hub relationships create millions of offscreen segments. The failed
  reproduction's main-thread CPU sample was mostly idle, while making the lines
  solid in a diagnostic control removed the stall. `ClippedDashedEdge` and
  `clippedEdgeGeometry` retain only viewport segments plus a stroke/marker buffer,
  preserve canonical arc distance for dash phase, and keep arrowheads only at
  real targets. Short routes avoid camera rerenders. Source geometry, labels,
  picking and mutation paths retain their existing ownership.

## Preservation checks and a regression caught during implementation

React Flow's exact culler releases offscreen endpoint DOM but keeps initialized
handle geometry. The planned-sheet regression now places one endpoint inside
the actual viewport and verifies that its path remains valid after the distant
endpoint unmounts. Its old fixture asserted a path whose entire bounding box
was outside the viewport; that did not prove visible relationship correctness.
Hub measurements explicitly frame the common endpoint and require every hub
path. Fully offscreen chain paths can be culled, with actual path counts retained.

Tighter culling exposed an authoring regression: a focused inline draft was lost
when zoom moved its node offscreen. React suppresses synthetic blur during node
deletion. Titles, editable symbol names and UML fields now share a layout cleanup
that invokes their latest normal save callback before removing a focused input.
The native reproduction verifies the compact checkout badge, Escape cancellation,
the node actually unmounting after wheel zoom, and exactly one rename request
containing the final draft. Unmounting never creates a new mutation path.

Raster parity is checked in Electron at 0.02, 0.5, 1, 2 and 100 zoom, for ordinary
and non-scaling stroke styles and routes that leave/re-enter the viewport. The
test compares actual pixels with the original uncut path using React Flow's
HTML camera transform. An SVG-internal transform alone would give the wrong
dash-phase convention for this camera; clipping keeps the phase in path units.

The ordinary performance suite now traverses the current React tree to count
actual NodeWrapper and upstream minimap wrapper components, using their props
rather than minified function names. It requires nonzero canvas wrapper counts,
preserves the canonical node count, and bounds wrappers against actual DOM.
This is test-only inspection; a React/React Flow upgrade must keep the detector
valid. A detector that returns zero cannot silently pass.

## Measurement interpretation

Measurements use the same Windows laptop, Electron production build, 1400×900
viewport and deterministic fixtures as the earlier baseline. Browser/refresh,
fixture hashes and build fingerprints are retained with the results. Timings
are local observations on a shared development machine, not a controlled
release runner. Keep the slow repetitions. Stage timings are inclusive and
cannot be added together. CPU-instrumented runs are separate from native timing.

Renderer endpoints are mocked, including the retained Kohler snapshot. This does
not measure app launch, real indexing, live daemon loading or multi-repo capacity.
Cold-to-target includes scripted search, intentional camera travel and settling.
Seven wrappers in a focused viewport does not imply seven at arbitrary density
or in a full-project overview. A visible high-degree hub may still initialize
many endpoint shells together before culling releases them.

## Next limiting stages

1. React Flow still holds every canonical node and scans that lookup for
   visibility. Selection, semantic projection and viewport adoption still walk
   full arrays. Move canonical geometry behind the planned scene controller,
   then materialize the viewport, required ancestors and active interaction
   overlays while migrating every Fit/navigation/drop consumer together.
   The post-consolidation 100k CPU profile records about 1.4 seconds in
   `adoptUserNodes` and 1.2 seconds in garbage collection across its short run.
   With the diagnostic gate, these still lead the active named costs (about
   598 ms and 505 ms in the follow-up). Different profile durations and shared
   machine load prevent interpreting their ratio as a measured speedup.
2. Numeric packing and full snapshot decoding remain synchronous. Continue the
   pure geometry extraction, cancellable worker ownership and versioned results;
   moving packing alone does not solve full-model adoption or JSON parsing.
3. Dense relationships still initialize handle shells and draw individual SVG
   paths. The planned renderer comparison must derive anchors from canonical
   geometry and measure visible density, text, picking and editing parity.
4. The new checkout API polls every five seconds and, with several roots, reads
   all focused files and rebuilds ownership for other checkouts. Content reads
   occur before response truncation. This backend path needs its own real-data
   benchmark/cache design; it is recorded as `git-checkout-poll-scale` in WORK.

No always-smooth, kernel-scale or memory-plateau acceptance claim is made by this
slice. The parent phase-2 item remains open.

## Retained observations

Data: [canvas-component-budget-2026-10-20.json](canvas-component-budget-2026-10-20.json).
This retains failed and intermediate captures as well as the validated slices.
The ordinary saved fixtures have the same local neighborhood at all three sizes.
Zero upstream minimap wrappers were measured in every completed component check.

| Scene | Canonical nodes / node wrappers | Warm frame p95 / p99 ms | Selection p95 ms |
| --- | ---: | ---: | ---: |
| Kohler focused Floor replay | 218 / 23 | 16.7 / 25.1 | 34.3 |
| Saved 1k, final diagnostic gate | 1,000 / 7 | 8.5 / 8.6 | 15.1 |
| Saved 10k, final diagnostic gate | 10,000 / 7 | 8.5 / 8.6 | 22.7 |
| Saved 100k, final diagnostic gate | 100,000 / 7 | 58.4 / 166.6 | 262.0 |
| 1k hub, 142 actual dashed relationships | 1,000 / 7 | 25.0 / 41.4 | 51.1 |

The 100k case now completes interaction instead of failing adoption, but remains
far outside the target. The hub previously timed out before its first selection;
with clipped dashes it completes 20 cycles and verifies all 142 paths, while
still missing the frame/input budgets. Neither improvement establishes capacity.
These final saved-scene runs use 20 cycles each, without CPU instrumentation.
Before the diagnostic gate, the latest 100k repetition recorded 158.3 ms warm
p95 and 904 ms selection p95. Intermediate 10k repetitions range from 8.5–33.4 ms
warm p95 and 33.7–143.3 ms selection p95. Retain that variability; a fast
individual run is not acceptance or a universal speedup claim. The final 1k/10k
cases meet frame/input gates only for this focused fixed-density workload;
memory and arbitrary overview density are not accepted by those runs.

The 50-cycle 10k soak records 15.0% unforced-GC heap growth, while sampled process
private memory decreases about 19.9%. It fails the provisional 10% heap gate;
this does not establish a leak or a retained-memory plateau. Whole-process and
worker memory remain part of the later acceptance work. The focused Kohler case
does not replace measurement of actual sheets, review, flights or real startup.

The broader retained Kohler wheel sweep on integrated main measures Floor p95
25.1 ms (maximum 224.9 ms), and its actual sheet p95 33.3 ms (maximum 66.7 ms).
Neither repacks layout during the wheel sequence. These wider interactions are
still outside the 16.7 ms frame target; the focused Floor row is not an overall
Kohler acceptance result. Both use mocked endpoint replay, not live daemon loading.
After the diagnostic gate, the repetition measures Floor p95 16.7 ms (maximum 141.7 ms) and sheet
p95 25.0 ms (maximum 41.7 ms). The initial Floor camera differs between runs,
so these are observations rather than a controlled paired speedup. The sheet
starts at the same camera; it still misses the frame target. Retained JSON
includes both wheel sweeps and fixture hashes.

## Integration validation

On `995f20c`: TypeScript, production build and all 728 renderer/shared/Electron/MCP
unit tests pass (seven skips). The full UI run records 81 passing, five failing
and five skipped cases. Every failure passes after targeted reruns and fixture
repairs: two tests assumed a fitted-away node remained clickable, geometry/Undo
checks now wait for the real camera queue to settle, and the existing Windows
settings startup flake passes alone. The dialog selection test also avoids a
disabled language badge that consumes clicks. Assertions were retained rather
than relaxing geometry tolerances. The complete suite has not been rerun after
these fixture repairs; do not report the full run as green.

Native focused checks cover navigation supersession and worker fallback, queued
850 ms fit options under a live update, compact checkout badges, Escape/save on
focused editor culling, offscreen endpoint path retention, existing Floor pixels,
and clipped/original dashed pixel parity across five zoom levels. Real-daemon
authoring reruns pass using this worktree's built daemon. No Go source changed.
