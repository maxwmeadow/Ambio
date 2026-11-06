# Native Codex App Server

Implemented on `codex/native-app-server`, 2026-11-04. This follows Max's choice
of the vendor's native embedding interface rather than a third-party ACP adapter.
Protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server).
The installed `codex-cli 0.162.1` generated the schemas used to check request and
notification shapes; initialization identifies this client as Ambio. The Codex-side
controls follow-up is on `codex/unify-codex`, branched from local
`claude/agent-controls-unify` (`ede741d`), updated 2026-11-05.
The pre-merge corrections are on `codex/unify-codex-fixes`, from local
`trial/unify-all` (`50b85c7`).

## Behavior

- New Codex conversations use the installed CLI's App Server. This inherits the
  user's existing sign-in, configuration, model provider and `CODEX_HOME`.
  No adapter, SDK, bundled second Codex or new account setup is required.
- The first receipt pins the connection. Existing receipts without a transport
  keep exec. Choose **Codex options → Connection → Exec** in a new conversation
  for compatibility. Neither connection changes automatically after failure.
- A process serves one Ambio run. Later messages use `thread/resume`, the same
  provider thread and the same conversation checkout. Resume errors are reported
  without substituting a fresh thread or replaying potentially executed work.
- The composer accepts **Send correction** while a provider turn is live, with
  its exact turn ID as a precondition. Successful acknowledgement records the
  correction in the run; failure preserves the draft. Stop sends `turn/interrupt`
  before terminating the process tree after a bounded grace period.
