# Canvas frame-budget audit — 2026-10-20

Branch: `codex/canvas-frame-budget`, based on `81834e1` from the first Kohler
performance pass. This implements Max's approved five-part strategy. The Ambio
connector was unavailable, so the plan is recorded in
[CANVAS_FRAME_BUDGET_PLAN.md](CANVAS_FRAME_BUDGET_PLAN.md), not a saved sheet.

## Findings and implementation

1. **Rich trees were paid for before they could be read.** A file's hidden
   symbol/header subtree remained mounted, and sheet authoring callbacks could
   trigger symbol fetches even below detail zoom. `BudgetedNodes` now provides
   silhouette, compact identity and editable detail. Readable system/infra
   identities keep their original components. File detail mounts on admission
   and exits after its 250 ms crossfade. Selected/dragged/live nodes retain full
   interaction, source actions and activity chrome.
2. **Reveal work arrived in one commit.** A per-canvas, per-node subscription
   store admits center-first work in adaptive batches of 1–6 promotions with a
   3 ms scheduler deadline. New detail pauses during camera motion; selection
   and navigation destinations take priority. This bounds admissions, not the
   browser's eventual commit: React/DOM/layout work cannot be preempted by this
   scheduler. Large sets of cheap node wrappers still have a cost.
3. **Exact viewport edges caused churn, and flights rendered intermediate
   content.** A worker-owned spatial index supplies 240 px buffered visibility.
   Recent visibility is retained for 450 ms with a screenful-based cap. Worker
   messages coalesce, responses are scene/request checked, and obsolete camera
   buffers are rejected. Navigation warms its target and symbols while new
   intermediate file cards stay compact. Shared consumers cancel independently;
   a newer navigation cancels its predecessor's prefetch. Worker failure falls
   back to the same spatial rules on the main thread. Fit explicitly includes
   nodes hidden only by viewport culling; semantic descendants remain excluded.
   Visible relationship endpoints retain cheap handle shells outside the buffer,
   so lines into off-screen space remain initialized.
   Visible relationship endpoints retain cheap handle shells outside the buffer,
   so lines into off-screen space remain initialized.
4. **Symbol/data work had no useful upper bound.** Symbol lists now render a
   viewport window with four rows of overscan, retaining focused editors and
   keyboard navigation. HTTP work shares requests, caps concurrency at four,
   prioritizes interaction, invalidates by file revision, caches empty responses
   for two seconds, and caps the LRU at 512 files / 50,000 rows. Ordered socket
   dispatch yields at 3 ms / 24 messages; overflow uses snapshot resync. One
   snapshot/message and JSON parsing remain atomic.
5. **p95 hid cold stalls.** Local diagnostics now record worst camera intervals,
   p95/p99, renderer long frames, mounted detail, admission batches, requests and
   background batches. Camera sampling stops when idle. E2E tests exercise cold
   search, supersession, wheel reversals, full-scene Fit, a 5,000-symbol file and
   worker failure. Nonempty initial content is required, preventing an empty
   canvas from being accepted as a performance improvement.

The final CPU pass found an additional, independent hitch: Toolbar polls sheets
**every five seconds**, and `pruneResolvedLayers` recreated visibility/layer
collections even when no sheet had resolved. That invalidated sheet geometry.
A dense trace spent about 154 ms of sampled CPU in `layoutNode`; a selection
assertion caught another poll landing in its measurement window. Unchanged polls
now preserve those references; actual resolution still removes layers (unit
regression). Layout-transition flags also moved out of geometric projection, so
starting/ending a transition no longer repacks the sheet. The final dense sheet
had **zero layout builds during the zoom workload**, versus one in the first
implementation and four in the branch baseline.

## Measurements

Production Electron 31, Windows, 1400 × 900. Same 96 alternating wheel steps as
the earlier audit, with a one-second settle. Timings are host observations, not
portable pass/fail limits. CPU profiling adds overhead; those runs are labeled.
No live Kohler data was changed. Its temporary inventory and actual sheet were
replayed through isolated, mocked endpoints; symbol/network server latency is
not a live-daemon benchmark. Proposal review is generated from that inventory.

| Workload | Prior branch baseline | Budgeted rendering |
| --- | ---: | ---: |
| Dense 672-node Floor, p95 / worst interval | 8.5 / 3,000 ms | 8.5 / 50 ms |
| Dense sheet, p95 / worst interval | 33.4 / 2,100 ms | 16.7 / 208 ms before poll fix; 16.8 / 66.6 ms after fix, CPU profiling on |
| Dense proposal, p95 / worst interval | 133.3 / 450 ms | 41.5 / 158.6 ms; 49.9 / 158.4 ms with CPU profiling |
| Dense proposal, end-of-workload document DOM | 26,146 elements | 12,186; 11,832 in CPU run |
| Dense proposal, main-thread task total | 14.02 s | 6.08 s; 7.20 s with CPU profiling |
| Dense Floor/sheet wrapper mounts | 576 / 768 | 192 / 192 |
| Dense proposal wrapper mounts | 1,326 | 1,344 (essentially unchanged; wrappers became cheaper) |
| Kohler Floor, p95 | 33.3 ms in previous final audit | 16.7 / 25.1 ms |
| Kohler actual sheet, p95 / worst interval | 33.4 ms / prior sheet range 125–158 ms | p95 16.8 / 41.7 ms; worst 58.3 / 100 ms |
| Kohler generated review, p95 / worst interval | prior final p95 41.7–66.6 ms | p95 25.0 / 41.6 ms; worst 50.1 / 83.4 ms |
| Cold search/supersession/reversals, p95 / worst interval | no equivalent baseline | p95 16.6–16.8 ms; worst 66.7–83.3 ms |

