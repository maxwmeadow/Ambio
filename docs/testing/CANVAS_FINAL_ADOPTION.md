# Final canvas adoption follow-up — 2026-10-24

Delivery update, 2026-10-26: included in the consolidated canvas main checkpoint.
See the [main/device handoff](CANVAS_PERFORMANCE_HANDOFF.md) for current status,
remaining work and reproduction. The dated evidence below is preserved.


Branch: `codex/canvas-cold-adoption`. Remote main `0b5071d` was merged before
this follow-up; its new work-list item is preserved. This extends `08a9d18` and
the initial-review pan fix on the same branch. No dependency, daemon protocol,
database schema or renderer-library change.

## What changed

A Floor projection with prepared semantic visibility now also prepares its
spatial records, ID order and absolute rectangles before publication. These
operations use the existing approximately 3 ms cooperative task runner, with
checkpoints every 256 items, including deep ancestor walks. Equivalent model
echoes reuse the previous records/order/rectangles. Cancellation is checked at
each checkpoint; incomplete results never enter the prepared cache.

An exact-array weak cache hands the completed canonical scene to the render
budget. Selection and runtime/slice/focus/trace overlays can carry this cache
forward because they preserve geometry, node order, hidden state and semantic
detail. Each new lookup points at its current node array. It captures no older
scene. Ordinary immutable geometry and semantic-visibility edits do not inherit
the cache and still take the normal reconciliation path. A separate-process
collection test retains the current scene while proving the old scene and array
can be collected, including through the new weak cache.

The inactive slice previously changed every node's unset `sliced` field to
`false`. Runtime and trace effects also returned fresh arrays even when their
nodes were unchanged. Idle overlays now preserve the original array, without
allocating a replacement; active/cleared flags still update affected nodes.
The previously unconditional persistence maps and complete-scene filtering are
skipped for a saved layout with no generated/resized rows. Initial saves and
incremental reconciliation retain their existing semantics. Review's missing-row
check now builds one saved-ID set instead of searching every saved row for each
editable node, reducing that membership step from quadratic to linear work.

Review's full-visibility policy and sheet-specific composition are unchanged.
Those projections still use their normal canonical reconciliation after their
own transforms. The existing scene-integrity audit remains on adoption; it is
not bypassed by the prepared geometry cache.

## Measurements

All cases, including the slower first attempt and the diagnostic profile, are
retained in [canvas-final-adoption-2026-10-24.json](canvas-final-adoption-2026-10-24.json).
Raw CPU profiles remain in ignored `out/`. Case metadata includes fixture/build
fingerprints, hardware, browser, sample counts, phase timings and failed gates.

These are production Electron measurements on the Windows reference machine,
using the synthetic saved-layout fixture and mocked HTTP. They are entity
counts, not real-project capacity certifications. Pointer-to-two-frame
opportunity measures input responsiveness, not confirmed completed painting.
Cooperative stage times include yielded time, not just CPU use.

The initial attempt had cold-input p95 60.7/64.9 ms but readiness 3.94/4.08 s.
Unchanged snapshot/worker stages were also slower than the previous day's
report. A fresh control rebuilt the exact `08a9d18` runtime (matching its prior
build fingerprint), then reran the same fixture on the current machine. Source
changes were restored before building and measuring the final implementation.
The run order and intermediate results remain visible; host variability is not
hidden or attributed entirely to the code.

| 100k measure, two native repetitions | Fresh `08a9d18` control | Final follow-up |
| --- | --- | --- |
| Cold-only input p95 | 82.8 / 91.8 ms | 74.1 / 32.8 ms |
| Cold input samples | 22 / 27 | 24 / 24 |
| Largest cold frame | 133.3 / 133.3 ms | 125.1 / 108.3 ms |
| Complete cold scene | 3.224 / 3.909 s | 3.463 / 3.405 s |
| Usable searched view, including fit/settle | 4.671 / 5.385 s | 4.965 / 4.881 s |
| Warm frame p95 | 9.3 / 8.6 ms | 8.5 / 8.5 ms |
| Canonical / Flow / DOM nodes | 100,000 / 7 / 7 | 100,000 / 7 / 7 |

