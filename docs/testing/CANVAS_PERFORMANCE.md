# Canvas performance audits

## Kohler follow-up — 2026-10-20

Branch: `codex/canvas-performance`. Production Electron 31 renderer, native
Windows, 1400 × 900 viewport. Read-only SQLite access captured Kohler's current
81-system / 143-file inventory and 218 saved layout rows into temporary fixtures.
Indexed documentation/unplaced files are filtered by the ordinary canvas path.
The live database, project and sheet were never edited. The Ambio MCP connector
was unavailable (first no running app, then missing-token errors), so its
investigation recorder could not be used; the existing isolated Electron harness
and CDP CPU profiles supplied runtime evidence instead.

### Largest contributors

1. **Lost sheet measurements defeat viewport culling.** Sheet projection created
   controlled nodes without carrying React Flow's `measured` field forward;
   dimension notifications were discarded outside a resize. React Flow's
   `parseHandles` clears `handleBounds` on such a node, and `getNodesInside`
   force-includes uninitialized nodes even outside the viewport. Every subsequent
   sheet update therefore mounted off-screen subtrees again. An instrumented
   pre-fix workload mounted 10,832 wrappers, with some nodes mounted 112 times.
   Retaining dimensions in a separate presentation map brought this to about
   310 mounts (at most four for any node over two in/out cycles). They never
   enter persisted layout or freeze a drag snapshot.
2. **Sheet layout and object churn.** `composedNodes` depended on `rfNodes` and
   selection, rerunning frame layout, virtual model construction, symbol metadata
   generation and callback creation. Sheet geometry/callbacks are now cached
   independently. Presentation merges retain untouched node/data identities and
   measured dimensions. Camera movement only updates visibility; layout edits
   still rebuild geometry. Structural E2E checks forbid layout builds from a
   settled wheel/selection update.
3. **Whole-scene selection replacement.** `stampSelection` cloned every object,
   even for a repeated selection. It now changes only nodes whose selected bit
   changes and returns the same array for a no-op. This affects canvas clicks,
   search and reply chips as well as sheets.
4. **Semantic zoom repeated structural work.** Every easing frame sorted by
   depth and built ancestry/id maps, even between reveal thresholds. A weak
   cache carries the parent-first order and sorted geometry/detail thresholds
   across visibility-only results. Between thresholds it performs a binary
   search and returns the input; immutable geometry/measurement edits invalidate
   it. Thresholds, ordering, pointer anchoring and easing remain unchanged.
5. **Navigation races and diagnostic reads.** Search assumed a card would be
   measured after 50 ms; multiple chip requests could queue older delayed fits,
   and a wheel loop could continue during a flight. Search and chips now share
   a measurement-aware, latest-pending-request route that cancels wheel easing
   and scheduled growth fits on its canvas. Cursor hit testing/style reads on
   every pointer move and accidentally enabled bin drag tracing are opt-in.
6. **Large sheets could miss culling altogether.** The culling threshold used
   the underlying Floor's size, excluding planned nodes. It now counts the
   composed scene. A regression covers 180 planned systems over a small Floor.

### Evidence and remaining limits

The reproducible workload sends 96 wheel steps, alternating every 24, followed
by a one-second settle. It records rAF intervals, long tasks, CDP script/layout/
style/task duration, node mounts and canvas/layout counters. Input delivery is
main-thread paced, so a slow run takes longer; cumulative durations are workload
totals, not frame costs. CPU profiles confirm React DOM/style work, mounting,
removal and symbol fetches in the slow sheet case. Frame timings vary with host
load; structural mount/identity checks are the stronger causal evidence.

The baseline sheet was an empty overlay over the real map, which isolates the
sheet path from proposal content. An additional fixture uses the actual sheet's
five elements, two planned relationships and one removal. The proposal case is
a generated review from the same system/file inventory, not a live proposal.

| Workload / metric | Before | Final, two repeated runs |
| --- | ---: | ---: |
| Kohler Floor p95 zoom frame | 58.3 ms | 33.3 / 33.3 ms |
| Kohler empty sheet p95 zoom frame | 208.5 ms | 33.3 / 49.9 ms |
| Sheet main-thread task time | 22.83 s | 6.47 / 8.52 s |
| Sheet script time | 12.21 s | 2.33 / 3.01 s |
| Sheet style recalculation | 4.10 s | 0.44 / 0.51 s |
| Sheet long tasks | 115 | 2 / 4 |
| Sheet mounts, instrumented before measurement fix | 10,832 | 308 / 310 |

