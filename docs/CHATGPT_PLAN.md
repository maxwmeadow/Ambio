# ChatGPT plan usage in Ambio

Ambio's local open-source desktop app can use **Sign in with ChatGPT**.
Eligible accounts authorize Ambio to use their ChatGPT plan for AI requests;
this requires neither an OpenAI API key nor a separate Codex sign-in.
Availability, models and limits depend on OpenAI's current policy. The
developer quickstart currently identifies Plus and Pro as eligible plans.
Signing in alone does not approve plan usage.

Verified against OpenAI's documentation on 2026-10-19:

- [Quickstart and availability](https://developers.openai.com/siwc/quickstart)
- [Open-source/local integration](https://developers.openai.com/siwc/token-sharing-open-source)
- [Browser authorization](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, renewal and revocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Codex harness configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

Paid or remotely hosted versions require OpenAI's approval through its
[interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
This integration is for the local open-source application. It does not add
Anthropic subscription support or rely on the unverified Anthropic claims in
the pasted research.

## Connect and use

1. Install a current [Codex CLI](https://developers.openai.com/codex/cli).
   Ambio uses its local harness for tools, sandboxing and conversation history.
   Restart Ambio after installing it.
2. Open **Settings → Agents → ChatGPT** and choose **Continue with ChatGPT**.
   Finish sign-in in the system browser, select a workspace and approve plan
   usage. The callback returns to a temporary listener on `127.0.0.1`.
3. Choose a model in the same settings section. The list comes from the
   account's public `/v1/models` catalog, not Codex's bundled catalog.
4. In a conversation, choose **Deliver to → ChatGPT**. Ask and Propose use a
   read-only project sandbox. Build allows writes in the project, with network
   access disabled for commands. Sandbox escalation requests are declined,
   as with Ambio's existing Codex driver.
5. Use **Manage usage** to inspect plan limits in ChatGPT. There is no fallback
   to API-key billing. A populated model list does not prove that an inference
   request will succeed.

**Add account or workspace** creates a separate registration. Connection
labels distinguish registrations even when email addresses match. Reconnect
reuses the registration; Sign out clears its tokens and attempts remote
revocation. If revocation cannot be confirmed, the interface says so and
directs you to ChatGPT Settings. Changing accounts or signing out stops
Ambio-launched ChatGPT runs. Account changes do not delete Ambio's conversation
history: subsequent agents receive that same conversation, as when changing
any delivery destination.

Delete all Ambio data clears the harness history, while preserving agent
connections, including ChatGPT sign-in, as stated in its confirmation dialog.

## Implementation and storage

`electron/chatgptAuth.ts` independently implements the documented protocol.
OpenAI's reference DevKit uses a noncommercial license and is not bundled or
copied into Ambio. The new dependency is the MIT-licensed `jose` JWT library,
version 5 to support Electron 31's Node runtime.

Each installation persists an opaque UUID host ID. Each registration retains
its issued client ID. Authorization uses fresh state, OIDC nonce and S256
PKCE. ID tokens are verified against OpenAI's signing keys, including issuer,
audience, expiry, subject and authorization nonce. Returning sign-ins and
refreshed identity tokens must match the saved subject. Granted scopes,
rather than successful sign-in, determine plan permission.

Account records, labels, scopes and tokens are encrypted through Electron
`safeStorage` in `~/.ambio/chatgpt/accounts.enc`, with atomic replacement and
owner-only Unix permissions. Linux's unprotected `basic_text` backend is
refused. The host ID is non-secret. Renewal is serialized within the app's
single primary Electron process. Rotated tokens with a new ID token remain
unusable until identity verification succeeds, including after a restart.
Unreadable credential files are preserved, never silently replaced.

The main process renews credentials before each turn and passes the access
token only in the harness child's environment. Arguments, receipts and
renderer IPC never contain it. The token is excluded from the harness's shell
environment and cleared in Ambio's MCP child environment. Raw app-server
stdout/stderr is not logged; parsed activity is redacted before logging.
These boundaries do not protect against arbitrary code already running in
the trusted main or harness process.

The harness has a separate `CODEX_HOME` per account registration under
`~/.ambio/chatgpt/harness/`. It uses the public Responses API with OAuth and
HTTP/SSE. Shell and local MCP tools remain in Codex. Ambio retains launch
receipts, Stop, activity events and conversation replies through its existing
delivery and MCP interfaces. Harness sessions are keyed by project,
conversation and account registration. Only `turn/completed` with status
`completed` marks successful inference.

## Verification

Automated coverage uses synthetic signed tokens, encrypted temporary storage,
mocked OpenAI endpoints and a real stand-in app-server subprocess. It covers
PKCE and callback state, denied/cancelled consent, nonce verification, scope
gating, same-email registrations, reconnect, model selection, serialized
rotation, recovery after rotation, sign-out, encryption failures, thread
resume, permissions, protocol failure and token-free logs.

Validation in this workspace: TypeScript, 656 unit tests, 34 MCP end-to-end
tests against a freshly built daemon, three headless Electron UI tests, the
production bundle and the dependency license check passed. The installed
Codex CLI 0.159.0-alpha.3 also completed a turn against a local synthetic
Responses API, sending bearer authentication, `store: false` and
`stream: true`. That checks harness wiring, not OpenAI account entitlement.

A live account sign-in and completed inference were **not** run in the coding
environment. Release validation must cover:

1. Browser sign-in with an eligible account on macOS, Windows and Linux with
   an OS credential store. Confirm the displayed account and plan permission.
2. One short Ask turn answered through Ambio's MCP inbox. Confirm the chosen
   model completes and usage appears under Ambio in ChatGPT Settings.
3. Propose, then Build in a disposable project. Verify mode limits, map tools,
   canvas reply, continued thread and Stop.
4. Restart Ambio, renew an expired token, switch registrations and reconnect
   after sign-out or remote revocation.
5. Denied plan permission, exhausted usage, interrupted network and denied OS
   storage. Confirm that errors preserve data and never use API billing.
   Check credential-store access after a packaged-app upgrade.
