# ChatGPT Windows live smoke — 2026-10-20

Windows development build based on `a055a86`, with the stream-header fix on
`codex/chatgpt-live-smoke`. The user completed browser authorization using a real
account. Ambio ran from a separate worktree with an isolated application profile
and a disposable TypeScript project. The other coding session's checkout and
the user's normal Ambio data were not changed.

## Results

| Check | Result |
| --- | --- |
| System-browser OAuth callback and verified account | Passed; Settings showed plan usage enabled |
| Account-specific model discovery | Passed; selected `gpt-6.1-sol` |
| Credential and conversation persistence across app restart | Passed; saved connection and history reopened without another sign-in |
| Direct main-process inference | Passed; HTTP 200, completed stream, expected short reply |
| Native OpenCode inference through the credential proxy | Passed after the stream-header fix |
| Visible native Ask response | Passed; the app displayed `AMBIO_CHATGPT_OK` and returned to idle |
| Native follow-up history | Passed; the next turn recalled the previous reply |
| Native local tool round trip | Passed with the controlled MCP fixture; `ambio_get_architecture` completed and the next model response used its result |
| Live Propose with the real Ambio MCP server | Passed; created `Greeting smoke plan` with a file member and a reviewable comment-only note; source remained unchanged |
| Live Build from that plan | Failed before inference: the first native work order references a daemon thread that has never been created; source remained unchanged |

## Failure found and fixed

The original native Ask failed even though the account had plan permission.
Electron's `net.fetch` exposed a successful OpenAI Responses stream with a body
and **no Content-Type header**. The body contained valid SSE ending in
`response.completed`, but `ChatProviderProxy` rejected the missing header before
reading the stream.

The proxy now permits an absent header, labels the downstream response as
`text/event-stream`, and keeps the existing event validation and completion
requirement. An explicit incompatible content type still fails. JSON or an
interrupted stream without a header cannot become a successful inference.

Regression coverage checks the missing-header response, malformed content and
explicit JSON content types; the bundled OpenCode test now receives a follow-up
stream without a Content-Type header.

## Separate Build blocker

The UI returned HTTP 409 with “message changed, claim expired, or another agent
owns it” when creating the first Build work order in the native conversation.
`AgentChatPanel.tsx` sends `threadId: chatThreadId(id)` (a `chat:` native-session
identifier), while `EnqueueCanvasMessage` in `archd-go/internal/db/sheets.go`
requires a previously existing thread whenever `threadId != message.id`.
Ask and Propose do not create a daemon inbox turn, so this first Build has no
such thread. The request never reached the model and the fixture git diff
remained empty. This path is unchanged from main `99f8068`; it is recorded as
`native-chat-first-build-thread`, separately from the ChatGPT transport fix.

## Local verification

- `npx tsc --noEmit`: passed.
- `npm run test:renderer`: 675 passed, 1 skipped, no failures.
- Focused Responses and bundled native ChatGPT tests: 5 passed.
- `npm run build` and the Windows daemon build: passed.
- Earlier focused OAuth/Responses validation: 12 passed.

No daemon, MCP or renderer implementation changed. The previously recorded
`proposal-placement-rejection-e2e` failure on unchanged main was not rerun.

## Test setup and remaining release checks

Do not give the system browser the temporary `APPDATA`/`LOCALAPPDATA` values
used by headless Electron UI tests: Chrome treats them as a new browser profile
and opens its first-run screen. This run instead isolated Ambio with
`--user-data-dir` and the project's temporary home while leaving the normal
browser profile locations intact.

The callback currently serves plain text; `chatgpt-callback-polish` records the
user's request to make it readable and branded. Setup's misleading “Your API
key” wording for this OAuth connection is recorded as `chatgpt-setup-label`.

This is development-build evidence, not packaged cross-platform release
validation. Packaged macOS/Windows/Linux launches and upgrades, locked OS storage,
long-lived token renewal, multiple registrations, real usage-limit errors,
cancellation and remote revocation remain in `chatgpt-native-live-validation`.
The test connection is left signed in for further manual testing.