- The shared **AgentAccessChoices** (the agent's guide and Settings → Agents) is
  the only access picker; nothing is preselected (DECISIONS 2026-11-05). Ask me selects `on-request` with a human reviewer; Auto selects
  `on-request` with `auto_review`. Both retain a workspace-write sandbox for Build
  and a read-only sandbox for Ask/Propose, with network and temporary-directory
  exceptions off. Full access preserves the earlier platform policy.
- Auto is offered when `initialize.userAgent` reports a semantic version at or
  above the qualified baseline `0.162.1`. Components compare numerically;
  build metadata has no precedence and `0.162.1` prereleases sort below the
  baseline. Unknown, malformed and older versions do not acquire it.
  A remembered Auto choice that becomes unavailable is preserved and labelled
  unavailable, so it cannot silently become Full access. Selecting Auto directly
  on an unqualified backend fails before creating a thread or sending a prompt.
- Host listing reads cached qualification synchronously. A cold or expired
  cache starts discovery in the background and returns Ask me/Full access;
  Auto appears on a later capability refresh once the version is known. A hung
  discovery process does not hold up the agent list.
- Windows Ask me and Auto use the qualified `unelevated` restricted-token
  implementation. The installed default elevated helper fails initialization;
  the retired selectable `untrusted` approval policy is no longer sent. An
  unsupported Windows version is refused rather than given broader permissions.
  Codex must confirm the effective approval policy, reviewer and sandbox before
  Ambio sends the prompt. A sandbox failure never causes a Full access retry.
  Max approved the selected Windows sandbox profiles on 2026-11-05; the new
  DECISIONS row supersedes the earlier every-mode full-access rule.
- Scoped mapping replaces the inherited MCP table with Ambio's scoped launcher,
  disables factory app/plugin/browser endpoints, and explicitly disables the
  injected Node REPL MCP endpoint. Only Ambio is enabled. Codex's status/config
  discovery can still show a disabled Node record with no tools; it is not loaded.
  Ordinary runs keep user MCP configuration and extensions. The same isolation
  arguments are used for native and explicit exec mapping launches.
- **Review changes**, or `/review`, runs `review/start` on uncommitted changes.
  Once it completes, a normal turn receives the reviewer findings and the Ambio
  handoff, claims the request and returns a review through the existing tools.
  This intentionally uses two provider turns rather than bypassing inbox leases.
- Text/thinking update by item identity. Commands retain status, exit code and
  bounded output; file changes and turn diffs are expandable. Usage is labelled
  **Thread total**, including cached input. Repeated snapshots are compacted;
  UTF-8 split across stdout chunks is decoded without corrupting characters.
- Child activity identifies the agent path or nickname/role, the collaboration
  operation, targets, task and status. Known child tool items are labelled
  `Subagent · …`; child text/thinking transcripts and unrelated threads stay hidden.
- Run history has no 390/400-item cutoff. All stable identities and ordinary
  events are retained; repeated snapshots still compact on disk. Individual
  output/diff previews remain bounded. Above 2,000 cached items, the adapter
  evicts the oldest completed, flushed items. Active and unflushed items remain
  until safe to evict; a burst may temporarily exceed the cache target.
- Native structured questions use the same question cards as Claude, with
  choices and the user's own words. The permission desk waits ten minutes,
  preserving workspace/message/host ownership. Answers map from question text
  to Codex question IDs, each with its answer array. Denial, timeout, stale
  ownership or cancellation returns a JSON-RPC request error; the installed
  question response schema has no decline enum. No successful empty form or
  invented answer is sent. Resolved requests never receive a late second reply.
- Worktree handoffs name both the common project root and the actual checkout,
  so a correctly shared MCP connection is not mistaken for a different project.

## Verification

- Protocol tests cover initialization/configuration, resume failure without replay,
  streamed items, wrong-thread/turn events, approvals and stale answers, steering,
  interruption, native review ordering, model pagination and platform policies.
- Process tests cover receipt/session persistence, event replacement, usage,
  graceful interruption, resume, failure despite exit zero, native review handoff
  and legacy connection pinning.
- The Electron journey uses an isolated native-protocol peer through real IPC and
  process launching. It covers partial output changing in place, correction
  acknowledgement, Stop, resumed thread identity, permission UI decisions,
  review, usage and the explicit compatibility selector. Screenshots were checked.
- Authenticated Windows `0.162.1` discovery returns the CLI's real model list.
  The existing conversation harness passes real claim/reply, follow-up recall,
  provider thread resume and shell execution through App Server using `gpt-6-luna`.
- The extended authenticated journey also passes: a correction changes a requested
  function from returning 42 to 43; nine real approval callbacks reach Ambio;
  the generated module is executed and checked; Stop interrupts an active command;
  native review then resumes the same provider thread in the same Git worktree
  and returns its findings through the normal inbox. The main checkout is untouched.
- Initial checks (2026-11-04): TypeScript, app build, 940 unit tests (933 passed, 7 skipped),
  the dedicated Electron journey and both authenticated journeys pass. All 50 MCP
  end-to-end checks pass serially (48 passed, 2 skipped).

Reproduction (PowerShell, from the checkout):

```powershell
npx tsc --noEmit
npm run test:renderer
npm run build
npx playwright test tests/e2e/codex-native.spec.ts
npm run test:mcp
$env:AMBIO_LIVE_CONVERSATION_HOST = 'codex'
$env:AMBIO_LIVE_CONVERSATION_MODEL = 'gpt-6-luna'
node --test mcp/e2e/conversation.live.mjs
$env:AMBIO_LIVE_CODEX_NATIVE = '1'
node --test mcp/e2e/codexNative.live.mjs
$env:AMBIO_LIVE_CODEX_CONTROLS = '1'
node --test mcp/e2e/codexControls.live.mjs
```

The live journeys spend account usage and create provider threads for throwaway
projects. They never edit a developer checkout or global configuration. Set
`AMBIO_LIVE_CODEX_TRANSPORT=exec` to qualify the legacy conversation route.

## Limits

Secret questions and MCP form/URL elicitations are declined; the current question
card does not provide secret input or those MCP forms. Media attachments,
queueing a next turn, durable cross-restart permission decisions and broader common
workflow requests stay in their existing WORK items. Restart marks live receipts
interrupted; it does not silently relaunch work. App Server permissions and policies
do not imply parity with Codex Desktop plugins or its other UI-only integrations.
Authenticated and Electron evidence is Windows-only; packaged macOS/Linux manual
qualification remains part of the broader daily-driver gate.

## Controls qualification, 2026-11-05

The real installed Windows CLI identifies itself as `Codex Desktop/0.162.1`
with the Ambio client suffix. The generated protocol includes native
`auto_review` and its experimental review lifecycle notifications. Auto opts
into those notifications and records progress, decision and rationale as one
stable activity item. No code approves an action on behalf of the reviewer.

Authenticated qualification in `codexControls.live.mjs` verifies:

- **Sandbox:** a harmless write inside the workspace succeeds; a write to a
  sibling scratch file is refused with EPERM and leaves no file. The read-only
  profile also refuses an inside-workspace write.
- **Ask me:** one explicit benign escalation reaches the human approval callback;
  returning deny prevents the outside write.
- **Auto:** the same authorized benign escalation receives native automatic
  review, produces reviewing/approved activity with a rationale, and runs with
  zero human callbacks. The workspace-write boundary remains selected.
- **Children:** a real read-only child reads the scratch marker and reports it;
  the parent run records its path, model and started/completed activity.
- **MCP:** an inherited sentinel server is present on ordinary sessions and absent
  from scoped mapping. Effective configuration has only Ambio enabled; disabled
  endpoints expose no tools. A real scoped mapping then calls get_architecture
  and edit_systems, submits the map, and closes its process before settlement.

Deterministic tests retain 4,500 native identities across cache eviction/restart and 1,100 generic events plus
200 updates of one growing item, trigger compaction, and reload the complete
history from a new runner. The Electron peer covers the shared Auto menu,
reviewer/sandbox forwarding, review activity, child attribution, and preserving a
remembered Auto selection when reopening with an unqualified CLI. The broad
delivery Electron spec also covers Claude and the other established routes.

Version `0.162.1` supplies the live baseline; newer semantic versions are accepted
by compatibility policy, not claimed to have been exercised. The effective
sandbox/reviewer response is still checked before input. Packaged macOS/Linux
behavior needs separate live evidence. Max's Windows policy confirmation is
recorded in DECISIONS 2026-11-05; its superseded October row remains intact.
The broad delivery resize assertion was fixed by the merged Claude controls.
Initial controls checks passed: TypeScript, build, 959 unit tests (952 passed, 7 skipped),
both requested Electron specs, and 50 MCP checks run serially (48 passed,
2 skipped). Default parallel MCP reruns passed the mapping assertions but hit
the existing Windows EBUSY cleanup issue in branch/investigation tests, tracked
as `windows-test-environment` in WORK.md.

## Pre-merge fixes, 2026-11-05

The version policy now uses a minimum semantic version of `0.162.1`, rather
than requiring an Ambio release after every CLI update. Tests cover older,
unknown/malformed, stable, prerelease and build-metadata versions. Only the
installed `0.162.1` has been exercised live; acceptance of newer versions is a
compatibility policy, with effective sandbox/reviewer confirmation still required.

Real cold qualification returned Ask me/Full access in 8 ms and offered Auto on
refresh after the initialized version arrived. Delayed-server unit coverage
checks the same behavior; no host-list response awaits initialization or models.
The normal status refresh updates host capabilities without changing selection.

Real `0.162.1` structured questions were exercised with the process-local
`features.default_mode_request_user_input=true` flag. Without it, this version
reports the tool unavailable in Default mode. Ambio preserves the user's CLI
feature configuration. Both the direct protocol and a real runner/isolated daemon
journey answered ORCHID and declined another question. The desk expiry was
600,000 ms, and each completed turn left no waiting card. A JSON-RPC refusal
clears the server request, although the model's final wording after refusal
varies (one run said it was still waiting even though the turn had completed).
The Electron journey checks a selected choice, a written answer and denial.
Unit coverage also rejects timeout/failure, stale owners, late resolved answers
and cancellation; answers never authorize command approvals.

The live-item cache evicts completed, flushed entries toward 2,000 after each
flush. A 4,500-item test keeps active command output across eviction, and the
process/restart test retains all 4,500 persisted items. Quiet-run timing uses
the newest timestamp across the entire item list.

Checks: TypeScript and build pass; 969 unit tests (962 passed, 7 skipped), all
three requested Electron journeys, and the standard parallel MCP suite (48
passed, 2 skipped) pass. All seven installed-CLI controls journeys pass,
including real discovery, questions through the desk, sandbox/manual/Auto,
child attribution and scoped mapping. No new CLI version was installed or
claimed as live-qualified.
