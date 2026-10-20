# Canvas frame budget implementation

Approved scope: Max's 2026-10-20 instruction to implement all five strategies.
Ambio's connector is unavailable; no canvas sheet was saved.

All changes stay within the renderer's canvas and data-presentation boundary.
Canonical geometry, semantic membership and persistence remain authoritative.

1. Three representations: tiny silhouettes, compact identities, rich detail.
   Preserve silhouettes and interaction; expensive subtrees need admission.
2. A per-canvas scheduler grants rich mounts in bounded animation-frame batches,
   prioritizes interaction, and retains recently used detail to prevent churn.
3. A worker builds a spatial scene index. Buffered visibility avoids exact-edge
   mount/unmount churn. Camera navigation prewarms its destination; intermediate
   nodes can remain compact during flight. Stale results cannot replace a newer
   scene/camera request. Worker failure has a bounded local fallback.
4. Virtual symbol rows and shared cancellable, concurrency-limited symbol
   requests bound data work. Empty replies get short-lived caching and revision
   invalidation. Existing graph patch/runtime batching remains ordered.
5. Profile cold reveals, dense scenes, rapid camera reversals, fit-to-node
   flights and interruptions. Record longest frames, p95, mounts, DOM, request
   concurrency and scheduler batches. Deterministic tests enforce structural
   bounds; timing distributions are measured on this host.

Implementation order: pure spatial/budget primitives; per-canvas controller;
node presentation; symbol virtualization/cache; navigation; profiling and QA.
The overview stays in React Flow for this iteration. A permanent GPU renderer
is a separate decision informed by the resulting measurements.
