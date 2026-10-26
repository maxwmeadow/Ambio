# Initial-mapping review mouse panning — 2026-10-23

Delivery update, 2026-10-26: included in the consolidated canvas main checkpoint.
See the [main/device handoff](CANVAS_PERFORMANCE_HANDOFF.md) for current status,
remaining work and reproduction. The dated evidence below is preserved.


Base: remote main **`908e488`**, pulled into the main checkout and used to start
**`codex/review-pointer-pan`** in the existing isolated canvas worktree. The
previous canonical-scene checkpoint and its handoff docs are ancestors of main.

Max reported a specific regression after testing the merged performance work:
mouse-drag camera motion hitches on the first-mapping approval/send-back page,
while Floor mouse panning and review WASD feel smooth. This concerns
`ProjectReviewScreen` / `ProposalReviewCanvas`, not Review Changes or sheet review.

## Reproduction and measurements

Production Electron on the Windows reference laptop (i7-13700H, approximately
120 Hz scheduling, 1400×900). An isolated synthetic proposal has **96 systems and
576 files**. Review intentionally exposes all 672 entities; the same Floor view
shows 96 systems and hides their children through ordinary semantic zoom.
Endpoints are mocked; no real project data or approval is changed.

The mouse script sends 96 positions with reversals and requested 8 ms spacing.
Final checks additionally return to the starting point and verify capture/shadow
restoration. The keyboard control holds d/a/d/a for 200 ms each, so path duration
and distance are not identical. Frame intervals are rAF samples, not compositor
paint completion or input-to-feedback measurements. Native runs are serial and
separate from CPU/timeline tracing; the laptop is not a controlled release runner.

| Warm gesture | Before | Final native repetitions |
| --- | ---: | ---: |
| Review mouse frame p95 | 41.7–41.8 ms | 16.7 / 16.7 ms |
| Review mouse frame p99 | 58.4 / 58.2 ms | 25.1 / 33.2 ms |
| Review mouse maximum interval | 66.8 ms | 41.7 / 41.6 ms |
| Review mouse long tasks (≥50 ms) | 7 / 6 | 0 / 0 |
| Floor mouse frame p95 | 8.5 ms | 8.5 / 8.5 ms |
| Review WASD frame p95 | 33.5 ms | 33.4 / 33.4 ms |

The review mouse gesture's measured browser TaskDuration falls from about 3.65 s
to 1.95 / 1.92 s. All 672 nodes remain; the DOM stays near 12k elements. Neither
before nor after runs rebuild numeric geometry, write layouts or re-render the
canvas during the measured pan. This is not a new scene-data/culling optimization.

## Findings and delivered fix

- **Repeated browser hit tests:** the ordinary D3 mouse pan listens on the window
  but does not capture the pointer to the pane. Review's fully exposed tree is
  repeatedly considered for pointer targets. One instrumented diagnostic records
  about 1.28 s across 307 HitTest spans, plus substantial layer/compositing work.
  These inclusive spans run on multiple threads and must not be added together.
  Capturing an actual review pane mouse pan reduces that work. Capture is scoped
  to the owning canvas; node gestures, Shift/lasso, control-modified input and
  touch stay with React Flow. Camera math and gesture completion remain Flow's.
- **Invisible connection handles:** review's thousands of transparent handles
  were still in browser layout/hit structures, despite having no connection
  gestures or drawn edges. Review handles now use `display: none`. They remain
  in React's tree; this is not a DOM-wrapper-count reduction. Floor and sheet
  handles retain their measured anchors, including offscreen edge endpoints.
- **Decorative SVG shadow filters:** review paints all children, including tiny
  overview cards. Its pane-drag CSS now suspends card/folder shadow filters during
  mouse camera movement and restores them on release. Resting artwork and node
  drag/resize shadows retain their appearance; WASD is unchanged. This temporary
  motion detail change is recorded in the canvas behavior contract.

The combination matters. Pointer capture alone, handle removal alone and filter
removal alone improved parts of the trace but did not remove the tail reliably.
A combined diagnostic removed long tasks before the delivered implementation was
written. Blanket `will-change: transform` on the full viewport made the workload
much worse (about 167 ms p95); it was rejected. Root/card containment and disabling
pointer events did not solve the issue. A geometric-shadow DOM experiment was
invalidated by React restamping filters and is not parity/speedup evidence.
None of these diagnostic overrides is present in the delivered test or product.

## Verification and limits

- Types, production app build and current-main daemon build pass.
- Unit/adapter suite: **752 passed, 7 intentional skips**.
- Two native repetitions of Floor/review × mouse/WASD: **8 passed**. Checks prove
  actual camera movement, no numeric preparation or layout writes, capture
  release, restored resting shadows, ordinary Floor filters, middle-button pan
  and Shift selection. Normal-mode right drag was an unsupported test assumption
  (already recorded as QA A8); it is not changed by this fix.
- Early fixture failures clicked Fit before readiness or tried to find a toolbar
  that the review page does not have. Another intermediate check needed to await
  styles on newly admitted handles. Their incomplete runs are retained as such,
  not treated as capacity failures or final validation.
- Full native UI integration: **95 passed, 5 intentional skips, 3 failures**.
  Canvas, approval/send-back, resize/drop/Undo, sheets, native authoring,
  deterministic Floor/raster checks, real-daemon loading/watch and both
  development preparation paths pass. The failures are in agent setup/chat UI
  selectors/wording. All three reproduce with application source restored to
  unchanged main `908e488`, then rebuilt: agent-chat expects the unopened provider
  editor, agent-discovery expects the old Copilot CLI label, and chatgpt expects
  the old consent wording. They are logged separately in WORK Inbox. The fix was
  restored byte-for-byte and rebuilt afterward; its bundle fingerprint matches
  the validated build. No agent setup/chat implementation or test was changed.

This addresses the reproduced mouse-drag spikes. The dense review WASD control
still measures about 33 ms p95; it is not certified to the 60 Hz frame target.
Larger visible densities, cold JSON/adoption costs, retained-memory acceptance
and other machines remain the broader scalability work. Max's real-project
recheck of this specific fix is still pending; do not replace it with fixture
results. Resting screenshots and existing authoring/approval flows must remain
valid alongside the intentional pan-only shadow change.

Curated baseline, intermediate, rejected-control and final metrics:
[review-pointer-pan-2026-10-23.json](review-pointer-pan-2026-10-23.json).
Raw CPU/browser traces stay ignored under `out/` / `test-results/`; committed
aggregates omit source content, project identifiers and filesystem paths.

## Reproduction

```powershell
npm run build:archd
npm run build
# Native timings; no simultaneous build/test workload:
npx playwright test tests/e2e/canvas-pan.spec.ts --repeat-each=2 --workers=1
# Separate diagnostic run (excluded from native acceptance):
$env:AMBIO_PAN_TIMELINE='1'
npx playwright test tests/e2e/canvas-pan.spec.ts --grep 'review mouse' --workers=1
Remove-Item Env:AMBIO_PAN_TIMELINE
# Broad integration, including the isolated real-daemon generated-source case:
$env:AMBIO_LIVE_SCALE='1'
npx playwright test --workers=1
```