The actual Kohler sheet measured p95 33.4 ms, four long tasks and 305 mounts.
Final proposal-review p95 was 41.7 / 66.6 ms versus 33.3 ms in the first baseline;
this pass does **not** establish a proposal-review timing improvement. Review
was already bypassing sheet composition, and its mounting/painting limit remains.
Earlier intermediate Floor runs reached 16.7 ms, but the repeated final results
above are the appropriate ones to report. Even the improved ordinary sheet had
125–158 ms maximum intervals: this is materially better, not an always-smooth
guarantee. The roughly 97% mount reduction is more robust than an FPS claim.

### Before exposing arbitrary depths

The remaining cost is concentrated at reveal/viewport boundaries: React Flow
still mounts whole rich node subtrees synchronously. File cards construct both
compact and opacity-hidden detailed chrome; revealed symbol lists render every
row. Empty symbol responses deliberately aren't cached (to allow indexing to
catch up), so repeatedly mounting symbol-less cards can also repeat requests.
Large proposal reviews keep every semantic level exposed, making this the
closest current stress case for arbitrary-depth visibility. Culling helps, but
many small nodes can still fit inside one screen and produce a huge DOM.

The next work is buffered mounting and lighter detail representations, with
bounded/virtualized symbol rows and measurable limits on mounted detail. Depth
options should change visibility over the same stable scene and retain both
measurements and identities. Keep viewport culling independent of the visibility
policy. Re-run dense, multi-level fixtures, cold navigation and repeated
threshold crossings; track longest stalls as well as p95 against 16.7 ms at
60 Hz (8.3 ms at 120 Hz). The current implementation is not ready to promise
unlimited fully detailed exposure at any depth.

### Reproduce locally

Build first. Ordinary deterministic regressions need no real project:

```powershell
npm run build
npx playwright test tests/e2e/canvas-performance.spec.ts
```

For timings, use `AMBIO_PERF_PROFILE=1`; optionally set `AMBIO_PERF_SNAPSHOT` to
a local CanvasSnapshot JSON, `AMBIO_PERF_SHEET` to a sheet API payload, and
`AMBIO_PERF_SYSTEM_COUNT=96` (without a snapshot) for a 672-node synthetic scene.
No fixture is uploaded or
committed. `AMBIO_PERF_CPU=1` saves CDP profiles under ignored `out/`. Run without
other builds/tests competing for the main thread and repeat comparisons.

## Original audit — 2026-10-13

The Floor and proposed architecture share `AmbioCanvas`. This audit used the
current Kohler snapshot and its 62-system, 127-file proposal, copied into isolated
Electron fixtures. No live proposal or project data was changed. A mapped copy
of that proposal also exercised the same architecture as an authored Floor.
Four copies produced a 756-node stress case. Native Windows Electron runs used
1600 × 1000 viewports and the installed Electron 31 / React Flow 12 stack.

## Method

Each zoom workload dispatched 96 wheel steps at roughly 16 ms intervals,
alternating direction every 24 steps, followed by a one-second settling period.
Measurements included requestAnimationFrame intervals, Chrome long tasks, CDP
script/layout/style/task duration and sampled JavaScript CPU profiles. Two
repeated runs were recorded per configuration. React commit counts cover the
entire renderer root, rather than only node component renders.

The main comparisons used production renderer bundles. The final code was also
checked against the running Vite renderer. CPU profiling adds overhead, so these
are comparative measurements on this host, not a universal FPS guarantee.
Unrelated proposal-review UI changes also landed in the shared working tree
during the audit. The initial comparisons predate that sidebar redesign; later
final-build measurements include it. The cached canvas workload is the same,
but end-to-end frame/commit comparisons do not isolate those UI changes.

## Findings and changes

1. **Canvas-wide inherited zoom property.** `onMove` wrote `--ambio-zoom` on the
   canvas root every frame. That invalidated styles across roughly 6,600 elements
   in the real proposal. Blocking only that write in a diagnostic run reduced
   p95 frame time to about 25 ms and cumulative style time to about 0.05 s.
   The fix tracks mounted activity badges and writes zoom locally; the CSS
   property is non-inheriting. Late arrivals and nested bin cameras are covered.

2. **Proposal zoom rebuilt an unchanged controlled node array.** Review used
   `curr.map(makeFullyVisible)` on each zoom frame. Although node identities
   often survived, the array changed and retriggered scene projections,
   React Flow processing and diagnostic effects. Review visibility is already
   established by layout projection, so camera movement now leaves it alone.

