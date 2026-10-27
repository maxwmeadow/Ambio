# Mapping submission and agent completion

Audited and implemented 2026-10-26. The first sections record the original
behavior, reproduced only in throwaway projects. The final section describes
the stricter completion contract Max authorized and its regression coverage.

## What the screenshot means

Four independent events currently look like one completion:

1. `edit_systems(commit_session)` seals a draft and creates a reviewable proposal.
2. `update_work(done: true)` closes a narration/history session.
3. `reply_to_canvas` answers the addressed mapping request.
4. The CLI process exits, or the native chat turn becomes terminal.

Submitting the proposal does not cause any of the other three. Setup polls for
any proposal in the workspace and advances to Review without checking run
termination (`ConnectAgentScreen.tsx`, proposal poll and `movedToReview` effect).
The CLI run stays `running` until `DeliveryRunner` observes process closure.
The Map project heading always says "is mapping" while a run is remembered.
Thus a valid proposal and a still-running agent can coexist.

`update_work` and `reply_to_canvas` can be ordinary closing bookkeeping. Their
names in the replay do not show whether they succeeded or failed. In particular,
a second `update_work(done: true)` with the same session fails after the first
call removes that session from the MCP connection's active-session map. The
error says to call `start_work`; a cooperative agent can follow that recovery
instruction and start unnecessary new narration. This reproduces a plausible
reason for the screenshot's "Restarting the work session", but the actual tool
results from that user's run were not captured in this audit.

## Reproduced behavior

The opt-in probe uses the real MCP stdio server and real daemon against a new
throwaway project. It sets both workspace and run-message bindings, so the
missing restriction is not just an unbound standalone connector.

```powershell
npm.cmd run build:archd
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON mcp/e2e/mappingTailAudit.manual.mjs
```

The script prints observations; success means the probe ran, not that the
observed permissions meet the proposed contract. Its HTTP calls use only the
isolated harness's endpoint and token.

| Operation | Observed result |
|---|---|
| Add a new chunk to the submitted draft | Refused: draft already committed |
| Repeat the same draft submission | Same proposal returned; no duplicate |
| Create a live system while a proposal is pending | Refused by an MCP guard |
| Finish the narration session after submission | Allowed |
| Finish that narration session again | Refused; error suggests `start_work` |
| Reply to the mapping request | Allowed |
| Repeat the identical reply | Allowed, original reply preserved |
| Replace the answered reply with different text | Refused with conflict |
| Start addressed narration on the answered request | Refused |
| Start standalone narration from that same connector | Allowed |
| Human finalizes the proposal while connector stays alive | Allowed |
| Same connector creates a new live system after finalization | Allowed |
| Same connector renames an accepted live system | Allowed |
| Same connector begins and commits another mapping draft | Allowed; second proposal becomes list head |
| Direct fixture API adds a revision after finalization | Allowed with current expected revision; becomes revision 2 |

The final row is an API-level probe, not an advertised `edit_systems` revision
operation. It establishes that finalization is not a durable terminal state for
the proposal. It does not establish that the screenshot's agent used that route.

Twelve existing proposal/draft/finalization database tests also passed under
Ambio investigation with the commit, revision and finalize functions observed:

```powershell
cd archd-go
go test ./internal/db -run "TestArchitectureProposal|TestFinalizeArchitectureProposal" -count=1 -v
```

These cover sequential draft replay, revision conflicts, isolation and atomic
review materialization. They do not cover the full mapping-run lifecycle or the
concurrent scenarios below. The tracing wrapper could not boot the probe's
child daemon; the same probe succeeded directly and its observations were
recorded in the investigation. No claim of traced coverage is made for it.

## Consequences and remaining race analysis

| Situation | Current consequence or risk | Required behavior |
|---|---|---|
| Agent closes notes/reply after submitting | Usually harmless bookkeeping; can loop on non-idempotent work completion | Preserve original terminal result on identical retry; reject conflicting completion without telling it to restart work |
| Agent edits existing live systems while proposal waits | `create_system` has a pending-proposal check; update/assign/merge/delete use separate paths without that check | Mapping authority never permits direct Floor writes, before or after submit; ordinary non-mapping editing keeps its decided policy |
| Human accepts while the agent is still active | Reproduced live create/rename after acceptance from the old mapping connection | Revoke that attempt's mutation permission atomically at submission, independently of process exit |
| Agent submits a second map | Reproduced second proposal; store loads newest workspace proposal rather than one linked to a mapping attempt | Pin setup and Review to attempt + proposal + review version; a new attempt/revision requires explicit intent |
| New proposal arrives during review | `App.tsx` reloads when proposal ID differs; `load()` clears review selection and takes list head | Notify about another proposal without replacing the map being reviewed |
| A previous proposal already exists when mapping is retried | Workspace-wide existence check can mark the new mapping ready immediately; phase only advances | Read current attempt state, never infer its success from historical proposals |
| Agent errors, crashes or is stopped after successful submit | Proposal and process have independent outcomes; UI can imply conflicting success/failure | Preserve submitted proposal; show "Proposal ready; agent stopped/failed while finishing" |
| Stop, cancellation, retry or lease expiry races a write | Process Stop does not cancel the work order or revoke a general mapping credential; already accepted HTTP work can finish | Mark attempt cancelled/superseded before stopping; verify generation and permission inside write transaction; no stale writer can touch a successor |
| Chunk addition or abort overlaps draft commit | Commit reads draft, creates proposal and updates draft status across separate transactions; only sequential replay is tested | Atomic sealing transaction serializes add/submit/abort; abort and commit cannot both succeed |
| Late revision follows approval/finalization | API probe accepted it; human decisions do not advance `current_revision` | Agent submission baseline is sealed; human review edits have their own concurrency version; new agent round needs a new authorized revision request |
| Human navigates away and back | Feed polling is mounted in `MappingActivity`; timer starts at mount, and count reads only open drafts, so elapsed/count can reset | Persistent run observer independent of screen; use run start time and submitted proposal counts |
| Project switch, reconnect or app restart | MCP caches a workspace binding, which already helps; proposal selection is still workspace-wide and native/CLI recovery differs | Keep workspace/root/attempt identity on every operation; recover submitted result and process uncertainty separately |
| Failed submission response is retried | Stable draft-derived proposal ID protects sequential retry, but repeated broadcasts/activity remain possible | Return same receipt without generating another mapping outcome or mutating review |
| External app shares a persistent MCP server | Per-process binding may be insufficient to distinguish multiple human-authorized tasks | Use task-scoped handles; do not apply one mapping's restrictions to unrelated agent work or allow standalone fallback to evade a managed attempt |
| Agent keeps using shell/file tools | Especially on Windows, mapping currently runs with full file access by recorded decision | MCP fencing protects Ambio mutations, not arbitrary filesystem writes; permissions/sandbox policy is a separate decision and release gate |

