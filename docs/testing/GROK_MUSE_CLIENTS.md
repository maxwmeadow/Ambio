# Grok Build and Muse Code client checks

2026-10-22. Both clients have MCP setup and Ambio-started conversation routes.
Account sign-in stays in each vendor's CLI; this does not enable subscription
usage in native Ambio chat. Max will run the signed-in trials locally before
merge. Neither vendor's model-driven compatibility is claimed as verified yet.

## Automated coverage

- `electron/grokMuseClients.test.mjs`: install/repair/removal across OS layouts,
  unrelated settings and authored instructions, optional Muse server mode,
  malformed maps, ancestor Grok config and shared compatibility files.
- `electron/grokMuseDrivers.test.mjs`: CLI discovery, advertised Grok auth,
  per-session MCP binding, Claude-only permission-hook environment, Muse MSP v1 start/resume/fresh
  fallback, model selection/discovery, events, Stop, unexpected exit,
  interactive blocking and workspace mismatch. These use strict protocol peers.
- `tests/e2e/agent-delivery.spec.ts`: Grok ACP and Muse MSP peers exercise
  discovery, first-use guides, real Send, persisted work-order handoff,
  workspace/host binding, plain serve arguments and visible completion.
- `ChooseAgent.test.mjs`: runnable-first defaults, explicit Grok/Muse mapping
  selections and discovery-independent app grouping. Instruction regressions
  cover both removal orders, lower-precedence cleanup, frozen Muse-only
  pointers, and stable other-client status as `CLAUDE.md` appears/disappears.
- `mcp/e2e/grokMuseClients.e2e.mjs`: launches the actual MCP server with each
  installer's persisted configuration against archd, reads the map, draws a
  pending proposal, claims/replies to an exact request and checks presence.
  This is not a native vendor CLI test.

Native Grok `@xai-official/grok` 1.0.67 was installed here: help, catalog and
ACP initialization were checked without an account. It advertises `grok.com`
as its authentication method; the driver also accepts the documented
`cached_token` / `xai.api_key` methods. This container cannot apply its read-only
sandbox; Grok refuses to run with missing protections. Muse's installer domain
is blocked by workspace network policy, so no native Muse trial was possible.
Muse protocol behavior is checked against Meta's published MSP v1 schema/SDK,
not guessed `exec --json` output. See [research](../GROK_MUSE_RESEARCH.md).

## Run the signed-in trials locally

Use Node 22.18+ (or Node 24) for TypeScript imports, Go on PATH, repository npm
dependencies installed, and each official CLI installed and signed in. Run
from the repository root. These opt-in tests use a throwaway Python project,
isolated archd/MCP and your CLI's existing account; they spend account usage.
They do not install global MCP settings or change your own source project.

```sh
npm ci
npm run build:archd
npm run build:adapters

AMBIO_LIVE_CONVERSATION_HOST=grok node --test mcp/e2e/conversation.live.mjs
AMBIO_LIVE_CONVERSATION_HOST=muse node --test mcp/e2e/conversation.live.mjs

AMBIO_LIVE_DRAW_FIRST_HOST=grok node --test mcp/e2e/drawFirst.live.mjs
AMBIO_LIVE_DRAW_FIRST_HOST=muse node --test mcp/e2e/drawFirst.live.mjs
```

For PowerShell, assign each variable first, e.g.
`$env:AMBIO_LIVE_CONVERSATION_HOST='grok'`, then run the corresponding `node`
command. Optional model overrides are `AMBIO_LIVE_CONVERSATION_MODEL` and
`AMBIO_LIVE_DRAW_FIRST_MODEL`. `AMBIO_LIVE_RECORD_DIR` chooses where the
per-vendor draw-first JSON report is saved (default: the OS temp directory's
`ambio-draw-first-recordings`). Keep console failures with the run's log tail.
Do not include credentials in reports.

Conversation trials use the production driver and runner: Ask, a follow-up
that requires history and the same native session, then a Build shell command.
They check addressed replies, host-attributed presence and unchanged source.
Draw-first trials use the same launch route to propose a structural change,
verify no code changed before human approval, then approve and build the plan.

Also run the app locally and check:

1. Guided setup offers **Map with Grok Build** / **Map with Muse Code** when
   installed, including model selection and visible progress. The automatic
   default still prefers a runnable agent over a connected editor.
2. Send Ask, Propose and Build from the agent panel. Check live activity,
   continued conversations and Stop. Grok Ask/Propose fail visibly if its
   read-only sandbox cannot start; Muse's no-edit restriction is prompt-based.
3. Sign out of one CLI and send: the run must fail with a visible recovery
   path, not stay running indefinitely. Sign back in using the CLI.
