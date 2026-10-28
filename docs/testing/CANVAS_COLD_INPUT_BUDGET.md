# Cold-input budget confirmation — 2026-10-26

Implementation: `e3d8100` and `ef40b92` on `codex/review-pan-audit`, following the
[measured cold-input improvement](CANVAS_COLD_INPUT_WIN.md).
The unchanged **<=50 ms cold-input target passes in all ten final native
100k runs**, plus all ten earlier confirmation runs and five exploratory runs. This closes the remaining miss
for this repeated sparse benchmark, not the complete scalability plan.

## Results

Ten fresh serial runs per build on the same desktop, production Electron,
identical saved-layout fixture, camera, input script and 50 ms threshold:

| Metric | Previous build | Updated build |
| --- | ---: | ---: |
| Runs passing cold-input p95 <=50 ms | 7 / 10 | **10 / 10** |
| Worst per-run cold-input p95 | 55.8 ms | **44.5 ms** |
| Median per-run cold-input p95 | 44.45 ms | **40.00 ms** |
| Median complete-scene readiness | 2.021 s | 1.988 s |
| Median warm-frame p95 | 4.3 ms | 4.3 ms |
| Largest cold frame | 58.5 ms | 66.8 ms |

The observed worst input is **20.3% lower**, with **5.5 ms headroom** under the
target. The median is **10.0% lower**. Readiness is effectively unchanged at this
sample size. The largest cold-frame result did not improve: meeting the input
gate is not a claim that every cold frame now takes less than 50 ms.

Per-run cold-input p95, in repeat order:

- Previous: 39.4, 40.9, 42.2, **55.8**, **53.2**, 46.5, 42.1, 44.4, 44.5, **53.4** ms.
- Updated final confirmation: 40.3, 41.5, 44.2, 39.8, 40.2, 38.3, 39.6, 38.7, 44.5, 38.1 ms.
- Earlier updated confirmation: 42.1, 38.7, 42.0, 40.3, 42.7, 40.6, 40.9, 41.0, 41.6, 35.6 ms.
- Earlier updated exploration: 40.9, 40.2, 40.5, 39.8, 41.9 ms.

All 35 native records, including every control failure, are retained in
[the evidence file](canvas-cold-input-budget-2026-10-26.json). There are 151
cold probes in the control cohort, 149 in final confirmation, 150 in the earlier
confirmation and 74 in exploration.
Each run has 14–16 probes, so its nearest-rank p95 is its largest observation.
These are observed results, not confidence bounds or a universal latency guarantee.

## Cause and implementation

The historical 52.5 ms miss arrived at the renderer in 0.6 ms but waited for
subsequent frame opportunities. The corresponding cold store/React update in
a separate correlated browser/CPU trace still took 47.716 ms. Sampled work
included canonical membership construction, root-layout filtering and App's
complete source/authorship calculation. This path left too little frame slack.

The fix stays inside existing renderer responsibilities:

- `App` decides whether architecture has been authored from system sources
  alone. It no longer classifies the complete file population or counts
  homeless files just to ask whether any authored system exists. The setup
  screen still counts source files when it is actually displayed, caching that
  count until the file population changes.
- Floor placement creates its loose-file membership index on the first query
  that cannot be answered by a shown system. Fully classified maps skip the
  root-layout scan entirely. Loose-file queries share one exact index per
  immutable layout revision; replacing layouts invalidates both positive and
  negative results. Hand-placed root files and withheld-system rules remain.
- Canonical membership is populated directly, avoiding intermediate ID arrays
  and spreads. It remains an independent, exact model Set for scene validation;
  it is not inferred from candidate geometry and still deduplicates IDs.

The updated diagnostic cold React task takes **43.33 ms**. CPU samples show
that canonical membership is still substantial work; this patch does not claim
to eliminate every linear consumer. This diagnostic preceded the setup-only count caching refinement in `ef40b92`;
it is not a trace of the final renderer. These are separate instrumented examples,
excluded from native results. The comparison measures the combined fix and
does not isolate each optimization's contribution.

## Controls and reproduction

The previous renderer is exact `05ebf98`, equivalent to implementation
`7ca84dd`, with fingerprint
`5ff26a5993e6c37aec4fb46769a90155e25f2c9d4a84801cc877396f8f6a9970`.
The updated renderer fingerprint is
`3a8cd578e853290d487d94154e8fb7cab7fa753f249b9ad5f1bbc5707a0cd0a1`.

The updated source was committed before temporarily rebuilding previous
renderer sources in this isolated worktree. Ten controls ran, then the committed
implementation was restored, rebuilt and confirmed ten times. The setup count
cache refinement was then committed and rebuilt for ten more final runs. All cohorts
used the same harness, with CPU/timeline capture disabled. No build/test jobs
ran concurrently with native timing. Other user applications remained open.
This was a same-session block comparison, not randomized AB testing. The five
exploratory updated runs, first confirmation cohort and separate diagnostic
are also retained, including the first-confirmation renderer fingerprint
`6de26a5b487ceb260f1af5c806b40cb32e3c679898718972994dfdf0ff6eef3e`.

Windows / Ryzen 9 9900X, Electron 31.7.7 / Chromium 126, 1400×900, device scale
approximately 1. Idle rAF scheduling is about 4.2 ms; no physical-refresh claim
is inferred. The fixture keeps 100k canonical entities and seven endpoint
Flow/DOM nodes. It tests cold loading of a sparse view, not dense Review or
the user's actual Ambio self-map. Input means pointer dispatch to two animation
frame opportunities, not verified compositor paint.

Build, set `AMBIO_SCALE=1`, `AMBIO_SCALE_SIZES=100000`, `AMBIO_SCALE_CYCLES=2`
and a unique `AMBIO_SCALE_RUN`, then run:

```powershell
npx.cmd playwright test tests/e2e/canvas-scale.spec.ts --repeat-each=10 --workers=1
```

Keep `AMBIO_SCALE_TIMELINE` and `AMBIO_SCALE_PROFILE` unset for native timing;
use them only in separate diagnostics. Read each report's
`targets.coldInputPaint`: the harness records timing failures separately from
its correctness assertions. Raw reports and profiles remain in ignored `out/`.
The Ambio connector is bound to the main checkout, so these worktree runs were
executed directly, not represented as connector-observed runtime runs.

## Verification and remaining work

- TypeScript and production build pass.
- Unit/renderer/shared/adapter suite: **768 passed, 12 skipped**, no failures.
- **Nine focused UI checks pass**: Floor screenshot, 805-file initial overview,
  documentation library, blank/codebase agent setup, proposal review, root-node
  dragging, container reparenting and both Review Changes workflows. Setup was
  repeated after the final caching refinement; types/build also passed again.
- A deterministic placement test verifies zero layout reads for files in shown
  systems, one shared scan for loose queries, correct exclusion of nested files
  and system rows, and invalidation after layout replacement.
- All 35 scale runs pass correctness assertions. Short two-cycle runs leave
  selection and memory acceptance unset, so `performanceAccepted` stays false.
  Go, MCP and chat runtime layers are unchanged.

The repeated sparse cold-input target is met. Keep the broader cold-adoption
item open for threshold-crossing/full-model work and broader acceptance.
Dense Review rendering, real-project/manual checks, progressive data, memory
and platform acceptance remain open; the cold-frame tail above is retained.
