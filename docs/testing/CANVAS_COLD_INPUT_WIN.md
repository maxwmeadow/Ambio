# Measured cold-input improvement — 2026-10-26

Subsequent work: [cold-input budget confirmation](CANVAS_COLD_INPUT_BUDGET.md)
removes the retained miss in ten fresh native repetitions, with all earlier
failures preserved here as historical evidence.

Implementation: `7ca84dd` on `codex/review-pan-audit`, following the
[semantic/integrity checkpoint](CANVAS_SEMANTIC_INTEGRITY.md).
This follow-up demonstrates a cold-input latency improvement over unchanged
main `c42de0d` on the same desktop. It does not close every scalability gate.

## Result

Five fresh serial production Electron runs per build, identical synthetic
100k-entity saved-layout fixture, fixed sparse view and input script:

| Metric | Unchanged main | Updated branch |
| --- | ---: | ---: |
| Median of the five cold-input p95 measurements | 65.2 ms | **39.8 ms** |
| Cold-input p95 per run | 70.4, 49.3, 65.2, 65.8, 54.4 ms | 52.5, 39.3, 39.8, 45.6, 37.7 ms |
| Runs passing <=50 ms | 1 / 5 | **4 / 5** |
| Largest recorded cold frame | 70.8 ms | **58.3 ms** |
| Median complete-scene readiness | 2.053 s | 2.024 s |
| Warm frame p95 | 4.3 ms | 4.3 ms |

The median per-run cold-input p95 is **39% lower**. Total readiness is effectively
unchanged at this repetition count. The 52.5 ms result is a retained failure;
four passing runs do not establish universal <=50 ms acceptance.

Cold input means pointer dispatch to two animation-frame opportunities, not
verified compositor paint completion. Each confirmation run has 14–15 cold
probes, so its p95 is its largest observation. These are observed repeat results,
not statistical confidence bounds or certification for a real project.

## What caused the delay

The prior checkpoint's correlated browser/CPU recording caught an input at
1332.5 ms waiting 72.7 ms behind a React task starting at 1331.1 ms and lasting
73.25 ms. Sampled work inside that task included:

- `partitionCanvasFiles`, followed by another full source-file classification
  and placement filter in `AmbioCanvas`.
- `DeltaPanel` constructing full-project membership and filter lookup tables
  while it was not displaying a review.
- Canonical membership and other initial canvas/store consumers.

This explained why moving the later integrity audit was insufficient: the input
had already waited behind the store update and its synchronous consumers.

## What changed

`partitionCanvasFiles` now classifies each filename once and retains the complete
source population in input order, alongside placed/unclassified/document lists.
When the Floor and bins use the same indexed population and placement rules,
`AmbioCanvas` reuses that partition rather than filtering and classifying every
source again. A new-project overview still includes unplaced source in original
order; documentation overrides and unsupported-file exclusion stay unchanged.
Proposal review and bin-specific populations retain their independent filtering.

`DeltaPanel` subscribes to file/system arrays only when it has a delta to review.
Its filter lookup tables are constructed when review opens, rather than while
the panel is closed. Invitation generation, fresh data on opening, filtering,
seen state, undo and copy behavior remain covered by the existing UI checks.

The updated diagnostic recording places the corresponding cold React task at
**47.72 ms**, down from 73.25 ms. These single instrumented spans corroborate
the causal path; they are excluded from the native percentage calculation.
Individual contributions of the two optimizations were not separately benchmarked.
The native comparison covers the combined branch, including the earlier
semantic/integrity work, against exact main.

## Reproduction controls

Windows, Ryzen 9 9900X, Electron 31.7.7 / Chromium 126, 1400×900, device scale
approximately 1. Idle rAF scheduling is about 4.2 ms; no display certification
is inferred. Each measurement retains 100k canonical entities and seven
Flow/DOM nodes at the endpoint. This measures cold loading of a sparse view,
not a dense overview or the user's actual Ambio mapping proposal.

Three exploratory fixed runs first measured 39.4/44.4/37.4 ms. The code was
committed, then this isolated worktree rebuilt exact `c42de0d` renderer sources
and ran five controls. It restored the committed implementation, rebuilt, and
ran five confirmation repetitions. Both sets used the same instrumented-capable
test harness with CPU/timeline capture disabled. Tests/builds did not run
concurrently with native measurements. Other user applications remained open.
This is a same-session block comparison, not randomized AB testing.

The unchanged renderer fingerprint matches the delivered handoff exactly:
`d80065db78eedeed5c9ee1888cf4077e0e9b0702ef4a583b28187e3da5ec4d10`.
The updated renderer fingerprint is:
`5ff26a5993e6c37aec4fb46769a90155e25f2c9d4a84801cc877396f8f6a9970`.

[Curated evidence](canvas-cold-input-win-2026-10-26.json) retains all 13 native
runs, fixture/build fingerprints, hardware, counts, gates, slow inputs and
separate diagnostic summaries. The test harness now optionally captures browser
timelines with `AMBIO_SCALE_TIMELINE=1` and retains timestamped slow inputs for
correlation. Raw profiles/timelines remain in ignored `out/`.

To repeat: build, set `AMBIO_SCALE=1`, `AMBIO_SCALE_SIZES=100000`,
`AMBIO_SCALE_CYCLES=2` and a unique `AMBIO_SCALE_RUN`, then run
`npx.cmd playwright test tests/e2e/canvas-scale.spec.ts --repeat-each=5 --workers=1`.
Keep `AMBIO_SCALE_TIMELINE` and `AMBIO_SCALE_PROFILE` unset for native timing;
use those only in separate diagnostic runs. Compare against a clean exact-main
control with the same test harness, preserving unrelated working files.

## Verification and remaining limits

- TypeScript and the full production build pass.
- Unit/renderer/shared/adapter suite: **767 passed, 12 skipped**, no failures.
- Six preservation UI checks pass: Floor screenshot, 805-file fresh overview,
  documentation exclusion/library, proposal review, Review Changes undo/copy/
  work orders, and Review Changes filtering/seen state.
- Five interaction-bound checks pass: Floor, sheet, proposal, navigation and
  worker fallback. Long navigation tails remain observable; those checks are
  correctness/work bounds, not universal timing acceptance.
- All native scale runs passed their correctness checks. Their cold-input gate
  results remain separate; memory and selection acceptance are unset for these
  short two-cycle runs. No full Go/MCP/chat suite was needed for these unchanged
  runtime layers.

Keep `canvas-cold-layout-worker` open for the remaining 52.5 ms miss, full-model
consumers, threshold-crossing work and broader acceptance. Dense Review,
progressive data and memory/platform acceptance remain separate open work.
