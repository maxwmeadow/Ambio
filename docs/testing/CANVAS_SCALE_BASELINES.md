# Canvas scale baselines — 2026-10-20

Branch: `codex/canvas-frame-budget`. First implementation slice of the approved
[scalability plan](../CANVAS_SCALABILITY_PLAN.md). This establishes measurement
and fixes an initial visibility burst; it does not implement the geometry worker,
overview renderer, or progressive snapshot protocol.

## Reference and interpretation

Production Electron 31.7.7 / Chromium 126, Windows 11 (10.0.26200), Intel
i7-13700H, 20 logical processors, approximately 16 GB RAM, 1400 × 900 viewport,
device scale 1. Measured median display interval approximately 8.3 ms (120 Hz).
Acceptance is evaluated against the plan's nominal 60 Hz targets: warm frame
p95 ≤ 16.7 ms and p99 ≤ 33.3 ms, with 0.25 ms scheduling tolerance; selection
feedback p95 ≤ 50 ms. These runs do not certify 120 Hz operation.

The deterministic suite separates cold preparation, search travel, and warm
zoom/selection. Search includes the existing intentional 850 ms fit animation;
the reported time to target also includes scripted settling and is not a pure
layout duration. Input feedback is dispatch to a selected class followed by two
animation-frame opportunities. Generic pointer input uses dispatch to two frame
opportunities; neither is a compositor presentation timestamp. CPU profiles add
overhead and are kept separate from native acceptance runs.

The same eight local systems and six files per system are retained while distant
metadata grows to 1k/10k/100k total entities. Four root identities exercise IDs,
not multi-repository product behavior. Saved geometry isolates scene size from
initial force packing; unsaved, nested and relationship cases vary that workload.
Endpoints are mocked: these tests measure renderer adoption and JSON decoding,
not live indexing or daemon/network latency. Every completed case must find,
center and select a real target. A camera between distant roots can initially
show empty space; two frames alone never constitute a successful case.
The renderer is already running with the standard E2E demo before applying the
fixture. This measures snapshot replacement/preparation, not application launch
or a cold OS/disk cache; those opening targets remain unverified.

Timing runs use one isolated Electron application at a time. Sampled private
memory sums Electron's main/GPU/utility/renderer processes in KiB; worker memory
is included in renderer process memory, not separately attributed. A 2 GiB
private-memory guard exits only the isolated test application. Sampling is not
an exact allocation peak. JavaScript heap plateau uses medians from cycles 6–10
and the final five, without forced GC, and is accepted only after ≥50 cycles.
It is a short repeated-view soak, not proof of an unlimited navigation cache.
The final gate requires both page heap and aggregate sampled private memory to
stay within 10%; platforms without private-memory metrics leave it unverified.

## Findings

- **Hidden DOM is insufficient.** Both saved 1k and 10k cases sampled only seven
  node wrappers / 450 document elements at the destination. Yet 10k selection
  feedback rose to 111–207 ms p95 and warm frame p99 to 92–117 ms. Full scene
  bookkeeping still scales with total project size even when DOM is bounded.
- **Initial visibility had an avoidable burst.** Before the first worker reply,
  every root was eligible to mount. Bootstrap now intersects root geometry with
  the buffered viewport; selected/active nodes and relationship endpoints keep
  their existing priority. Canonical scene and authored geometry are unchanged.
- **Packing is only one part of cold adoption.** At 100k, geometry takes roughly
  300 ms including floor projection, but a renderer frame can block for roughly
  32 seconds. A separate CPU profile sampled 27.5 of 36.1 seconds in React's
  host-sibling lookup during placement (the bundled production function `Uj`).
  React Flow's `onlyRenderVisibleElements=false` creates a `NodeWrapper` React
  component and store subscription for every ID, even when `hidden` makes that
  component return no DOM. The minimap independently does the same for every ID.
  Consequently seven DOM nodes can conceal hundreds of thousands of React
  components/subscriptions. The 10k profile also samples store selector/shallow
  comparison work, including minimap subscribers, during repeated interaction.
  Moving only the packing function would leave that larger cost.
  The next scene/renderer boundary must bound React components and subscriptions,
  not just DOM. Simply enabling the library's exact-viewport culler would also
  change buffered retention and off-screen relationship-handle behavior, so it
  needs the existing navigation/edge/fit parity checks before adoption.
- **The monolithic data path also grows.** The separate real SQLite benchmark
  returns 100k file rows in about 400 ms; JSON adds about 55 ms and a 31.3 MB
  response before systems, layouts, relationships or symbols. Progressive reads
  remain necessary; that benchmark does not measure source indexing/clustering.

## Native saved-scene results

Two independent 20-cycle runs per completed tier, same production build and
fixture hashes. Ranges retain the slower run instead of averaging it away.

