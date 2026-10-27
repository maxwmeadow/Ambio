# Canvas performance: main merge and device handoff

Updated **2026-10-26**. This is the starting point for resuming the canvas work
on another device. The implementation is a tested checkpoint, not completion
of the scalability plan or an assertion that every interaction is smooth.

Desktop continuation, 2026-10-26: [semantic indexing and integrity preparation](CANVAS_SEMANTIC_INTEGRITY.md)
records the next bounded phase-2 implementation, preservation checks and all
native repetitions. Its final cold-input pair still fails the target; the
parent phases and dense/progressive-data work remain open.

## Delivery scope

Later desktop follow-up: [measured cold-input improvement](CANVAS_COLD_INPUT_WIN.md)
compares five fresh exact-main controls with five updated runs: median per-run
cold-input p95 65.2 to 39.8 ms, with passes improving from 1/5 to 4/5. The retained
52.5 ms miss keeps full acceptance open. The original delivery evidence below
remains unchanged.

The `codex/canvas-cold-adoption` branch consolidates these implementations:

| Commit | Delivered work |
| --- | --- |
| `2e223a7` | Initial-mapping review mouse-pan fix: scoped pointer capture, disabled review connection-handle layout, temporary shadow suspension while panning. |
| `08a9d18` | Background large HTTP snapshot decoding, acknowledged geometry/spatial transfers, cooperative projection/visibility, reduced idle indexes and repair of retained canonical-scene history. |
| `092d190` | Cooperative canonical-index preparation before Floor adoption, safe reuse through selection/activity, removal of idle-overlay scene replacements, lazy persistence lookups and linear review saved-row membership. |

All three belong together. The separate `codex/review-pointer-pan` branch adds
nothing beyond this consolidated history. The work-claim commits and merge of
remote main `0b5071d` are included as well. The merge checkpoint is named
`Merge canvas cold adoption, review panning and performance handoff` in Git.
No dependency, database migration, schema version, daemon endpoint or renderer
library changes are introduced by these three implementations. Branches and
worktrees have not been deleted as part of delivery.

Earlier work is already in main: sheet measurement/identity preservation,
semantic-zoom caching, bounded detail admission and symbol requests, complete
canonical geometry outside React Flow, buffered interaction materialization,
offscreen navigation and automatic Floor/sheet numeric worker preparation.
These implementations are not being rebuilt or claimed as new in this merge.

## What caused the stalls, and what changed

1. **Offscreen and unreadable content still consumed UI work.** Earlier sheet
   projections dropped measurements, defeating React Flow's component culling.
   Geometry, presentation identity and measurements are now preserved separately.
   Silhouette/compact/detail tiers, buffered visibility and bounded detail
   admission avoid mounting rich intermediate cards during navigation flights.
   Canonical bounds remain available for search, Fit, drop and resize even when
   a node is absent from Flow's interaction subset.
2. **Review mouse panning paid for a fully exposed tree.** Hit testing,
   invisible connection handles and decorative filters contributed to spikes.
   Review captures an actual empty-pane mouse pan on its own surface, removes
   its disabled handles from layout and suspends decorative shadows until the
   gesture ends. Node dragging/resizing, Shift selection, touch, approval and
   send-back preserve their normal behavior. The canvas contract records the
   intentional shadow change.
3. **Moving numeric layout to a worker left other large bursts.** Large HTTP
   replies now transfer bytes to a temporary decoding worker and return at most
   512 rows per acknowledged batch. Numeric inputs, prepared geometry and spatial
   uploads also use acknowledged batches. Projection, initial Floor visibility
   and canonical indexes prepare in cooperative tasks with cancellation and
   complete-result publication. Stale workspace/model results cannot publish
   partial scenes or save obsolete generated positions. Small fallbacks stay
   cooperative; large worker failures retain coherent content and offer Retry.
4. **Current lookups retained old complete scenes.** Closure contexts captured
   an earlier scene, keeping its node array and preceding history alive. A
   dedicated lookup object now refers only to its current nodes and stable
   order. Collection tests and repeated navigation confirm the repaired retainer
   path, including through the new weak prepared-scene cache.
5. **Idle features repeated full-scene adoption work.** Inactive overlays no
   longer stamp unset flags to false or replace unchanged arrays. Selection and
   activity-only changes safely reuse prepared canonical indexes. Ordinary
   geometry/visibility edits still reconcile and pass integrity validation.
   Saved scenes skip persistence indexes when no rows need writing; review
   checks saved membership with one set rather than nested scans.

