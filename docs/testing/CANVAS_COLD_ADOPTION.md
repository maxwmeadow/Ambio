# Responsive cold adoption and scene retention — 2026-10-23–24

Delivery update, 2026-10-26: included in the consolidated canvas main checkpoint.
See the [main/device handoff](CANVAS_PERFORMANCE_HANDOFF.md) for current status,
remaining work and reproduction. The dated evidence below is preserved.


Branch: `codex/canvas-cold-adoption`, based on remote main `908e488` plus the
initial-review pointer-pan fix `2e223a7`. No dependency, database migration,
server endpoint or renderer-library change.

The subsequent Oct 24 [final-adoption follow-up](CANVAS_FINAL_ADOPTION.md)
adds cooperative canonical-index preparation and removes redundant overlay and
persistence work. Its fresh control is retained separately because host timing
changed; do not compare those runs as if they shared this report's baseline.

## Findings

The remaining large-map stalls were spread across snapshot decoding, structured
cloning in both directions, complete React-node projection, semantic visibility,
canonical adoption and full-project lookups built by idle UI features. Moving
numeric layout alone did not remove them.

The failed 10k memory check was partly a real leak. Heap snapshots at cycles 10
and 50 showed approximately 6.47 MB of additional array backing storage. A
retainer path ran from a current canonical lookup's `get`/`has` closures through
a shared function context's `previous` variable to older canonical scenes and
their complete node arrays. This is an engine context-retention issue even
though those two closures did not explicitly read `previous`.

`CanonicalNodeLookup` now stores only the current nodes and stable ID order as
object fields. Its prototype methods do not capture the comparison context.
The same forced-collection control against `2e223a7` retained its previous
scene. A separate-process forced-collection regression test keeps the current lookup
alive and proves that its previous scene is collected. Ordinary and collected
50-cycle comparisons support that fix; they do not certify every project shape
or platform.

## Implementation

- Snapshots above 256 KiB transfer their byte buffer to a short-lived worker.
  JSON decoding runs there. It returns at most 512 rows per acknowledged batch,
  and only the complete assembled snapshot enters the graph store. Cancellation,
  parse errors, worker errors and inactivity terminate that reader. A connection
  change aborts its fetch/reader; existing ordered buffering/resync remains in
  charge of durable updates. Larger worker failures use connection recovery,
  rather than a huge synchronous JSON fallback. Small replies decode inline.
- Numeric input preparation, equivalence comparisons, node projection and the
  initial Floor semantic-visibility pass yield in small tasks. Their target is
  approximately 3 ms between generator checkpoints, not a hard browser-frame
  guarantee. Cancellation prevents stale publication. An empty/new scope drops
  old prepared state; same-scope recomputation retains coherent content.
- Large geometry inputs, prepared results and spatial scenes cross the existing
  canvas worker in acknowledged batches of at most 512 entries. Channels/tokens
  reject stale batches. Spatial revisions remain monotonic across effect
  restarts, and queries wait for a complete uploaded scene. Geometry jobs still
  share one worker with spatial queries. The snapshot reader is temporary and
  terminates after its completed snapshot is assembled.
- Idle Floor renders skip sheet-only and activity-only indexes. Empty selections
  do not build a project-sized file lookup; nonempty selections reuse one until
  the file array changes. Filename classification avoids repeated path splitting
  and duplicate extension checks while preserving document/language overrides.
- Canonical geometry resolves ordinary parent-before-child records without
  allocating a traversal stack and visited set for every file. Malformed cycles,
  missing parents and out-of-order records retain the general resolver. Full
  scene integrity checks reuse their ID set; recovery membership is checked only
  when recovery is needed.

Batches bound entry counts, not arbitrary metadata bytes or every individual
packing/resize primitive. Data residency still includes complete project rows,
canonical nodes and geometry. This is staged preparation/transfer, not the
planned versioned summary/detail daemon protocol or visible-only model storage.

## Measurements

The committed aggregate companion is
[canvas-cold-adoption-2026-10-23.json](canvas-cold-adoption-2026-10-23.json).
It retains native repetitions, intermediate/rejected attempts and diagnostic
memory runs. Raw heap/CPU profiles stay in ignored `out/`.

Windows reference machine, Electron production build, synthetic saved-layout
fixtures and mocked HTTP responses; CPU/browser/DPR/build and fixture hashes are
in each case. These are entity counts, not repository-file capacity claims.
Cooperative stage durations include yielded time; they are not uninterrupted UI
CPU durations. Cold input is a real pointer event followed by two frame opportunities; it is
not a direct measure of completed painting. Timings include response transfer,
startup and the existing intentional navigation animation as labelled.

Baseline at 100k: input-to-frame-opportunity p95 202.7/221.7 ms, largest cold frame
308.2/316.9 ms, complete cold scene 2.22/2.28 s, usable searched view 3.62/3.68 s.
Warm p95 was already 8.5 ms. Both baseline repeats failed the input gate.

Latest paired 100k native repetitions (`cold-adoption-verified-100k`):