Concurrent submit/add/abort and actual OS process-stop races above are source
analysis and required regression cases, not races forced by this probe.

## Implemented contract and ownership

Max chose a stricter contract than the audit's initial cleanup-grace proposal:
there is **no agent cleanup after submission**, and Review waits for shutdown.

1. A durable attempt binds the workspace, draft, optional request, notes and
   final proposal. Only one attempt can remain unsettled in a workspace.
2. Mapping agents receive a scoped, revocable credential. They can inspect,
   save notes and draft the architecture; they cannot start work, reply to
   canvas, change source through native tools, edit live systems or make sheets.
   Native chat uses a dedicated read-only mapping agent/runtime. CLI modes keep
   the recorded platform sandbox policy; the mapping API credential restricts
   Ambio writes independently of what a host advertises.
3. Commit atomically creates the proposal, seals the draft/attempt, saves notes
   in the evidence and automatically answers the mapping request. A failure
   rolls all of these back. Commit/add/cancel are serialized. The agent's commit
   is its final action; every later call is rejected. Only an identical direct
   HTTP submit retry can recover the same result after a lost acknowledgement.
4. The main-process launcher observes submission, terminates the owned process
   tree/runtime and records settlement. The UI shows a closing state in between.
   Review requires both submission and settlement, enforced in the UI and in
   review mutation transactions. A process failure or Stop cannot erase a
   submitted map. A mapping-origin proposal cannot gain a new revision.
5. Review pins the proposal from this exact attempt, restored on reload.
   Historical or concurrently arriving workspace proposals cannot advance setup
   or replace the pin. Returning to a replay never restarts native inference or
   stops a later ordinary runtime.
6. Restart revokes before terminating a recovered process, verifies PID creation
   time and never resends the mapping prompt. An unverified process leaves Review
   locked. Startup recovery cancels attempts interrupted before a launch receipt
   existed. Launch failures release their attempt; retry uses a new identity.
7. Setup mapping uses only agents Ambio can manage. External IDE/app agents
   remain usable from the canvas. Ordinary Ask/Propose/Build turns retain their
   existing work/session semantics and permission policy.

## Regression coverage

- `internal/db/mapping_attempts_test.go`: atomic submit/reply rollback, terminal
  notes/revision/new-attempt fencing, concurrent chunk/commit/cancel, review before
  shutdown, generic-abort bypass and recovery of pre-v10 split-commit crashes.
- `internal/api/mapping_attempts_test.go`: real token authorization, workspace and
  route restrictions, all-call revocation and identical submit transport replay.
- Schema upgrade tests include the real previous v9 database fixture.
- `mcp/e2e/mappingCompletion.e2e.mjs`: real daemon/MCP surface, legacy bypasses,
  note preservation, final submission, rejected late calls, CLI process shutdown
  and restart recovery using a real managed child.
- `tests/agent-chat/mapping.e2e.mjs`: bundled native runtime and controlled model,
  restricted tools, automatic shutdown, replay without inference, isolation from
  a later ordinary runtime, orphan startup recovery and launch-failure cleanup.
- `electron/agentDrivers.test.mjs`: scoped credentials reach direct driver configs.
- `tests/e2e/canvas.spec.ts`: a historical proposal cannot complete a new attempt;
  submission while the process is alive stays on Map project; only confirmed
  shutdown advances to Review; reload selects the pinned map, not the list head.

Validation: types and app build pass; renderer/shared/Electron/MCP unit suite
passes (762 passed, 12 unavailable-language skips);
all four bundled native-chat checks pass; both focused Electron setup/review
checks pass; focused daemon lifecycle/proposal/upgrade checks pass. Full Go vet
passes, but the full Go test run fails two existing C++ debugger tests because
the installed debugger reports `Interpreter dap unrecognized`. Full MCP checks
run their assertions successfully but fail two Windows directory-removal hooks
with EPERM (`branches.e2e.mjs` and `investigationRun.e2e.mjs`). A subsequent broad
Go rerun also hit a run-worktree ownership guard failure; that test passed on
isolated rerun. The existing integrated-chat UI test also times out on a provider-form selector
before starting a chat; the setup/review UI regressions pass. These blockers
are tracked in WORK.md.

The standalone `mappingTailAudit.manual.mjs` intentionally reproduces the old
unrestricted connector behavior. It is evidence of why managed onboarding needs
its separate credential; it is not the regression test for the new workflow.
