# ChatGPT plan usage in native Ambio chat

Eligible users can connect a ChatGPT plan directly to **Ambio chat**, the
built-in OpenCode-based agent. OpenAI inference uses the public Responses API.
No Codex CLI, separate Codex login or OpenAI API key is required. The existing
native chat, local tools, history, modes and action approvals remain in use.

## Connect and use

1. Open **Settings → Agents → Ambio chat → ChatGPT** and choose **Continue
   with ChatGPT**. Finish browser sign-in, select a workspace and approve plan
   usage. Signing in without plan permission does not enable inference.
2. Choose a default ChatGPT model. **Refresh models** updates the account's
   catalog from OpenAI; the conversation's model menu offers those models.
3. Start a conversation and choose **Ambio chat · ChatGPT · Connection …**.
   The composer shows **Using ChatGPT plan** and **Manage usage**.
4. Chat normally. Ask, Propose and Build retain the native agent's existing
   tool permissions, work-order behavior and approvals. Requests share the
   account's plan limits. There is no fallback to API billing or another
   connected account.

Each registration has a stable Connection label and distinct provider ID,
including registrations with identical email addresses. A conversation stays
bound to its original registration. Selecting a different account in settings
changes the account being managed, not an existing conversation's identity.
Reconnect reuses the issued client ID; adding an account or workspace creates
another registration. Model-service changes require active turns to stop.

Sign out removes that registration's local tokens and attempts remote
revocation, while retaining its registration and existing conversation
history. Ambio reports if revocation cannot be confirmed; disconnect it in
ChatGPT Settings in that case. Delete all Ambio data removes both chat history
and local ChatGPT connections, but does not itself revoke remote grants.

## Credentials and request handling

`electron/chatgptAuth.ts` independently implements the published SIWC OAuth
protocol. It uses fresh state, nonce and S256 PKCE, a stable installation host
ID, issued per-registration client IDs and signature-verified OpenID tokens.
Identity issuer, audience, expiry, nonce and returning subject are checked.
Granted plan scopes determine whether a connection can run requests.

Accounts and credentials use Electron's OS-backed `safeStorage` in
`~/.ambio/chatgpt/accounts.enc`, with atomic writes and owner-only Unix
permissions. Linux's unprotected storage backend is refused. There is no
plaintext fallback. Refresh is serialized by the app's primary process;
rotated tokens requiring identity verification remain unusable until that
verification succeeds, including after an interrupted refresh and restart.

`ChatProviders` exposes each account as a managed native model service.
Tokens are not copied into the API-key provider file. The existing
`ChatProviderProxy` resolves the conversation's original account and renews
its token before each upstream request. OpenCode receives only a temporary
loopback proxy capability. OpenAI tokens never enter its environment, tool
context, renderer state or history.

Subscription requests are restricted to the public model-list and Responses
endpoints. `chatgptResponses.ts` enforces `store: false`, `stream: true`,
complete input history, supported request fields and namespaced local tools.
Tool outputs and encrypted reasoning remain in the native conversation's
context. Only a completed response establishes successful inference. Failed,
incomplete or interrupted streams produce an actionable error, and Ambio
stops that native turn to prevent automatic replay of a partial plan request.
Credential echoes are redacted before reaching the harness or its history.

The previous Codex app-server adapter and separate ChatGPT CLI destination
have been removed. Existing users' external Codex/MCP connections are unaffected.
OpenAI's noncommercial reference DevKit is not bundled or copied into Ambio;
the OAuth implementation uses the MIT-licensed `jose` library.

## Validation and remaining live checks

Automated coverage uses synthetic signed tokens and temporary encrypted
storage. The real bundled OpenCode binary is tested against mocked OpenAI
Responses streams through the actual credential proxy: native inference,
namespaced Ambio MCP tools, follow-up history and interrupted-stream failure.
UI tests cover consent, model selection, account switching and sign-out.
Existing API-key/native chat and external agent routes are regression-tested.

A real OpenAI account sign-in and subscription inference were not run in this
environment. Before release, validate browser consent and one completed native
Ask/Propose/Build loop with an eligible plan, then check attribution and limits
in ChatGPT Settings. Also verify renewal, remote revocation, account switching,
usage-limit errors, cancellation, locked OS storage and packaged-app upgrades
on macOS, Windows and Linux.

## Official references

Verified against OpenAI documentation on 2026-10-19. The developer quickstart
currently identifies Plus and Pro as eligible. Models and limits depend on
account eligibility and OpenAI policy. Paid or remotely hosted applications
require separate approval; this integration targets the local open-source app.

- [Quickstart and availability](https://developers.openai.com/siwc/quickstart)
- [Open-source/local integration](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, renewal and revocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and direct Responses requests](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview requirements and limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Commercial/hosted interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)
