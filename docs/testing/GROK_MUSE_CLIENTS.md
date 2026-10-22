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
  per-session MCP binding, request identity, Muse MSP v1 start/resume/fresh
  fallback, model selection/discovery, events, Stop, unexpected exit,
  interactive blocking and workspace mismatch. These use strict protocol peers.
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

Record OS, CLI version, model, account plan, result and any native prompts.
Shared-skill deduplication and attribution of independently opened Grok
sessions that inherit another client's MCP entry remain a separate runtime
compatibility check. Ambio-started sessions receive explicit host identity.

## Recorded checks for this update

- Unit suite: 762 passed, 14 skipped, zero failures.
- TypeScript check: passed.
- Production build: passed. Both installed-launcher MCP round trips: passed.
- Signed-in native conversation/draw-first trials: pending Max's local run.