The final repetitions improve measured input latency and avoid the redundant
adoption work, but **one still fails the <=50 ms cold-input gate**. Both retain
cold spikes over 100 ms. The other repetition's p95 pass does not remove its
74 ms maximum. Small cold sample counts and machine variability prevent a
reliable percentage speedup or readiness guarantee. Warm frame behavior stays
within its measured target; there is no consistent total-readiness win.

Two native 10k, 50-navigation-cycle repetitions pass their measured frame,
selection, input and memory gates. Selection p95 is 14.0/14.8 ms; heap median
growth is 3.3%/7.7%, with sampled process-memory medians falling. There are only
four cold probes each, so this is a repetition/retention check, not broad cold
input certification. Forced-collection 100k results and validation are recorded
separately: a 50-cycle run grows the collected heap median by 0.42%, with a
falling sampled process-memory median. Its selection p95 is 38.1 ms. Forced
collections cause artificial frame stalls; that run fails frame-p99 and
cold-input gates and is not native timing certification.

## Validation

Type checking, the production build and 766 unit tests pass (7 skipped). Added
checks cover canonical preparation parity through missing/out-of-order/cyclic
parents, a deep-chain checkpoint, cancellation without partial cache publication,
equivalent echoes versus geometry edits, overlay activation/clearing, selection
cache correctness and old-scene/array collection. Development StrictMode checks
also exercise the prepared lookup through geometry changes and empty/restore.

The broad canvas UI run passed 75 of 76 tests. The Undo/Redo screen-position
check failed once (435 px from its expected position after Undo), then passed
three isolated repetitions without a source change. A fresh exact `08a9d18`
runtime control then passed four repetitions and failed one with the same
435.13 px mismatch. This establishes that it predates this follow-up; the
underlying camera/placement/timing cause remains unresolved. The failed control
trace is preserved in ignored `out/final-adoption-undo-control-trace.zip`, and
the issue is recorded in WORK Inbox rather than hidden by retry-only counts. The other visual,
editing/persistence, review, navigation, worker-failure, empty-workspace and
snapshot-reader checks passed. After the control, the final production build was
restored and its fingerprint matches the measured final implementation.

The isolated real-daemon integration also passes: 512 indexed TypeScript files,
32 authored systems, a 471,089-byte HTTP snapshot, WebSocket delivery and a watched
edit reach the canvas. Snapshot-to-prepared time is about 419 ms on this run;
544 canonical nodes, 27 admitted Flow nodes and 7 DOM nodes are observed. This
generated corpus proves the integrated path, not production/kernel capacity.

## Remaining work

- Cold scene integrity, canonical-membership construction and other full-model
  store consumers still do synchronous project-sized work. Full WebSocket
  snapshots/classification remain atomic. The prepared cache fixes a portion
  of the adoption path, not the whole loading pipeline.
- Semantic threshold crossings and explicit navigation can still create a new
  full-scene projection/index. The diagnostic profile continues to show work
  in visibility, selection/search, integrity and garbage collection; its
  instrumented timings are not native performance acceptance.
- The accompanying interaction suite retains its timing observations too.
  Dense review still mounts 672 nodes (about 12k DOM elements); one mouse-pan
  observation has 25 ms p95 and a short 26-sample WASD observation has 75.1 ms
  p95, despite no recorded long JavaScript tasks. Navigation/fallback observations
  also retain occasional large frames. These tests assert geometry/behavior and
  work bounds, not a universal frame budget. The sparse 100k warm result must
  not be presented as dense-review or all-navigation certification.
- Complete project metadata, React-node models and worker geometry remain
  resident. Absolute memory, dense visible regions, high-degree relationships,
  any-depth exposure and multi-repository/kernel-scale projects need the
  separate progressive-data and overview-renderer work in WORK.md.
- Kohler and larger real corpora still need human testing. Windows synthetic
  measurements do not certify Linux/macOS or all refresh rates and machines.

The parent `canvas-cold-layout-worker` remains open. This is a useful, bounded
checkpoint for real-project testing, not an “always smooth” completion claim.