3. **Idle and irrelevant subscriptions.** Empty living/trace overlays subscribed
   to every viewport move. They now mount their camera subscribers only when
   there is content, and active overlays subscribe to zoom alone. Review/bin
   selectors also exclude live-only effects, agent activity and runtime state
   before those channels can cause a render.

4. **Active routes recomputed on zoom.** Living flows rebuilt node indices for
   each endpoint and recreated world-space paths whenever zoom changed. They
   now share one scene index and cache routes separately from pulse size. Trace
   routes similarly remain cached while zoom-dependent callout placement updates.

## Measurements

| Workload / metric | Before | After first optimizations |
| --- | ---: | ---: |
| Real proposal, 189 nodes: p95 zoom frame | 58–67 ms | 25–58 ms |
| Proposal: cumulative style recalculation | 2.27–2.62 s | 0.23–0.39 s |
| Proposal: cumulative JavaScript | 1.07–1.10 s | 0.46–0.81 s |
| Proposal: cumulative main-thread task time | 4.32–4.80 s | 1.67–2.85 s |
| Proposal: renderer-root commits | 622–674 | 215–271 |
| Authored Floor copy: cumulative style recalculation | 0.83–0.89 s | 0.19–0.29 s |
| Authored Floor copy: cumulative main-thread task time | 2.03–2.29 s | 1.56–2.23 s |

These durations cover the complete scripted workload, not a single frame.
The first ordinary proposal retest eliminated its repeated 50+ ms tasks, and
the Vite proposal run also measured p95 around 25 ms without 50+ ms tasks. A
later final-build run measured p95 around 58 ms with some long tasks despite
still showing much less style work and fewer React commits. This variation
means the audit establishes reduced rendering work, not consistently smooth
frames on this host. Floor timing similarly varies around reveal/mount
boundaries; its final run included a 300 ms first-pass outlier. Further work on
mounting/painting is warranted even on medium scenes. These later results are
included instead of reporting only the fastest retests.

## Remaining scale limit

The 756-node proposal still reaches p95 around 92–108 ms while zooming. Its
overview mounts about 26,500 DOM elements. The corresponding collapsed Floor
has only about 52 visible nodes; its warm p95 was around 9 ms, with a large
first-run reveal outlier. Large review is therefore still a separate scaling
problem after the avoidable camera work is removed.

Two experiments were rejected:

- Disabling shadows/filters did not materially fix the large-review spikes.
- Disabling viewport culling reduced some maximum spikes but worsened median
  frames from about 8–16 ms to about 33 ms and increased total task time. Culling
  remains enabled above the existing 40-node threshold.

The next investigation should target buffered visibility, incremental mounts
and compact DOM representations that retain the current silhouettes and editing
behavior. Semantic zoom's per-frame ancestry sorting and unconditional pointer
diagnostic reads are secondary candidates. Avoid changing camera easing,
thresholds, pointer anchoring or reducing visual fidelity without evidence.

## Regression checks

Build first, then run:

```sh
npx tsc --noEmit
npm run build
npx playwright test tests/e2e/canvas-performance.spec.ts
npx playwright test tests/e2e/canvas.spec.ts --grep "autofits|805-file|hidden-node flows|rapid save|reviews the proposed|resize chrome|partial lasso|drags a root|reparenting drop|wheel zoom|utility chrome|placed system stays"
```

The performance tests assert structural invariants instead of machine-dependent
timing limits: no camera property writes on the canvas root; no semantic zoom
pass in review; no review render from unused live-channel updates; correct badge
scaling after late mounts; and independent nested canvases.

The interaction checks cover 100× wheel zoom, resize chrome, selection, drag,
containment persistence, live bursts, hidden flows, proposal edits and large
overview virtualization. The Windows harness creates isolated Roaming/Local
AppData folders and checks fixture identity in the store because the redundant
title-bar project label was intentionally removed.

The full unit run has four existing Windows installer/CLI fixture failures
(610 passed, one skipped); the 50 directly relevant canvas unit checks pass.
The 14 selected interaction/performance checks passed together. A final six-case
rerun passed five cases but once missed a live-flow CSS animation-start event
and encountered a Windows LevelDB lock during teardown; the same final build
passed that flow check in an isolated rerun. This test scheduling/shutdown issue
is recorded separately rather than hidden by automatic retries.