## Measured improvement and its limits

These are Windows reference-laptop observations, using the production Electron
build. Synthetic scale tiers use mocked endpoints. Entity counts are not
production-repository or kernel capacity certifications. Paired cases, hardware,
fixture/build hashes, rejected/intermediate attempts and failed gates are
retained in the linked reports. Cold input means pointer-to-two-frame opportunity,
not verified compositor paint completion. Forced collection is diagnostic and
its frame stalls are not native timing acceptance.

| Scenario | Before | Delivered checkpoint |
| --- | --- | --- |
| Initial-review mouse pan, original paired experiment | p95 41.7–41.8 ms; 6–7 long tasks | p95 16.7 / 16.7 ms; zero long tasks |
| 100k largest cold frame, original staged-loading experiment | 308.2 / 316.9 ms | 91.8 / 83.3 ms at `08a9d18` |
| 100k cold input p95, fresh same-session final-adoption control | 82.8 / 91.8 ms at `08a9d18` | 74.1 / 32.8 ms at `092d190` |
| 100k sparse warm frame p95, final adoption | 9.3 / 8.6 ms in fresh control | 8.5 / 8.5 ms; 100k canonical / 7 Flow / 7 DOM nodes |
| 10k collected heap growth over 50 navigation cycles | 16.6% / 16.7% before retention repair | About 2.3% after repair |
| 100k collected heap growth, final-adoption diagnostic | Historical controls in reports | About 0.42% over 50 cycles |

The experiments in different rows have different baselines and dates. Do not
combine them into an end-to-end speedup percentage. Scheduling/backpressure
can increase readiness time while reducing uninterrupted pauses. The final
same-session 100k readiness observations are 3.46/3.41 s versus 3.22/3.91 s in
the control; there is no consistent total-readiness win.

**Still not accepted:** one final 100k cold-input repeat exceeds the <=50 ms
target; both have cold frames over 100 ms. Complete models still occupy roughly
1.0–1.1 GiB in the recorded 100k cases. An earlier ordinary 100k memory repeat
fails its growth gate while its pair passes. Dense review still mounts 672 nodes
and about 12k DOM elements. Later interaction observations include slow review
and navigation frames despite sparse warm-scale success. No universal memory
plateau, dense-review frame budget, any-depth exposure or cross-platform scale
certification is claimed.

## Validation and known failures

Fresh merge-time type, unit and production build checks pass: **766 unit tests
passed, 7 intentional skips**. All **16 focused canvas UI checks passed**:
Floor/review mouse and WASD panning, Floor/sheet/proposal/navigation/fallback
work bounds, superseded workspace results, worker failure/Retry, failed initial
save recovery, empty-workspace release, development effect replay in worker and
fallback modes, and packaged snapshot decoding/cancellation. This is a focused
recheck, not a new full-app UI or performance-acceptance run.

Source runtime has not changed since the final-adoption evidence. The rebuilt
production HTML fingerprint matches that measured implementation:
`d80065db78eedeed5c9ee1888cf4077e0e9b0702ef4a583b28187e3da5ec4d10`.
The subsequent main merge must preserve this validated source tree.

Previous broad canvas validation: **75/76 UI tests passed**. The Undo/Redo
screen-position check failed once by about 435 px, then passed three isolated
repeats. An exact pre-follow-up `08a9d18` runtime reproduced the same mismatch
(4 pass, 1 fail). It predates `092d190`; its underlying camera/placement/timing
cause remains unresolved. It is tracked as `canvas-undo-screen-position-flake`
in WORK Inbox. Do not label the broad UI suite completely green.

Earlier full-app runs also have three agent-settings selector/wording failures
reproduced on unchanged main `908e488`; these are tracked separately as
`agent-settings-ui-e2e-drift`. The canvas work does not alter those journeys.

The real-daemon integration passes with 512 generated TypeScript files,
32 authored systems, a 471,089-byte snapshot, actual HTTP/WebSocket delivery and
a watched edit reaching the canvas. This is integration evidence, not a pinned
production corpus benchmark. Go/MCP/chat runtime sources are unchanged by this
merge; their full specialized suites were not rerun for this documentation
handoff. Prior and merge-time check scopes must remain distinct.

## Resume in this order

Use the existing WORK items and approved [scalability plan](../CANVAS_SCALABILITY_PLAN.md).
The parent items remain open; the completed slices are in the Done log.