| Measure | Before | Staged implementation |
| --- | --- | --- |
| All-phase input p95, two navigation cycles | 202.7 / 221.7 ms | 61.2 / 58.1 ms |
| Cold-only input p95 | Not separated historically | 80.5 / 63.9 ms (18 cold probes each) |
| Largest cold frame | 308.2 / 316.9 ms | 91.8 / 83.3 ms |
| Complete cold scene | 2.22 / 2.28 s | 2.637 / 2.613 s |
| Usable searched view, including flight/settle | 3.62 / 3.68 s | 3.987 / 4.010 s |
| Warm frame p95 | 8.5 / 8.5 ms | 8.6 / 8.5 ms |
| Canonical / Flow / wrapper nodes | 100,000 / 7 / 7 | 100,000 / 7 / 7 |

Both current repetitions **still fail** the <=50 ms cold-input gate. Warm samples
must not dilute that failure: the harness now reports cold input separately,
including on 50-cycle runs. Small cold samples are reported as observations,
not a statistical capacity certification. Intermediate attempts that were slower
or missed gates are retained in the companion file.

The additional scheduling/acknowledgements increase total readiness slightly
while shortening uninterrupted pauses. At 100k sampled private memory remains
roughly 1.0–1.1 GiB, not a new low absolute-memory guarantee. The 10k 50-cycle
ordinary repetitions pass their measured frame, selection, input and memory
targets; only three cold probes occur in that smaller/faster scenario.

### Validation

Types, the app build and 762 unit tests pass (7 skipped). The full UI run passed
95 tests, skipped 3 and failed 4. One failure was our old stale-result injection:
it intercepted only the former single-message upload. The fixture now counts
batched upload entries, holds the completion from the specific worker, switches
workspace and replays that stale completion. The recovery/preparation/reader
follow-up passed all 7 tests. The final build then passed all 16 targeted canvas
pan/performance/recovery/preparation/reader tests, including the corrected stale
completion case and empty-model state release. A 1,500-entity authored-layout
fallback is also covered by the controller unit test: its layout rows must not
be counted as a second set of scene entities.

Three unrelated agent-settings journeys still fail: the provider editor must
first be opened with Add, the Copilot CLI label changed, and ChatGPT consent
wording changed. These same three were reproduced against unchanged main
`908e488` during the review-pan audit and are already in WORK Inbox. This slice
does not change those flows. The full suite is not reported as entirely green.

The broad run also passed real SQLite/HTTP/WebSocket indexing and a watched
source edit (512 files, 32 systems, 544 canonical nodes). That snapshot was
471,089 bytes and used the actual background reader; prepared-scene readiness
was about 235 ms after connection. It is a generated real-daemon fixture, not a
kernel or complete production-corpus benchmark. Review mouse p95 remains
16.7 ms, Floor mouse p95 8.5 ms, both with zero measured pan long tasks. Existing
Floor/raster screenshots, authoring, navigation, drop/resize and Undo passed.

The final verified build fingerprint is
`a4da1ef6a3ec913686caedfa3f4c784a7eb80e9af7c34aea8c95d0ead6e3e28b`.
Follow-up checks and per-case build fingerprints are retained in the companion
artifact; collection controls were measured at their recorded intermediate builds. No daemon or MCP source changes require a schema bump.


### Memory controls

Before fixing retention, two 10k 50-cycle ordinary runs grew page-heap medians
12.0%/17.4%; two forced-collection runs still grew 16.6%/16.7%. Process private
memory fell, so process-level trends alone had hidden retained JS growth.

After fixing the lookup, preliminary 10k collected repetitions grew 2.29%/2.31%,
while ordinary page-heap medians fell 1.1%/3.6%. The same model/viewport and 50
navigation cycles are used. Growth compares the median of the final five cycles
with cycles 6–10, allowing initial caches to warm. GC runs are diagnostics:
forced collection produces frame stalls and cannot certify native frame timing.

At 100k the collected repetitions grew approximately 0.39%/0.40%. An ordinary
100k repetition still failed the unforced page-heap gate despite a sawtooth heap
and falling process memory; its paired repetition passed. Keep that failed case.
Do not claim a universally proven plateau from the repaired 10k result.

## Remaining work

Cold input at 100k is improved but not consistently <=50 ms. Full-model store
consumers, final canonical adoption/integrity and semantic threshold crossings
still create long tasks. Some total loading time increases because work yields
and transfer batches have acknowledgements. The acceptance item stays open.

The next architectural step remains versioned lightweight project summaries,
visible/detail loading and a bounded scene adoption boundary, preserving global
search, authored edits, ordered events and reconnect. WebSocket full snapshots
and classification messages still parse/apply atomically; this change addresses
the HTTP resync reader, not a new live-event protocol. Dense review/WASD, hubs,
any-depth exposure and the batched-renderer experiment remain separate gates.

Human Kohler open/reopen, sheet switching, navigation during loading, editing,
Undo and longer-session checks remain necessary in the real app. This report
does not mark those manual checks complete.
