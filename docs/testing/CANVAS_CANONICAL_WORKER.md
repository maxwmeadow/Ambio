# Canonical scene and background preparation — 2026-10-22–23

Branch: `codex/canvas-scene-scale`, continuing `334e537` on remote main `995f20c`.
This implements the canonical interaction boundary and automatic Floor/sheet
numeric worker preparation from the approved scalability plan. It does not
implement the progressive daemon protocol or a batched GPU renderer.

## Follow-up after merge

Ancestry at remote main `908e488` confirms this checkpoint and its handoff docs
were merged. Max reports the improvements work very well, with a specific mouse
camera-pan hitch on initial-mapping approval. Its reproduction and targeted fix
are recorded in [REVIEW_POINTER_PAN.md](REVIEW_POINTER_PAN.md). The handoff below
is the historical pre-merge record; broader cold-input/memory/density acceptance
remains open. The subsequent [cold-adoption and retention investigation](CANVAS_COLD_ADOPTION.md)
repairs the scene-history leak and stages HTTP/worker/projection work; its current
measurements supersede the older failed memory result for that tested scenario.

## Merge and testing handoff — 2026-10-23

Implementation checkpoint: **`99f5575`** on **`codex/canvas-scene-scale`**.
Max will merge into remote main from another session and then test the real app.
This report records branch validation; it does not confirm a remote merge or
human acceptance. Further implementation awaits that feedback. Remaining input,
memory and density targets below stay open in WORK.

Merge the branch including its preceding component-budget and diagnostics
checkpoints, not just the last implementation commit in isolation. The branch
started from main `995f20c`; `2631eb5`, `72bce38`, `334e537` and `88e191e` precede
`99f5575`. Reconcile WORK/CHANGELOG entries with parallel changes, preserving both
sessions' work. Verify the resulting main against its current integrated feature
set; the branch's prior test results do not certify a newer merge result.

Architecture, canvas contract, changelog and committed aggregate measurements
are updated. Raw profiles and local test output under `out/` are ignored and do
not travel with the merge. The committed JSON below preserves the key evidence.
No database migration, schema bump or new dependency is introduced by this slice.