| Entities | Cold to two frame opportunities | Warm frame p95 / p99 | Selection feedback p95 | Sampled private memory | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 124–125 ms | 8.5 / 8.6 ms | 19.5–25.4 ms | 738–741 MiB | Warm frame/input targets pass; 20 cycles cannot verify memory |
| 10,000 | 1,112–1,222 ms | 16.9–49.9 / 91.6–116.6 ms | 111.3–206.7 ms | 900–912 MiB | Frame tails and input fail |
| 100,000 | >30 s materialization deadline | Unavailable | Unavailable | 1,229 MiB sampled | Failed tier; no capacity claim |

The first 1k 50-cycle soak (`reference-soak`) sampled warm p95/p99 8.5/8.6 ms,
selection p95 17.8 ms, and JavaScript heap ratio 0.985 (final versus warmed
baseline). Its initial heap-only gate passed. The final stricter soak
(`validated-soak`) also records aggregate process-memory growth and uses
`AMBIO_SCALE_ENFORCE=1`: warm p95/p99 8.5/8.6 ms and selection p95 15.3 ms passed,
but unforced JavaScript heap grew 16.4%, exceeding the 10% provisional budget.
Sampled process private memory fell 19.2%. Enforcement correctly failed. These
short runs do not establish a leak, nor a reliable memory plateau; GC/retention
needs a longer follow-up. Search/navigation still had a 74.9 ms worst frame.
Even this case does not justify “always smooth.”
Both 1k and 10k destination scenes had seven wrappers and 450 document elements.
The suite's sampling interval can miss shorter DOM peaks.

Real database benchmark (`-benchtime=1x`, synthetic unplaced files only):

| File rows | SQLite snapshot query | JSON encoding | JSON bytes | Query / JSON allocated bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 3.6 ms | 0.7 ms | 306,774 | 1.19 / 1.42 MB |
| 10,000 | 36.0 ms | 5.6 ms | 3,096,774 | 15.68 / 11.50 MB |
| 100,000 | 400.2 ms | 54.9 ms | 31,266,774 | 173.37 / 98.38 MB |

These single-iteration database measurements are orientation, not a statistically
stable service SLO. The renderer's saved-scene fixtures additionally contain
systems and layout rows; their payloads are not comparable to these file-only
payloads. Query/JSON allocation totals are not simultaneous process RSS.

Other native renderer cases (20 cycles requested; the hub failed before its
first selection cycle completed):

| Case | Warm frame p95 / p99 | Selection p95 | Cold / navigation worst frames | Result |
| --- | ---: | ---: | ---: | --- |
| Captured Kohler Floor, two runs | 16.4–16.7 / 16.9–25.0 ms | 26.9–36.7 ms | 33.5 / 199.9 ms | Warm targets pass, navigation stalls remain |
| 1k unsaved geometry | 8.5 / 16.6 ms | 35.4 ms | 358.3 / 83.3 ms | Warm targets pass, cold stall remains |
| 1k entities, 20-level nesting | 33.4 / 75.1 ms | 99.4 ms | 33.4 / 100.1 ms | Frame/input targets fail |
| 1k entities, 142 rendered hub relationships | Unavailable | Selection timed out | Camera maximum 7,226 ms | Failed interaction tier; no warm acceptance |

The Kohler capture contains 143 files / 81 systems (224 snapshot entities;
218 renderable after existing source filtering), and sampled 43 wrappers /
1,132 document elements. This focused root-flight/wheel/selection case is less
demanding than the earlier actual-sheet/review workload; its warm result does
not supersede the earlier 17–42 ms sheet p95. Nesting increased the destination
to 72 wrappers / 2,496 elements, showing a second density limit independent of
total metadata. Unsaved, depth and hub measurements are single exploratory runs.
The corrected hub run proved 142 paths (including valid first/last paths), then
retained 149 wrappers for endpoint geometry and failed its selection timeout.
Sampled private memory reached 1,061 MiB. Its approximately 7.2 s camera stall
was far larger than numeric geometry (two builds, maximum 4.8 ms); the long
SVG paths, animation/paint and retained endpoint shells need separate renderer
profiling. This is an adversarial million-unit separation, not a typical Kohler
layout, and it has no valid completed warm/input percentiles.

Initial deep/Kohler collection attempts clicked a container's obscured center;
the corrected harness clicks its exposed corner and proves selection. Invalid
attempts are retained locally but excluded from these performance results.
Floor dependencies do not become persistent React Flow paths. The corrected
`edges`/`hub` harness opens a sheet containing those relationships and requires
every expected path, including valid first/last paths, before timing selection.
The earlier metadata-only hub result is excluded from the committed baseline.

## What remains after this slice

The next worker/renderer slice must stop creating hidden React wrappers and
subscriptions for the full scene. Keep canonical geometry separate from the
materialized interaction tree, including parent chains and off-screen edge
anchors. Preserve buffered culling, complete Fit bounds, selection/navigation,
and both human and agent edits. Numeric packing can then move to the versioned
worker without concealing UI adoption cost. Existing visibility responses also
scan all source records, and scene signatures serialize all records; those
must become scene-revision/incremental work rather than camera/input work.