1. **Real-project feedback:** run the [CP1–CP8 checklist](CANVAS_QA_CHECKLIST.md#checkpoint-recheck--2026-10-23)
   on Kohler after pulling main. Check opening/reopening, Floor and sheet zoom,
   initial-review mouse pan, search/chat-file navigation, interrupted flights,
   live updates, resize/reparent/Undo, approval and a longer editing session.
   Record commit, machine, refresh rate, project/view and cold versus warm state.
   Keep manual checks unmarked until a human verifies them.
2. **`canvas-cold-layout-worker`:** profile remaining synchronous integrity,
   canonical-membership/store-consumer work and semantic threshold crossings.
   Remove/bound measured bursts without bypassing integrity or changing authored
   frames. Do not repeat the completed numeric extraction or history-leak fix.
3. **`canvas-progressive-scene-data`:** design versioned summaries and detail
   loading with global search, ordered events, reconnect and canonical editing.
   Full WebSocket snapshots/classification remain atomic and full models remain
   resident. Measure real daemon query/indexing costs before changing contracts.
4. **`canvas-dense-overview-budget`:** compare the current renderer with a
   batched overview and editable overlays before selecting/migrating a renderer.
   Include dense review, high-degree relationships and any-depth exposure,
   visual parity, hit testing, accessibility and editing, not just sparse scenes.
5. **`canvas-scale-acceptance`:** use Kohler, a larger real corpus, then a pinned
   kernel-scale corpus on named hardware. Keep cold/input, warm camera, selection,
   memory and correctness gates separate. Preserve failed cases and verify
   Linux/macOS/Windows explicitly. Resolve the Undo flake as its own tracked item.

## Pick up on the other device

From a clean checkout, switch to `main` and pull it normally:

```text
git switch main
git pull --ff-only origin main
npm ci
npm run dev
```

Use the repository's [setup instructions](../../README.md) for toolchain
requirements. If the other checkout has local changes, preserve them before
switching; do not reset or clean them as part of this handoff. Start new work
from the updated main on a new `codex/` branch/worktree, claim its WORK item and
read the product, architecture, decisions and canvas contract first.

All Markdown reports and curated JSON measurements below are tracked and
travel through Git. Raw CPU/heap/browser traces and test output in ignored
`out/` and `test-results/` stay on the old device. Their presence is not required
to resume: rerun the isolated fixtures when deeper diagnosis needs fresh traces.

## Evidence index and reproduction

- [Original Kohler audit](CANVAS_PERFORMANCE.md)
- [Frame-budget implementation](CANVAS_FRAME_BUDGET.md)
- [Canonical scene/worker implementation](CANVAS_CANONICAL_WORKER.md)
- [Review pan investigation](REVIEW_POINTER_PAN.md) and [curated cases](review-pointer-pan-2026-10-23.json)
- [Cold adoption/retention](CANVAS_COLD_ADOPTION.md) and [curated cases](canvas-cold-adoption-2026-10-23.json)
- [Final adoption](CANVAS_FINAL_ADOPTION.md) and [curated cases](canvas-final-adoption-2026-10-24.json)
- [Open work](../../WORK.md), [architecture](../ARCHITECTURE.md), [canvas contract](../CANVAS_BEHAVIOR_CONTRACT.md)

Standard checks: `npx tsc --noEmit`, `npm run test:renderer`, `npm run build`.
The focused UI suite uses `canvas-scene.spec.ts`, `scene-preparation-dev.spec.ts`,
`snapshot-loading.spec.ts`, `canvas-performance.spec.ts` and `canvas-pan.spec.ts`.
`canvas.spec.ts` holds the broader visual/editing suite and known Undo flake.
`AMBIO_LIVE_SCALE=1` enables `canvas-live-scale.spec.mjs` with a real isolated daemon.

For scale measurements, build first, run serially without concurrent heavy work,
and set `AMBIO_SCALE=1`, `AMBIO_SCALE_SIZES=100000`, `AMBIO_SCALE_CYCLES=2` and a
unique `AMBIO_SCALE_RUN`. Then run `npx playwright test canvas-scale.spec.ts --repeat-each=2`.
Use 50 cycles for memory checks; `AMBIO_SCALE_GC=1` is a separate collection
diagnostic, never native frame certification. Check `performanceAccepted` and
individual gates in the output JSON: a passing test process alone does not mean
the performance budgets passed. Reference build/fixture hashes and the same
camera/view density before comparing results.
