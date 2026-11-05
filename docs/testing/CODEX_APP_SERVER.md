# Native Codex App Server

Implemented on `codex/native-app-server`, 2026-11-04. This follows Max's choice
of the vendor's native embedding interface rather than a third-party ACP adapter.
Protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server).
The installed `codex-cli 0.162.1` generated the schemas used to check request and
notification shapes; initialization identifies this client as Ambio.

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
- Full access remains the default. **Ask me** maps to a project sandbox and
  on-request approval on macOS/Linux. Windows keeps full access, as recorded in
  DECISIONS, and uses untrusted command approval instead: the installed shell
  sandbox fails initialization. Human review is selected explicitly. Approval
  requests use the existing permission desk, with project/request ownership;
  silence, errors, expiry, cancellation and unsupported requests never grant access.
- **Review changes**, or `/review`, runs `review/start` on uncommitted changes.
  Once it completes, a normal turn receives the reviewer findings and the Ambio
  handoff, claims the request and returns a review through the existing tools.
  This intentionally uses two provider turns rather than bypassing inbox leases.
- Text/thinking update by item identity. Commands retain status, exit code and
  bounded output; file changes and turn diffs are expandable. Usage is labelled
  **Thread total**, including cached input. Repeated snapshots are compacted;
  UTF-8 split across stdout chunks is decoded without corrupting characters.
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
- Final checks: TypeScript, app build, 940 unit tests (933 passed, 7 skipped),
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
```

The live journeys spend account usage and create provider threads for throwaway
projects. They never edit a developer checkout or global configuration. Set
`AMBIO_LIVE_CODEX_TRANSPORT=exec` to qualify the legacy conversation route.

## Limits

Native structured question forms and MCP form/URL elicitations are not represented
as editable forms in this slice. They are declined rather than answered or granted
automatically; ordinary text corrections remain available. Media attachments,
queueing a next turn, durable cross-restart permission decisions and broader common
workflow requests stay in their existing WORK items. Restart marks live receipts
interrupted; it does not silently relaunch work. App Server permissions and policies
do not imply parity with Codex Desktop plugins or its other UI-only integrations.
Authenticated and Electron evidence is Windows-only; packaged macOS/Linux manual
qualification remains part of the broader daily-driver gate.

The broad delivery Electron test reaches a stale final resize-persistence assertion
for `ambio:inbox-width`; the app now persists `ambio:sidebar-width`. Its native Codex
delivery checks pass. One parallel MCP run hit the mapping recovery `interrupted`
versus `stopped` assertion; the isolated recovery rerun and all 50 MCP tests run
serially pass (48 passed, 2 skipped). These are recorded separately in WORK.