The later Kohler repeat did **not** maintain the earlier 17 ms p95: its actual
sheet reached 41.7 ms. This establishes reduced/bounded work and improved frame
tails, not a consistent additional sheet-p95 win over the previous audit. The
later run's worksheet had zero zoom-triggered layout builds, so remaining work
and host variability still matter. Forced worker-failure navigation peaked at
91.7 ms, also outside a smooth-frame budget.

The dense baseline's Floor ended with unstable materialization; its maximum is
useful evidence of a stall, not a clean steady-state speedup ratio. Final runs
assert initial content and verify Fit restores the full scene. Zooming into
empty world space can correctly leave no on-screen nodes. DOM counts above are
whole-document counts at the end of the workload, not peak DOM or rich-node
counts. The earlier audit's timings and fixtures remain in
[CANVAS_PERFORMANCE.md](CANVAS_PERFORMANCE.md).

A 5,000-symbol destination kept fewer than 32 mounted rows, including after
scrolling to the last symbol and using Home to focus the first. Native runs
observed a maximum of three HTTP requests (the enforced limit is four), at most
six admissions per batch, and five rich nodes at the navigation destination.
Forced worker fallback preserved visibility, navigation and Fit.

Intermediate results that rendered a blank scene were rejected. They exposed
that viewport-hidden nodes had been excluded from camera Fit; the shared Fit
wrapper fixes this rather than accepting deceptively fast empty frames.

## Remaining contributors and next investigations

- **Dense overview DOM and browser commits.** Around 12,000 elements remain in
  the 672-node review. Its 42–50 ms p95 is improved but misses both 60 Hz and
  120 Hz frame budgets. React Flow wrappers/handles, system identities, mounting,
  style and layout still cost time. A hybrid overview renderer (batched canvas
  or GPU silhouettes/relationships, DOM for active editing) is the strongest
  next experiment before arbitrary-depth exposure. It was not implemented in
  this approved iteration.
- **Cold scene preparation is still synchronous.** Initial snapshot/layout
  startup recorded renderer long-frame entries around 300–650 ms before the
  measured wheel workload. Geometry packing, model projection, serialization,
  store selectors and snapshot parsing still run on the main thread. The new
  worker owns spatial indexing/querying, not all of layout. Incremental/cached
  packing or a versioned layout worker is a separate next slice. Local fallback
  also builds/queries its index synchronously and is not a large-scene speed
  guarantee.
- **Admission is a work limit, not a hard real-time renderer.** Immediate live
  signals and user selection bypass background admission; one React commit or
  one socket message can exceed 3 ms. Network latency, initial loading and
  arbitrary-depth scenes still need representative measurements. No result here
  establishes “perfectly smooth always.”

## Validation and reproduction

- TypeScript and production build passed.
- Renderer/shared/Electron/MCP unit suite: 679 passed, one skipped.
- 16 native interaction checks passed, including approved Floor screenshot,
  initial identity, 805-file virtualization, hidden flows, burst resync, review,
  search/reply chips, source actions, resize, selection, drag/reparenting and
  100× wheel behavior. After the final polling/transition changes, all five
  structural performance scenarios passed, eight focused sheet/Fit/authoring
  checks passed, and three relationship/hidden-flow checks passed. The expanded
  planned-sheet regression includes a relationship to an off-screen endpoint.
  Forced worker-constructor failure and cold navigation/reversal checks passed.
- Structural performance checks enforce no root zoom-style writes, stable sheet
  layout on zoom/selection, no review live-channel churn, correct nested badge
  scaling, detail/request limits and complete Fit recovery. Machine-dependent
  frame tails are reported rather than used as flaky CI thresholds.

```powershell
npx tsc --noEmit
npm run test:renderer
npm run build
$env:AMBIO_PERF_PROFILE='1'
$env:AMBIO_PERF_SYSTEM_COUNT='96'
npx playwright test tests/e2e/canvas-performance.spec.ts
# Optional CPU profiles under out/ (adds overhead):
$env:AMBIO_PERF_CPU='1'
npx playwright test tests/e2e/canvas-performance.spec.ts --grep 'sheet zoom|proposal zoom'
```

Kohler fixture profiling additionally sets `AMBIO_PERF_SNAPSHOT` and
`AMBIO_PERF_SHEET` to the temporary, read-only captures. They are not committed.
Raw measurements/profiles are under ignored `out/frame-budget-*.log` and
`out/canvas-perf-*.cpuprofile` in this worktree.
