# Canvas performance audit — 2026-10-13

The Floor and proposed architecture share `AmbioCanvas`. This audit used the
current Kohler snapshot and its 62-system, 127-file proposal, copied into isolated
Electron fixtures. No live proposal or project data was changed. A mapped copy
of that proposal also exercised the same architecture as an authored Floor.
Four copies produced a 756-node stress case. Native Windows Electron runs used
1600 × 1000 viewports and the installed Electron 31 / React Flow 12 stack.

## Method

Each zoom workload dispatched 96 wheel steps at roughly 16 ms intervals,
alternating direction every 24 steps, followed by a one-second settling period.
Measurements included requestAnimationFrame intervals, Chrome long tasks, CDP
script/layout/style/task duration and sampled JavaScript CPU profiles. Two
repeated runs were recorded per configuration. React commit counts cover the
entire renderer root, rather than only node component renders.

The main comparisons used production renderer bundles. The final code was also
checked against the running Vite renderer. CPU profiling adds overhead, so these
are comparative measurements on this host, not a universal FPS guarantee.
Unrelated proposal-review UI changes also landed in the shared working tree
during the audit. The initial comparisons predate that sidebar redesign; later
final-build measurements include it. The cached canvas workload is the same,
but end-to-end frame/commit comparisons do not isolate those UI changes.

## Findings and changes

1. **Canvas-wide inherited zoom property.** `onMove` wrote `--ambio-zoom` on the
   canvas root every frame. That invalidated styles across roughly 6,600 elements
   in the real proposal. Blocking only that write in a diagnostic run reduced
   p95 frame time to about 25 ms and cumulative style time to about 0.05 s.
   The fix tracks mounted activity badges and writes zoom locally; the CSS
   property is non-inheriting. Late arrivals and nested bin cameras are covered.

2. **Proposal zoom rebuilt an unchanged controlled node array.** Review used
   `curr.map(makeFullyVisible)` on each zoom frame. Although node identities
   often survived, the array changed and retriggered scene projections,
   React Flow processing and diagnostic effects. Review visibility is already
   established by layout projection, so camera movement now leaves it alone.

3. **Idle and irrelevant subscriptions.** Empty living/trace overlays subscribed
   to every viewport move. They now mount their camera subscribers only when
   there is content, and active overlays subscribe to zoom alone. Review/bin
   selectors also exclude live-only effects, agent activity and runtime state
   before those channels can cause a render.

4. **Active routes recomputed on zoom.** Living flows rebuilt node indices for
   each endpoint and recreated world-space paths whenever zoom changed. They
   now share one scene index and cache routes separately from pulse size. Trace
   routes similarly remain cached while zoom-dependent callout placement updates.

## Measurements

| Workload / metric | Before | After first optimizations |
| --- | ---: | ---: |
| Real proposal, 189 nodes: p95 zoom frame | 58–67 ms | 25–58 ms |
| Proposal: cumulative style recalculation | 2.27–2.62 s | 0.23–0.39 s |
| Proposal: cumulative JavaScript | 1.07–1.10 s | 0.46–0.81 s |
| Proposal: cumulative main-thread task time | 4.32–4.80 s | 1.67–2.85 s |
| Proposal: renderer-root commits | 622–674 | 215–271 |
| Authored Floor copy: cumulative style recalculation | 0.83–0.89 s | 0.19–0.29 s |
| Authored Floor copy: cumulative main-thread task time | 2.03–2.29 s | 1.56–2.23 s |

These durations cover the complete scripted workload, not a single frame.
The first ordinary proposal retest eliminated its repeated 50+ ms tasks, and
the Vite proposal run also measured p95 around 25 ms without 50+ ms tasks. A
later final-build run measured p95 around 58 ms with some long tasks despite
still showing much less style work and fewer React commits. This variation
means the audit establishes reduced rendering work, not consistently smooth
frames on this host. Floor timing similarly varies around reveal/mount
boundaries; its final run included a 300 ms first-pass outlier. Further work on
mounting/painting is warranted even on medium scenes. These later results are
included instead of reporting only the fastest retests.

## Remaining scale limit

The 756-node proposal still reaches p95 around 92–108 ms while zooming. Its
overview mounts about 26,500 DOM elements. The corresponding collapsed Floor
has only about 52 visible nodes; its warm p95 was around 9 ms, with a large
first-run reveal outlier. Large review is therefore still a separate scaling
problem after the avoidable camera work is removed.

Two experiments were rejected:

- Disabling shadows/filters did not materially fix the large-review spikes.
- Disabling viewport culling reduced some maximum spikes but worsened median
  frames from about 8–16 ms to about 33 ms and increased total task time. Culling
  remains enabled above the existing 40-node threshold.

The next investigation should target buffered visibility, incremental mounts
and compact DOM representations that retain the current silhouettes and editing
behavior. Semantic zoom's per-frame ancestry sorting and unconditional pointer
diagnostic reads are secondary candidates. Avoid changing camera easing,
thresholds, pointer anchoring or reducing visual fidelity without evidence.

## Regression checks

Build first, then run:

```sh
npx tsc --noEmit
npm run build
npx playwright test tests/e2e/canvas-performance.spec.ts
npx playwright test tests/e2e/canvas.spec.ts --grep "autofits|805-file|hidden-node flows|rapid save|reviews the proposed|resize chrome|partial lasso|drags a root|reparenting drop|wheel zoom|utility chrome|placed system stays"
```

The performance tests assert structural invariants instead of machine-dependent
timing limits: no camera property writes on the canvas root; no semantic zoom
pass in review; no review render from unused live-channel updates; correct badge
scaling after late mounts; and independent nested canvases.

The interaction checks cover 100× wheel zoom, resize chrome, selection, drag,
containment persistence, live bursts, hidden flows, proposal edits and large
overview virtualization. The Windows harness creates isolated Roaming/Local
AppData folders and checks fixture identity in the store because the redundant
title-bar project label was intentionally removed.

The full unit run has four existing Windows installer/CLI fixture failures
(610 passed, one skipped); the 50 directly relevant canvas unit checks pass.
The 14 selected interaction/performance checks passed together. A final six-case
rerun passed five cases but once missed a live-flow CSS animation-start event
and encountered a Windows LevelDB lock during teardown; the same final build
passed that flow check in an isolated rerun. This test scheduling/shutdown issue
is recorded separately rather than hidden by automatic retries.