The existing [frame-budget audit](CANVAS_FRAME_BUDGET.md) remains the evidence
for actual-sheet, proposal, reply-pill, interruption, fallback, drag/resize and
extreme zoom behavior. This new size sweep does not replace that coverage.
Indexing/clustering, a larger real production corpus, kernel-scale data,
cross-platform/lower-powered hardware, 1m entities and exhaustive visible-density
sweeps remain unverified. They belong to the later data/acceptance phases.

## Reproduction and retained evidence

Raw local JSON and optional CPU profiles are retained under ignored
`out/canvas-scale/<run>/`, independently of Playwright's rotating `test-results`.
The committed [baseline data](canvas-scale-baseline-2026-10-20.json) retains a
curated comparison with dataset/build hashes and failed targets, without project
content. Invalid collection attempts are excluded; instrumented runs are marked.
Each includes fixture/build SHA-256, host/display metadata, stage samples/totals,
DOM counts, browser task/layout totals, memory, and explicit failed/unverified
targets. Bounded opt-in tracing retains 2,048 samples while preserving aggregate
counts/maxima; timings are inclusive, so nested stages must not be added together.

```powershell
npm run build
$env:AMBIO_SCALE='1'
$env:AMBIO_SCALE_RUN='saved-reference'
$env:AMBIO_SCALE_SIZES='1000,10000,100000'
$env:AMBIO_SCALE_CYCLES='20'
npx playwright test tests/e2e/canvas-scale.spec.ts --repeat-each=2
node scripts/canvas-scale-report.mjs out/canvas-scale/saved-reference

# Separate cases: saved (default), unsaved, deep (20 levels), edges, hub.
$env:AMBIO_SCALE_SHAPE='deep'
$env:AMBIO_SCALE_SIZES='1000'
npx playwright test tests/e2e/canvas-scale.spec.ts

# At least 50 cycles are required to verify the memory target.
$env:AMBIO_SCALE_SHAPE='saved'
$env:AMBIO_SCALE_CYCLES='50'
npx playwright test tests/e2e/canvas-scale.spec.ts

# Optional CPU investigation, never mix with native timing acceptance:
$env:AMBIO_SCALE_PROFILE='1'
npx playwright test tests/e2e/canvas-scale.spec.ts
Remove-Item Env:AMBIO_SCALE_PROFILE

# Real SQLite query/JSON benchmark, from archd-go/:
go test ./internal/db -run '^$' -bench BenchmarkCanvasSnapshotScale -benchtime=1x -count=1
```

`AMBIO_PERF_SNAPSHOT` replays a captured Floor snapshot; the existing
`canvas-performance.spec.ts` also supports an actual sheet through
`AMBIO_PERF_SHEET`. Captured project data is not committed. `AMBIO_SCALE_ENFORCE=1`
requires every target to be verified and pass; normal collection deliberately
retains measurements when a target fails. “Test passed” means collection and
interaction assertions succeeded, not that the performance budgets passed.

## Validation

- TypeScript, standalone scale harness/fixture type checks and production build
  passed. Renderer/shared/Electron/MCP units: 684 passed, one skipped.
- Go vet and tests for `internal/db` passed; the real database benchmark ran all
  three tiers. No daemon API/storage/schema changes were introduced.
- Eighteen native interaction/structural checks passed, including all five
  existing performance scenarios, approved Floor screenshot, search/reply
  navigation, selection, resize, drag/reparenting, hidden flows, burst resync,
  planned-sheet off-screen relationship and 100× wheel behavior.
- Size/depth measurements intentionally retain budget failures. The 100k native
  and instrumented cases failed their preparation deadline. The enforced final
  soak failed its heap-growth target; the rendered hub failed selection. These
  are product acceptance failures,
  not passing scalability claims.

## Consolidation checkpoint

Integrated main through `7edd954`, including proposed sheet renames and native
ChatGPT integration. The canvas conflict retains cached geometry/presentation
and adds rename data to the geometry memo's dependencies. Changelog and work-list
conflicts retain both branches' entries. No further performance implementation
was started for this checkpoint; the remaining scalability phases stay open.

Integration checks: TypeScript, production build, 699 unit tests (one skipped),
full Go vet/tests and 36 MCP end-to-end tests passed. Fourteen native canvas
checks passed after the rename merge; eight focused native checks passed again
after the newer main integration, including all five performance scenarios,
the approved Floor screenshot, proposed move/rename placement and reply chips.
These are correctness/structural checks, not renewed large-scale acceptance.
The baseline timings above retain their original renderer build fingerprints.

Use this checkout's locked dependencies for validation. A preliminary run using
the primary checkout's shared `node_modules` could not open Electron: installed
`jose` 6 differed from the lockfile's Electron-compatible `jose` 5.10.0. A clean
local `npm ci` restored the locked versions and the focused native checks passed.
The primary checkout and its uncommitted work were not modified.
