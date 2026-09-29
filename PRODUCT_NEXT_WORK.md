# Next product work

Updated 2026-09-29. The daily loop remains: draw intent, hand it to an agent,
watch the code and map change, review the evidence, and steer the next increment.

The next priority is making that loop trustworthy when the user comes back later
or something interrupts it. The current work-order branch now keeps the sent Sheet
snapshot visible and compares its original structural requirements against live
evidence. Real project and Sheet desktop → Codex → code change → reply → acceptance
runs have passed, including an independent check of the resulting function.

| Order | Work | Suggested owner | Done when |
|---|---|---|---|
| 1 | Record and undo architectural curation | Claude | A file reassignment survives restart as a readable membership claim with before/after evidence, and a guarded undo cannot overwrite newer work. |
| 2 | Work-order recovery across hosts | Codex | A real Sheet request, interrupted agent, expired claim, retry, and requested revision can all return to review without duplicate execution or lost context. |
| 3 | Validate infrastructure contracts in a local demo | Claude after 1 | A small app with a database and queue shows its roles, contracts, implementations, and source evidence; changing the schema or producer exposes the affected contract gap. |
| 4 | Canvas readability with larger projects | Antigravity | A realistic large map stays navigable, activity remains legible, and manual layout survives indexing, resize, and reopening. |
| 5 | Install and first-project reliability | Next available agent | A clean installation opens a project, connects a host, completes one work order, and recovers after restart with useful failure messages. |

## Claude handoff: architectural curation history and guarded undo

Continue after preserving the infrastructure work on your branch. Implement a
complete slice for **file-to-system reassignment history and undo**.

Today `POST /api/files/:id/assign` changes the assignment and broadcasts
`file:assigned`, but it does not write a structural journal event. `EventFileAssigned`
is declared in `internal/db/journal.go` and has no writer. Morning Delta therefore
cannot explain a boundary edit made through the API/MCP while the user was away.

Requirements:

1. Persist the assignment and its before/after evidence atomically. Record the file
   and system labels, workspace/root/branch, actor, and work session when known.
   Repeating an unchanged assignment must create no event.
2. Route both human and agent reassignment through this path. Never infer agent
   identity from a shared workspace alone; keep unknown attribution explicit.
3. Show a readable membership claim in Morning Delta, with the original and new
   systems as evidence. Collapse repeated moves to the net result; moving A → B → A
   must not leave a false outstanding membership change.
4. Add **Undo assignment** to that review. Check that the file's current assignment
   still equals the event's resulting assignment before applying the inverse.
   Return a useful conflict if intervening work changed it. Record the inverse as
   new history and preserve authored geometry.
5. Verify reopen durability, no-op/retry behavior, workspace/root isolation, an
   intervening assignment, and a deleted destination. Exercise the real API/MCP
   and the renderer review action.

Keep the existing Sheet/work-order snapshot implementation owned by Codex. Relevant
starting points: `archd-go/internal/api/server.go`, `internal/db/store.go`,
`internal/db/journal.go`, `internal/delta/delta.go`, `internal/delta/claims.go`,
and `src/renderer/components/DeltaPanel.tsx`.

Deliver a working review-and-undo flow, its checks, and a brief report of any limits.