4. To test your own terminal sessions, use Settings → Agents → Add Ambio.
   Test `/ambio-map`, inbox watching, Repair, Test and Disconnect. Other
   clients' configuration and authored instructions must survive. Muse's
   global MCP entry is optional; moving Ambio must not abort unrelated Muse
   sessions. Removing dedicated setup preserves shared MCP/skill sources.

## Native launch failure and startup checks

- **Muse flag acceptance:** run `muse serve --help`, then the normal Muse
  conversation trial. Ambio must launch exactly `muse serve`, without
  `--yolo`; initialize, `session/start` with `allowAll`, and its first turn
  must succeed. Approval mode does not disable Muse's configured sandbox,
  select an unrestricted permission profile, or establish project trust.
- **Grok Linux sandbox:** on a disposable Linux host with no `bwrap` on PATH,
  try Ask, Propose and setup mapping. Each must have a launch-failed receipt
  explaining “Install bubblewrap (bwrap on PATH)” before Grok is spawned.
  Build does not require this read-only preflight. On a host with `bwrap`
  installed but unusable user namespaces, the native failure must show the
  bubblewrap/user-namespace recovery message, keep the read-only arguments,
  and never silently restart with broader permissions. Install/fix bubblewrap
  and repeat Ask/Propose; a native edit attempt must remain refused.
- **Slow Grok MCP startup:** the conversation trial can delay its isolated
  Ambio MCP server before initialization, without touching global config:

  ```sh
  AMBIO_LIVE_CONVERSATION_HOST=grok AMBIO_LIVE_MCP_DELAY_MS=25000 node --test mcp/e2e/conversation.live.mjs
  ```

  Repeat at 35000ms to cross Grok's own usual 30s server-start deadline. Grok
  may reject that server itself; record its outcome. Ambio must not impose a
  competing 30s session deadline, report “Run grok login”, or create another
  session because of that startup timeout. Session new/load/resume have 120s
  deadlines; initialize/authenticate remain bounded at 30s. The unit tests
  advance fake timers through slow new, load and resume responses and assert
  the stage-specific errors. Run with a retained session too, using the
  follow-up in the conversation trial.

## Muse denyUnmatched investigation

The driver now starts plain `serve`. Its normal turns use `allowAll`, preserving
Muse's configured sandbox/profile. **Ask/Propose no-edit is still a prompt
constraint; native enforcement has not been established.**

The published MSP v1 schema admits `denyUnmatched` on `session/start` and
`session/setApprovalMode`. It admits only `mcpServers` in the per-session
configuration: there is no stable per-session tool-policy override for
“deny file edits but allow Ambio”. Each MCP override describes transport,
command, arguments, environment, framing and required/optional startup, with
no permission allowlist. Choosing a mode does not install new policy rules.
[Meta's permission documentation](https://dev.meta.ai/docs/muse-code/permissions)
also describes in-workspace file edits passing approval modes; a mode is not
proof of a read-only filesystem boundary.

The native probe requests
`denyUnmatched`, reads the architecture, creates an Ambio sheet, then explicitly
attempts one native file edit in the disposable project. It only passes if the
Ambio operations work, a native edit is actually attempted, and the canary is
unchanged. A model voluntarily declining to edit is inconclusive. Both start
and resume policy requests have protocol tests, but those cannot prove the
native policy's behavior. No native Muse binary is available here because the
installer domain is blocked; the live enforcement result is **pending**, not
reported as a successful experiment.

```sh
AMBIO_LIVE_MUSE_PERMISSIONS=1 node --test mcp/e2e/musePermissions.live.mjs
```

This writes `muse-denyUnmatched.json` under `AMBIO_LIVE_RECORD_DIR` (or the
usual temp recording directory). If native edits still pass, or Ambio's
mutating tools are denied, record that reason before considering a default
switch. Until a native policy/profile proves both requirements, replacing the
normal mode with `denyUnmatched` would claim an unproved boundary and may
break mapping. Existing user policy rules/profile can affect the result.

Record OS, CLI version, model, account plan, result and any native prompts.
Shared-skill deduplication and attribution of independently opened Grok
sessions that inherit another client's MCP entry remain a separate runtime
compatibility check. Ambio-started sessions receive explicit host identity.

## Recorded checks for this update

- Unit suite after launch review: 776 passed, 14 skipped, zero failures.
- Linux Electron delivery UI test with Grok/Muse protocol peers: passed.
- TypeScript check: passed.
- Production build: passed. Both installed-launcher MCP round trips and both
  Claude permission-hook MCP checks: passed.
- Signed-in native conversation/draw-first trials: pending Max's local run.