Use the [checkpoint recheck](CANVAS_QA_CHECKLIST.md#checkpoint-recheck--2026-10-23)
for real Kohler Floor/sheet zoom, offscreen navigation, editing, workspace changes
and longer sessions. Record the tested merge commit and machine alongside any
stutter, missing content or layout regression. Do not mark those manual checks
passed from the automated results in this report.

## What changed

- Complete canonical geometry, bounds and ID lookup live outside React Flow.
  Its node/edge props contain the buffered region, required ancestors, selected
  and active nodes, and endpoints of admitted relationships. Camera answers
  iterate admitted IDs. Selection changes avoid cloning a full lookup Map.
- Conservative relationship bounds match Flow's existing endpoint visibility
  rule: crossings remain visible even if both endpoints are offscreen, while
  disconnected offscreen paths do not force their endpoints into Flow.
- Fit, search and drop use canonical geometry when a target is not adopted.
  Search waits for accepted preparation; explicit navigation wins over initial
  framing. Resize compensation includes unadopted children, without admitting
  all children merely because a parent is being resized. Resize callbacks are
  attached to the interaction subset and their cache is pruned on eviction.
- Numeric alternate-axis initialization and Floor frame math moved out of
  AmbioCanvas into `scene/sceneGeometry.ts`. The existing visibility worker now
  runs both Floor and sheet preparation. Inputs contain numeric/structural fields,
  not React callbacks or source contents. Prepared geometry is versioned by
  request/channel; workspace/sheet scopes and immutable model identity guard
  adoption and generated-placement writes.
- Jobs yield between loop chunks and superseded requests reject. A cancellation
  acknowledgement deadline terminates an unresponsive atomic primitive and
  offers recovery. The last coherent scene remains available during preparation
  and failure. Large worker failures never run a huge synchronous fallback;
  small scenes can prepare cooperatively. Retry replaces the worker.
- Metadata/save echoes can reuse pending or accepted numeric preparation.
  Timestamp-only layout echoes and unchanged semantic parent assignments keep
  renderer identities; authoritative timestamps remain in the database.
- Failed initial layout saves no longer clear the attempt latch and immediately
  repeat layout/network work. They roll back the unsaved rows, retain a coherent
  presentation and expose Retry for the current workspace.
- Empty activity skips full activity indexes. Integrity checks remain active:
  changed immutable nodes are checked incrementally, with the complete canonical
  audit repeated for structural revisions. Selection does not sort IDs again.

## Preservation and failure evidence

Four frozen fixtures from `334e537` cover fresh nested packing/infrastructure,
authored compressed frames, incoming children among authored neighbors and
invalid legacy parents/cycles. Both extraction and numeric transfer projection
match their old output. Worker-controller checks cover stale replies, restart,
small fallback, refusal of large synchronous fallback and non-yielding cancellation.

Native tests exercise switching workspace while an old prepared result is held,
then delivering that old result after the new scene is adopted. They verify a
complete 1,200-node canonical scene with fewer than 100 adopted nodes. A 3k/4k
worker-crash test retains content and retries the latest model. A failed-save
fixture verifies one failed request, no automatic retry loop, and explicit recovery.
The established Floor screenshot, real-daemon authoring, drag/resize/Undo, sheet
semantics, search/chips and rasterized relationship checks remain applicable.

## Measured scope and limits

Production Electron on the same Windows reference laptop, 1400×900. Fixed-density
saved fixtures retain the same local neighborhood while total metadata grows.
Twenty cycles are not memory acceptance. CPU profiles are diagnostic and separate
from native timings; stage durations are inclusive and must not be added.

| 100k saved entities | Previous checkpoint | New repetition 1 | New repetition 2 |
| --- | ---: | ---: | ---: |
| Warm frame p95 / p99 | 58.4 / 166.6 ms | 8.7 / 25.0 ms | 16.5 / 25.1 ms |
| Selection feedback p95 | 262.0 ms | 36.1 ms | 37.2 ms |
| Adopted Flow nodes / mounted wrappers | 100,000 / 7 | 7 / 7 | 7 / 7 |

The first new repetition, before the selection bookkeeping fixes, measured
16.7/66.7 ms warm p95/p99 and 84.3 ms selection. Keep these intermediate results;
a single fast repetition is not universal acceptance. Both final native repetitions meet
their warm-frame and selection gates, but **fail the all-phase input gate**:
input-to-paint-opportunity p95 is about 164 / 109 ms. Complete snapshot fetch/decode/store
takes about 731 / 838 ms; overall maximum frame intervals are 300 / 342 ms. Cold
adoption reaches two frame opportunities in about 2.1 / 2.6 seconds; scripted
search readiness is about 3.6 / 4.0 seconds including intentional flight and settling.
The 56.5 MB synthetic response spends about 191 ms in JSON decode in both runs.
Numeric input copying to the worker takes 60–68 ms, full renderer projection
76–87 ms, and visibility record posting up to 34–40 ms. These inclusive stages
identify remaining cold costs; they are not an additive attribution of the longest frame.

The live integration uses real indexing, SQLite, HTTP, WebSocket, and watched
file updates in an isolated directory. Generated modules establish repeatable
functional coverage; a copied production-source slice is measured separately.
No live project database or source file is changed. This is not app launch,
unbounded multi-repository, kernel-scale or cross-platform certification.

A failed intermediate live test initially showed hundreds of preparations. Its
second HTTP listener lacked the isolated test token, causing failed layout saves;
the automatic save/repack retry loop was the application bug it exposed. This
must not be presented as a controlled speedup from 640 legitimate geometry jobs.
After authentication was corrected, a 512-file / 32-boundary generated project
reached prepared geometry in about 352 ms after connection, observed its watched
edit, and submitted two numeric jobs across the workflow. It adopted 32 of 544
entities at the measured endpoint. Save/parent echo and equivalent-input reuse
also have independent identity/regression checks.

## Final integration and density checks

The copied production-source run indexed **377 files / 95,371 lines / 691
relationships**, using synthetic 16-file authored boundaries (24 systems).
Harness startup/index readiness took 5.58 s; a separately fetched 436 kB snapshot
took 9.4 ms, and renderer connection to prepared geometry took 215 ms. The normal
HTTP/WebSocket path observed an edit and six further search flights, submitting
two numeric preparations. At the endpoint 36 of 401 canonical entities were
adopted, with seven mounted wrappers. The copy contains production sources but
omits manifests and tests; this does not certify full-repository resolution,
authored architecture quality or indexing capacity. Initial test-only null-array
assumptions were corrected for projects without infrastructure/relationships.

Native saved-layout tests separate relationship density from total entity count:

| Scenario | Warm p95 / p99 | Selection p95 | Adopted / canonical | Actual paths |
| --- | ---: | ---: | ---: | ---: |
| 1k common hub, 20 cycles | 8.5 / 8.5 ms | 18.4 ms | 149 / 1,000 | 142 |
| 1k chain, 20 cycles | 8.5 / 8.6 ms | 14.4 ms | 10 / 1,000 | 2 of 142 |
| 1k depth-20, 20 cycles | 8.5 / 8.6 ms | 18.8 ms | 72 / 1,000 | 0 |
| 10k fixed view, 50 cycles | 8.4 / 8.5 ms | 13.8 ms | 7 / 10,000 | 0 |

The hub test verifies every planned path exists with finite path coordinates;
the chain correctly removes disconnected offscreen relationships. The depth
case retains required ancestors. All have passing frame/input/selection gates,
but overall cold/navigation maximum intervals still reach 58–133 ms. These are
modest visible densities, not the planned 2k/10k-mark renderer comparison.

**Memory acceptance fails.** The 10k 50-cycle test has page-heap median growth
of 13.4% (target ≤10%), while sampled aggregate process memory falls 17.5%.
No forced collection is used; this is insufficient to establish either a leak
or a plateau. Peak sampled private memory is about 802 MiB for this soak,
1,137 / 1,018 MiB for the two 100k repetitions and 1,330 MiB for the hub run.
Worker memory is included in Electron process totals, not separately isolated.
Do not call the scene memory-light or apply an absolute release budget from these runs.

Controlled Kohler snapshot replays explicitly Fit and await camera/scene idle
before each sweep. Two Floor repetitions both measure p95 **8.6 ms**, maxima
25.0 / 24.9 ms, 451 DOM elements. Two actual-sheet repetitions both measure
p95 **16.7 ms**, maxima 33.4 / 50.0 ms, 532 DOM elements. All four have zero
observed long tasks during the measured sweep and no sheet repacks. These
start frames differ from historical variable-camera sweeps, so they are not
paired before/after speedup measurements; initial preparation is excluded.

Curated native, intermediate, obsolete-harness, CPU-control and real-daemon
results: [canvas-canonical-worker-2026-10-23.json](canvas-canonical-worker-2026-10-23.json).
No source text, project names/IDs or filesystem paths are included.

## Validation

- TypeScript and production build pass. MCP end-to-end: 43 pass, 2 intentional skips.
- Unit/adapter suite: 744 pass, 7 intentional skips.
- Full native UI suite: 91 pass, 5 skips (three opt-in scale cases and two
  external-agent live pipelines); includes real generated-source daemon coverage.
- Separate production-source real-daemon run, four scale/density cases, 50-cycle
  soak and four Kohler wheel repetitions pass their structural/correctness checks.
  Timing/memory gate failures above remain failures despite successful test execution.
- Frozen pre-extraction parity and stale/cancelled/failed worker coverage included.
- Native chat harness: two pass, one existing fixture failure. Saved-chat deletion
  constructs AgentChat without the required proxy, then fails setting
  `onChatGPTFailure`; both files are unchanged from main `995f20c`. Recorded
  separately in WORK Inbox; canvas/UI inbox and reply-navigation checks pass.

## Remaining work

- Snapshot JSON decoding/application and full canonical React-node projection
  remain on the renderer thread. Moving numeric math alone cannot make these
  bounded. Continue progressive data and region/ancestor descriptors, preserving
  global search and coherent mutation/version handling.
- Numeric result clone/transfer and canonical model storage still grow with the
  complete project. The one-worker design avoids a second full worker model;
  it does not establish an absolute or plateau memory budget.
- A genuinely dense visible graph still draws individual SVG edges and required
  handles. Relationship indexing removes disconnected work, not visible density.
  Run the approved batched-overview comparison before any-depth reveal.
- Explicit Tidy Frame still uses its existing packing/mutation controller.
  Automatic Floor/sheet preparation is moved; this is not a migration of every
  user command's numeric primitive.
- Real-project indexing, clustering and multi-root loading need broader corpora
  and recorded machines. Untested platforms stay unverified.

## Reproduction

```powershell
npx tsc --noEmit
npm run test:renderer
npm run build
$env:AMBIO_LIVE_SCALE='1'
npx playwright test --workers=1
# Copied production sources, temporary data and synthetic benchmark boundaries:
$env:AMBIO_LIVE_CORPUS='ambio'
npx playwright test tests/e2e/canvas-live-scale.spec.mjs --workers=1
# Native scale timing; do not overlap with another test/build:
$env:AMBIO_SCALE='1'
$env:AMBIO_SCALE_SIZES='1000,10000,100000'
$env:AMBIO_SCALE_CYCLES='20'
npx playwright test tests/e2e/canvas-scale.spec.ts --workers=1
```
