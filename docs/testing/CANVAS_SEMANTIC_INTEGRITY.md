# Semantic indexing and Floor integrity preparation — 2026-10-26

Subsequent work: [the measured cold-input follow-up](CANVAS_COLD_INPUT_WIN.md)
finds the remaining synchronous consumer burst and demonstrates a repeated
native latency improvement. The original failed checkpoint below is preserved.

Continues phase 2 of the [performance handoff](CANVAS_PERFORMANCE_HANDOFF.md)
from main `c42de0d`, on `codex/review-pan-audit`. The parent cold-adoption gate
remains open. This checkpoint bounds additional work and preserves validation;
it does **not** demonstrate a consistent end-to-end speedup.

## Measured cause and implementation

A fresh production Electron CPU profile of the saved 100k-entity fixture showed
about 125 ms of sampled inclusive time under synchronous `applyZoomVisibility`
over the workflow, plus about 37 ms in the scene inspector's adoption/update
path. These are diagnostic samples, not uninterrupted frame durations.

Semantic preparation yielded during geometry scans, but its complete depth
sort still ran atomically. Selection/activity stamps retained canonical geometry
indexes but dropped the semantic index, forcing reconstruction even when geometry,
hidden state and detail flags had not changed. Floor preparation finished
canonical indexes before publication, then adoption synchronously rebuilt the
integrity ID set and repeated membership, root and geometry checks.

`sceneSteps.ts` now supplies a stable cooperative sort: at most 256 entries in
one native sort, then merges which checkpoint every 256 output entries. Semantic
indexing reads each depth once and skips sorting already depth-ordered nodes.
Threshold sorting uses the same bounded routine. Reveal thresholds, stable
tie order and node render order stay unchanged.

The existing authoritative integrity check now has a cooperative preparation
form. Floor preparation runs it against the independently supplied canonical
model membership before publication. Only a completed audit is cached, keyed
by the exact immutable node array; count and canonical membership identity must
also match at adoption. Validation is not against a set derived only from the
candidate itself. Invalid candidates retain the existing rejection/recovery path.

The trusted presentation-stamp boundary carries both caches through selection
and activity. Ordinary geometry, ordering, membership or semantic visibility
edits do not inherit validation and retain the full/incremental audit. Review
and sheet-specific transforms keep their ordinary audit paths. Weak cache values
hold indexes/results, not earlier node arrays or scenes. Cancellation never
publishes a partial audit; current-input/scope guards still prevent stale scenes
or generated positions from publishing. `scene.integrity-preparation` records
the new stage in opt-in diagnostics.

All changes remain inside the existing Architecture Canvas boundary, with no
renderer replacement, daemon contract, storage change or new system.

## Native results, including failed gates

Windows desktop, Ryzen 9 9900X, Electron 31.7.7 / Chromium 126, 1400×900,
device scale approximately 1. Idle rAF intervals measured about 4.2 ms; this
does not certify a physical display refresh rate. Production saved-layout 100k
synthetic metadata, fixed sparse view, two navigation cycles. Mocked endpoints,
not the actual Ambio self-map. Timing runs were serial and separate from CPU
profiling and unit/build work. Other user applications remained open.

| Native pair | Cold input p95 | Largest cold frame | Complete scene readiness |
| --- | --- | --- | --- |
| Exact main baseline | 59.3 / 42.3 ms | 66.8 / 70.8 ms | 1.923 / 1.977 s |
| Semantic-index changes alone | 68.7 / 46.7 ms | 66.7 / 66.8 ms | 2.048 / 2.007 s |
| Combined changes before equivalent sort syntax cleanup | 38.8 / 75.7 ms | 70.9 / 71.0 ms | 2.074 / 2.053 s |
| Final delivery build | **71.3 / 74.7 ms** | 70.8 / 75.1 ms | 1.932 / 2.044 s |

Cold input here means pointer dispatch to two animation-frame opportunities,
not confirmed compositor paint completion.

The final pair **fails** the <=50 ms cold-input target. Keep the slower results;
the earlier passing repetition does not establish acceptance. Only 14–16 cold
probes exist per repetition, making p95 equal to the maximum in these samples.
There is no consistent cold-readiness win, and final input observations are
slower than the baseline pair. Do not attribute that difference entirely to the
implementation or dismiss it as proved host noise; it remains unresolved.

Warm frame p95 stays around 4.3 ms. The 100k canonical scene still exposes seven
Flow/DOM nodes at the measured endpoint. Two cycles do not establish selection
tails or memory plateau; those gates are deliberately null. This is not dense
overview acceptance.

The final separate CPU profile samples about 86 ms under synchronous
`applyZoomVisibility`, versus about 125 ms initially. Audit work appears in its
cooperative generator, about 11 ms sampled CPU; native stage observations include
about 39–41 ms of yielded wall time. Profiling locates work, rather than proving
a reliable percentage speedup or completed input budget. All eight native runs,
build/fixture fingerprints, hardware, counts, targets and separate diagnostic
summaries are retained in [curated evidence](canvas-semantic-integrity-2026-10-26.json).
Raw profiles/logs stay in ignored `out/`.

## Validation

- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run test:renderer`: **766 passed, 12 skipped**, zero failures.
- `npm.cmd run build`: passed, including MCP/adapters/agent and Electron/Vite.
- **11 focused UI checks passed**: Floor/sheet/proposal/navigation/fallback
  work bounds; superseded workspace; worker failure/Retry; failed-save recovery;
  empty workspace; development replay with worker and fallback.
- **9 preservation UI checks passed**: Floor screenshot; ordinary/extreme route
  rasterization; proposal review; resize; click/deselection/lasso; drag/save;
  reparenting batch; sheet culling/measurement; wheel zoom through 100x.
- All eight native scale processes and both profile runs passed their
  correctness checks. A passed process is not performance acceptance.

New deterministic regressions cover stable sort ties/checkpoint work, reverse
depth, interrupted indexing, selection/activity index reuse, changed model
membership, invalid geometry/roots, audit cancellation and old-scene collection
through all three caches. An initial collection test held its own completed
generator in a local variable; scoping that helper correctly removed the
test-owned reference. The corrected collection checks pass.

Full Go/MCP/chat runtime suites and the broad full-app UI suite were not rerun;
their runtime sources are unchanged. Existing Undo screen-position and Floor pan
startup issues stay tracked separately.

## Next work

Keep `canvas-cold-layout-worker` open. Remaining synchronous work includes model
membership construction, selection/search consumers, semantic threshold-crossing
projection, and some full-model delivery/store consumers. Ordinary camera-driven
threshold crossings still synchronously drain the visibility generator. Address
their publication/cancellation path with geometry-edit and navigation parity;
chunked sorting alone cannot solve every zoom frame.

Investigate final cold-input tails with stage-correlated input/browser traces
and larger samples before claiming a gain or closing the gate. Retain failed
controls. Progressive model loading and the batched-overview comparison remain
separate phases of the approved plan.

Reproduce after building: set `AMBIO_SCALE=1`, `AMBIO_SCALE_SIZES=100000`,
`AMBIO_SCALE_CYCLES=2`, and a unique `AMBIO_SCALE_RUN`, then run
`npx.cmd playwright test tests/e2e/canvas-scale.spec.ts --repeat-each=2 --workers=1`.
Use `AMBIO_SCALE_PROFILE=1` only in a separate diagnostic run. Baseline and
intermediate run names are preserved in the evidence file.
