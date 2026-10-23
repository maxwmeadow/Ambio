# Canvas inbox protocol

Canvas instructions and replies are durable project records. Reading never resolves work.
An atomic claim grants one agent temporary ownership. Explicit replies submit for review;
expired claims make unfinished work available again. Retries must not duplicate sends or replies.

The agent binds to a workspace once, using an explicit workspace or its working directory.
Changing the desktop's active project cannot redirect an existing connection or reply.
The renderer reloads history on project changes and reconnects; live events only accelerate refresh.

## Human workflow

Open **Message agent** on the canvas, select one or more files, systems, infrastructure
nodes, or planned nodes, and send an instruction. The panel remains open while selecting.
Selections use canonical IDs with a display label captured at send time. Active sheets
attach their original context and approved build specification. Selecting nothing sends
a project instruction. Drafts and uncertain sends are saved per workspace.

Sheets can now be selected explicitly with **Attach a sheet**, independently of the
active canvas. The attachment includes a structural comparison snapshot. See
[SHEET_WORKFLOW.md](SHEET_WORKFLOW.md) for comparison, implementation and checked resolution.

Each new canvas send creates an **addressed work order** with a durable ID. Copy the
handoff from that particular message and paste it into the agent chat you choose.
The full ID remains visible and selectable on the message if clipboard access fails.
The agent calls `get_inbox({messageId: "…", expectedWorkspaceId: "…"})` to claim
exactly that request. A mismatched MCP workspace fails before any claim. This is
the universal route for two different harnesses, or two chats in the same harness:
MCP does not tell Ambio which human chat owns a connection. The request ID selects
the task; a connection lease prevents a different connector from claiming it at
the same time. The ID is routing information, not an access-control secret or proof
of the chat's identity. A connector already holding a lease can renew that request.
The inbox displays a short connector fingerprint on picked-up work so two terminals
using the same harness are distinguishable; it does not claim to identify a chat
when a harness shares one MCP process across chats.

Older open-queue messages remain claimable with `get_inbox()` and are never silently
converted. New addressed work does **not** appear in an unspecific inbox check or
legacy outbox read. Delivery passes its exact ID to one chosen host. The handoff asks
the agent to handle only that work order; it does not invite queue draining. There is
no reliable cross-harness hook that selects an existing human chat. Installers that support skills
also install `ambio-inbox` beside `ambio-map`;
manual language remains the universal entry point. Installing is optional for an already
connected agent. No hook, slash-command convention, or permanent polling loop is required.

After a send, the request card exposes its ID and a copyable project-named prompt
to paste into the agent's own chat. **Connections** reopens setup without leaving the
project. The signal distinguishes an MCP process currently online from one that has
successfully called an Ambio tool in this workspace. A configuration found on disk,
an incomplete installer workflow, and unavailable status have separate states.
Blank-project setup provides a copyable `get_inbox({verifyOnly: true,
expectedWorkspaceId: "…"})` check and opens the canvas after the selected host
completes it. The check returns `inboxReady` without claiming a work order or
consuming queued human messages. Verification lasts only for that process's live
presence lease; a new process must make its own tool call. A verified MCP connection
is not evidence that the model has read a message; only
the message's **Picked up** state indicates a claim. Neither state proves ongoing code
work. Agents can use `start_work`/`update_work` to make substantial work visible in
Morning Delta and on the original request card, while normal indexing updates
the live canvas as files change. For addressed work, `start_work` takes the
`messageHandle` from `get_inbox` and returns a session ID. `update_work` takes
that session ID so two chats sharing one MCP process cannot overwrite each
other's progress. An omitted session ID works only if that process has one
active session in this workspace. The session link, notes, and summary survive
restarts and remain visible with the request history.

The same `get_inbox` and `reply_to_canvas` tools are exposed to every configured MCP
host. Claude Code, Copilot VS Code/CLI, Codex, Grok Build, Muse Code, Cursor, Windsurf, and Antigravity
install a reusable inbox skill; Claude Desktop, JetBrains, and Zed use the copyable
natural-language prompt and MCP tools without a skill dependency. The installer
checks both skill files before marking a skill-capable host ready. The local installer
matrix verifies generated configuration and workflow files; it does not prove that
every installed vendor version has loaded or enabled its MCP tools. A live presence
signal and a successful claim/reply are the stronger end-to-end checks.

The panel distinguishes waiting, picked up, submitted for review, accepted,
changes requested, cancelled, and expired claims.
Picked up means the connector claimed the instruction, not proof of ongoing model work.
Replies remain visible after restarting Ambio or deleting the originating canvas objects.
Cancellation prevents acceptance of a later reply; it cannot stop an external coding
process. The panel tells the user to stop that agent separately if necessary.

## Conversations (2026-10-13)

A request is a turn in a conversation. `canvas_outbox.thread_id` groups turns
(the first turn's own ID) and `mode` records what the turn asks for: `ask`,
`propose` or `build`. A message from before threads is a conversation of one.
Built-in chat keeps its conversation in Electron and groups its work orders
under `chat:<native session ID>`. Its first addressed Build can create that
reserved thread without a prior inbox turn; later Builds continue it. Other
unknown thread IDs, open requests and non-Build turns cannot create one this way.
The panel shows one conversation at a time; the composer continues it, and
**New conversation** starts another. The mode is chosen per turn, so asking,
asking for a plan and ordering the build are three turns of one conversation.

**Ambio keeps the conversation, not the host.** No supported host lets another
program put a prompt into an existing human chat, and not every host can
continue its own session. So the agent that claims a turn is handed the
earlier turns with it: `get_inbox` returns `conversation`, oldest first, each
turn with its mode, the request, the agent's reply and the user's review. The
last 20 turns are sent, each request and reply clipped to 6,000 characters;
`conversationOmitted` counts older ones. Cancelled turns are left out. This
works the same for a started run, a pasted handoff and a different host.

**Session continuity is an optimisation on top.** For a host Ambio starts, the
runner keeps the host's session ID per conversation and host
(`~/.ambio/delivery/sessions.json`) and continues it on the next turn. A
session that cannot be continued (expired, removed) starts the same turn fresh
when the agent had said nothing; the conversation still reaches it through
`get_inbox`.

**The mode is the permission.** A question or a proposal may read the code
and use Ambio's tools; only a build may change files. Each driver maps that to
its host (`electron/agentDrivers.ts`) and passes it on every turn.

| Host | Started as | Continues a session | Ask / Propose | Build |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json` | `--session-id` on the first turn, `--resume` after | `--permission-mode bypassPermissions` with `--disallowedTools Edit,Write,MultiEdit,NotebookEdit` | `bypassPermissions` |
| Codex | `codex exec --json`, Ambio's MCP server set to `default_tools_approval_mode="approve"`, reasoning summaries on (`model_reasoning_summary="auto"`, shown as the turn's thinking) | `codex exec resume <thread>`, sandbox given as `-c sandbox_mode=` (resume has no `--sandbox`) | read-only sandbox; on Windows `danger-full-access`, because the read-only sandbox cannot start a shell there (`codexSandbox`) | `danger-full-access` |
| Copilot CLI | An ACP session (`copilot --acp`, a public preview); `copilot --prompt` when it cannot hold one | In the ACP session; print mode reports none | `--allow-all-tools --allow-all-paths --allow-all-urls --deny-tool write` | `--yolo` |
| Cursor CLI (experimental) | `cursor-agent -p --output-format stream-json` | `--resume=<chat>` | `--mode ask` / `--mode plan` | `--force` |
| Antigravity CLI (needs Ambio added to Antigravity: it reads MCP servers only from `~/.gemini/config/mcp_config.json`; Ambio refuses to start it otherwise, `RUN_NEEDS_INSTALL`) | `agy -p <prompt> --output-format stream-json --add-dir <project>` | `--conversation <id>` | `--dangerously-skip-permissions`; it has nothing narrower, so the turn's contract keeps it from editing | `--dangerously-skip-permissions` |
| Devin CLI, Antigravity agent (experimental) | An Agent Client Protocol session (`devin acp`, Google's `agy_acp_server`) | `session/resume` or `session/load` when the agent offers it | Agent's ask/plan mode; edit, delete, move and execute requests are refused | Permission requests are allowed |

The experimental rows are offered only when their editor (Cursor, Windsurf,
Antigravity) is set up with Ambio and the CLI is found.

What has been run for real (`mcp/e2e/conversation.live.mjs`, 2026-10-15):

- **Claude Code 2.1.198:** passes four turns: claim and reply, a follow-up
  answered from the conversation in the same session, a question that changed
  nothing, an unlisted command asked about and run once allowed, and a listed
  check run without a question.
- **Codex 0.162.1:** passes three turns, continuing its session. Needed:
  Ambio's server approved (`approval_policy="never"` otherwise refuses every
  MCP call) and the sandbox passed as config on resume. One resumed build hit
  a Codex Windows sandbox error ("setup refresh had errors") once and passed
  on the next run.
- **Antigravity CLI 1.0.16:** answers questions through Ambio, including the
  follow-up, once the project is named with `--add-dir` and `mcp(ambio/*)` is
  allowed (rule form from antigravity.google/docs/permissions). A build that
  needs a shell command fails: print mode refuses the command and ends the
  run; Ambio says so on the turn.
- **Gemini CLI:** removed. Google moved it into Antigravity and refuses it for
  personal accounts (seen with 0.39.1).

- **Copilot CLI 1.0.98:** passes three turns as an ACP session, continuing
  the same session, with the build's shell command put to the user and run
  once allowed. Its ACP server ignores MCP servers named in `session/new`, so
  Ambio's is passed with `--additional-mcp-config` when it starts.

Cursor CLI, Devin and Google's Antigravity ACP server are not installed. Those were written from
each vendor's documentation and tested against stand-in agents. Pasted
destinations (Claude Desktop, Windsurf, Antigravity, JetBrains, Zed) and
Cursor's deep link have not had a live conversation run; VS Code's link has.
Test status stays here: the panel's info button (`DESTINATION_GUIDE`) only
tells the user how to use each destination and what it can do.

**Permissions (for now: full access).** Nobody is at a started agent's
keyboard, and a refused step ends the turn, so agents Ambio runs are given every
permission they offer (decision 2026-10-19). Most Build routes run
unrestricted; Muse preserves its native sandbox/profile. The settings are: Claude
Code `--permission-mode bypassPermissions`, Codex `--sandbox
danger-full-access`, Copilot CLI `--yolo`, Antigravity CLI
`--dangerously-skip-permissions`, Cursor CLI `--force`, Grok `--sandbox off`,
Muse MSP `allowAll` with its configured sandbox, and ACP agents have every
request approved. Ask and Propose may run commands but lose file editing where
the agent allows it: Claude Code `--disallowedTools Edit,Write,…`, Codex's
read-only sandbox (except on Windows, where it cannot start a shell; decision
2026-10-20), Copilot `--deny-tool write`, Cursor's ask/plan modes, ACP
edit/delete/move refused. Antigravity has nothing narrower, so its Ask and
Propose also skip permissions and rely on the turn's contract. Grok uses its
read-only sandbox plus ACP edit refusals for Ask/Propose; Muse relies on the
turn's no-edit contract for those modes. Each guide says
this. The permission desk (`POST /api/agent/permission`, `approve_action`)
remains for the per-agent permission settings planned in WORK.md
(`agent-permission-modes`).

**Live activity.** A driver reads the host's output for what the agent says,
does and thinks (its reasoning, where the host reports it; see ARCHITECTURE). The runner keeps up to 400 events per run beside its log
(`<key>.events.jsonl`) and the panel shows the latest under the working turn.
The reply through `reply_to_canvas` is still what decides a turn is answered;
a clean process exit is not.

**Agent Client Protocol.** `electron/acpClient.ts` is a client for
[ACP](https://agentclientprotocol.com): JSON-RPC over the agent's stdio.
Ambio gives the agent its MCP server for the session (`session/new`
`mcpServers`), sets the agent's own mode to match the turn, answers
`session/request_permission` by the turn's mode, and offers the agent no file
system or terminal of its own. Grok additionally authenticates using an
advertised headless method and a bounded handshake. Muse uses its published
Session Protocol instead (`electron/museClient.ts`), with the same runner,
per-session MCP identity, saved conversations, events and stop behavior.
Its Ask/Propose restriction is prompt-based. Build uses `allowAll` approval
mode while keeping Muse’s configured sandbox/profile and project trust.

**Watching (opt-in).** A user can tell a session they already have open to
watch Ambio. That session calls `get_inbox({watch: true})`, which waits up to
45 seconds for an open request and reports the wait as presence
(`watchingUntil`). While a session is watching, **Deliver to** offers
**Session watching Ambio**: the turn is saved as `open` instead of addressed,
and the watching session picks it up with its own chat intact, then calls
again. Nothing waits unless the user asked for it.

Choosing a host that has a session watching sends to that session too
(`targetHost` limits the open turn to that host's connections), in preference
to starting a new run. This is how the hosts Ambio cannot start (Claude
Desktop, Copilot in VS Code, Cursor, Windsurf, Antigravity, JetBrains, Zed)
hold a conversation: **Deliver to** copies a handoff once that also asks the
chat to stay attached, and every later turn reaches that chat directly.

VS Code and Cursor document a link that opens their chat with a prompt in it
(`vscode://GitHub.Copilot-Chat/chat?prompt=`, Cursor's prompt deeplink), so
for those two the first handoff is placed in the chat instead of pasted
(`chatDeepLink`). Seen in VS Code (2026-10-15): the first time it asks to
allow GitHub Copilot to open the link, then opens Copilot Chat with the
handoff filled in, in Ask mode for an Ask turn, and waits for the user to
send it. Opened on its own, the link does not bring VS Code forward; Deliver
opens the project first, which does. Cursor's link is unconfirmed. The remaining hosts
document no such route, and the clipboard handoff remains theirs.

## Delivery routes (2026-09-30)

**Deliver to** lists all twelve installer modalities. The default is **Choose chat
manually**, preserving the existing workflow. Choosing a CLI with a launch driver makes Send save the
request first, then start a fresh local run; choosing an MCP-only CLI or editor/desktop host copies
the same handoff and opens the project/app when its launcher is available. The
request card can deliver an already-saved request, including one reopened with
review feedback. An editor launch is labelled **work has not started yet**.

| Supported host | Headless / hook / chat options investigated | Route built in Ambio |
| --- | --- | --- |
| Claude Code (CLI, shared config with VS Code/JetBrains extensions) | `claude -p`; `SessionStart` and `UserPromptSubmit` can inject context on host activity, but do not select a conversation on Send | Start a new CLI run with per-run MCP config |
| Claude Desktop | No documented external API for starting a specific existing chat; MCP connections can be shared | Copy + open Claude on macOS when installed; copy on other platforms |
| Copilot in VS Code | `code chat` supports a prompt, agent mode, and new/reused windows. A new chat window is empty; a reused window can belong to another project | Copy + open this project in VS Code; paste into the chosen chat |
| Copilot CLI | `copilot -p`, per-session `--additional-mcp-config`, and named tool permissions | Start a new CLI run with per-run MCP config |
| Codex (CLI, shared config with IDE extension/app) | `codex exec`, stdin prompts, workspace-write sandbox, `-c` MCP overrides; CLI worktree support varies by version | Start a new CLI run with per-run MCP config |
| Grok Build CLI | `grok agent stdio` (ACP), vendor-owned login and `grok models` | Start/resume a CLI session with per-session MCP, events, model selection and Stop; signed-in live trial pending |
| Muse Code CLI | `muse serve` (MSP v1), vendor-owned login and `model/list` | Start/resume a CLI session with per-session MCP, events, model selection and Stop; signed-in live trial pending |
| Cursor | Separate Agent CLI has headless mode; editor hooks are tied to user/agent activity. No verified public route to a particular existing editor chat | Copy + open this project in Cursor when its launcher is found |
| Windsurf / Devin Local | Cascade hooks can observe activity; no verified external prompt route selecting a project and chat | Copy + open this project in Windsurf when its launcher is found |
| Antigravity | Its IDE MCP setup is separate from Gemini CLI. Gemini's documented `-p` mode does not establish an Antigravity chat-delivery API | Copy + open this project when the `antigravity` launcher is found |
| JetBrains AI Assistant | IDE/project links open projects or files; no verified public link that submits a prompt to the chosen AI chat | Copy + open this project in a detected JetBrains IDE |
| Zed | Agent panel and MCP support; no verified external route to a particular panel conversation | Copy + open this project in Zed when its launcher is found |

All editor/desktop rows fall back to **Copy for host** if no launcher is found.
Missing CLI executables are shown explicitly; the generic copy handoff always
remains available. A configured MCP file alone does not prove a runnable CLI.
Discovery covers native executables, common GUI PATH gaps, and known npm JS
entrypoints (including Windows), without interpolating a prompt into a shell.

Sources: [Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex noninteractive mode](https://developers.openai.com/codex/noninteractive),
[Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[VS Code CLI](https://code.visualstudio.com/docs/configure/command-line),
[Cursor headless mode](https://cursor.com/docs/cli/headless),
[Windsurf hooks](https://docs.windsurf.com/windsurf/cascade/hooks),
[Antigravity MCP](https://antigravity.google/docs/mcp),
[JetBrains MCP](https://www.jetbrains.com/help/ai-assistant/mcp.html),
[Zed MCP](https://zed.dev/docs/ai/mcp). Codex's installed CLI help, upstream
Copilot/VS Code references, and Claude's upstream changelog were also inspected.
Unverified chat routes are deliberately not offered as automatic delivery.

### Why hooks, notifications and elicitation are not dispatch

MCP resource `list_changed` notifications announce a changed resource catalogue;
they do not submit a user message or choose a chat. Ambio currently exposes tools
and prompts, not a work-order resource subscription. Hosts vary in whether they
surface resource notifications in model context. Elicitation, where a client
supports it, asks the human for input during a tool interaction; it is not a
portable API for starting an agent turn. Neither is used as a delivery guarantee
for any host in the table. Host hooks can provide a reminder on the next session
or prompt, but blindly exposing all addressed work to every session would undo
the request-ID routing. They remain complementary options, not queue drainers.

### Run ownership and failure behavior

The privileged Electron handler reloads the registered project and reads exactly
the requested message from archd before starting anything. Closed work, legacy
open-queue work, wrong-workspace requests and live claims are refused. The process
runs in that project's existing root, or in a worktree of its own when Send's
*Own worktree* is chosen; inline MCP configuration and environment
pin its workspace and host. It must claim before editing and renew before the
15-minute lease expires. A race with another claimant is still fenced by MCP.

Direct runs use the host's existing account, with the permissions in the table
above: for now every agent Ambio runs gets full access (decision 2026-10-19), so a
turn never stops on a step nobody is there to approve. User-chosen permission
levels are planned (WORK.md `agent-permission-modes`).

One managed run may edit a root at a time. A launch receipt in
`~/.ambio/delivery/` is keyed by workspace, request and review revision, and saved
before spawn. Double clicks and renderer reloads return that receipt. Only a
confirmed spawn failure is automatically retryable; a process that ran and failed
or was interrupted is never silently rerun. Requesting changes creates a new
review revision and permits a fresh run. After an app crash an old live PID blocks
another managed run until the previous agent has been checked/stopped separately.

The inbox distinguishes process launch/exit from claim/reply. Exit code zero alone
does not mark a request answered. Output is kept locally (up to 1 MiB per run),
with **Show agent output** and **Stop run** controls. Stop terminates the managed
process tree where supported, keeps edits already made and does not cancel the
durable request or release its MCP lease. Ambio asks managed runs to stop on quit.
Manual handoff remains available for recovery and unsupported chat integrations.

A new worktree is not created automatically: Ambio's comparison follows the live
graph root, so reviewing a different worktree would be misleading. Isolated-run
projection and live authenticated provider smoke tests are tracked in WORK.md.
The automated UI test exercises real Electron IPC and child processes with
simulated CLI agents and an editor launcher; it does not certify provider auth,
model behavior, or every OS launcher installation.

## Work-order review

`reply_to_canvas` submits the agent's answer for user review. Its optional `result`
lists a commit, changed files, checks with outcomes, and remaining gaps. These are
**agent-reported claims**, not independently verified test results. The work-order
details show linked sessions and the current live sheet comparison separately;
the comparison is an Ambio structural check of the current graph, not proof of
runtime behavior or the graph at the moment of submission.

The user can **Accept result** or **Request changes** with feedback. Acceptance is a
durable review event. Requesting changes archives the previous submission, ends
any open work sessions for that order, clears its claim, and queues the same order
for another explicit handoff. The next claimant receives the latest review feedback;
prior submissions and their reported results remain visible in history. A later
submission is again ready for review. Review calls carry a client-generated review
ID so retries do not duplicate a decision. Acceptance does not merge code or prove
every requirement. Reopening does not stop an external agent already editing files.

## MCP contract, version 1

- `get_inbox({messageId, expectedWorkspaceId})` checks the bound workspace and
  atomically claims that exact addressed instruction in the
  bound workspace. `get_inbox()` claims at most one legacy/open instruction. The same
  connector gets its existing live claim back and renews it. Other connectors cannot
  claim that instruction until its lease expires. An empty open queue returns immediately.
- `get_inbox({watch: true})` waits up to 45 seconds for an open instruction, only for a
  session the user asked to watch. A claim by ID, a context read and a connection check
  never wait.
- A claimed message carries `threadId`, `mode` and, when there are earlier turns,
  `conversation` (see Conversations).
- `get_inbox({verifyOnly: true, expectedWorkspaceId})` checks the bound workspace and
  returns `inboxReady`, workspace identity, connection ID, and host ID without claiming
  work. A check cannot include a `messageId` or `messageHandle`.
- Responses include `protocolVersion`, explicit workspace identity/root, selected targets
  (type, ID, original label), claim expiry, and an opaque `messageHandle`.
- `get_inbox({messageHandle, contextOffset: 0})` fetches original context in pages of at most
  12,000 Unicode characters. Continue from `nextOffset`; `-1` means complete. Fetching
  context does not claim another instruction. The handle must still own the message.
- `reply_to_canvas({messageHandle, body})` writes one submission and closes the active claim
  in one transaction. Identical retries return the original reply, including after expiry.
  A different body, wrong token, cancellation, or reassignment returns a conflict.
- `reply_to_canvas({messageHandle, body, result?})` may attach structured agent-reported
  evidence to the submission. The report is preserved if the order is reopened.
- `start_work({goal, messageHandle})` validates the live claim and links a
  durable work session to that request. A retry by the same MCP process resumes
  its open session. A new connector taking over the request ends the previous
  session and starts its own; prior notes remain in the request history.
- `update_work({sessionId, note})` and `update_work({sessionId, done: true,
  summary})` address one session. Calls without `sessionId` fail if several
  sessions are active in the same MCP process.
- Text content and structured MCP content carry the same result. Tool errors stay errors;
  a daemon outage never means an empty inbox.
- `review-canvas` is a reusable MCP prompt that describes this workflow. Retrieving a
  prompt never reads or claims user work. Legacy read names remain executable but no
  longer implement a destructive drain or a long-running wait.

Each claim lasts 15 minutes. Explicit `get_inbox({messageId})` calls renew an addressed
claim; passive connector
presence does not. An idle MCP process can outlive the conversation, so renewing work
from presence alone would strand messages indefinitely. Agents are instructed to renew
before expiry and check ownership before continuing after interruption.

This provides at-least-once delivery and idempotent final replies. It does not guarantee
exactly-once edits in an external repository. A stale agent can still modify files outside
Ambio. Claim tokens fence Ambio replies, not third-party tools or shell commands.

## Storage and HTTP

The existing `canvas_outbox` remains the dispatch record so Morning Delta retains its
historical context. `canvas_claims` owns the temporary lease and attempt counter;
`canvas_replies` owns the durable final answer, with one row per message. Replies do not
depend on annotations or sheet foreign keys. Database triggers constrain message states.

SQLite `BEGIN IMMEDIATE` serializes claims and replies. Claim selection and assignment
are one transaction. Reply insertion and resolution are another. A client-generated send
ID makes retries safe, including concurrent sends. Reusing an ID with different instruction
content is a conflict. The renderer preserves the original payload and ID while a send's
outcome is uncertain, including across reloads.

Endpoints (all require the local bearer token):

| Endpoint | Behavior |
| --- | --- |
| `POST /api/canvas/send` | Save `{id, workspaceId, note, selection, sheetId, deliveryMode: "addressed", codeFitFileIds?}`; omitted mode remains legacy `open`. `codeFitFileIds` (≤200) freezes where the code disagrees with the map for those files; history and the reply then carry `codeChecks`, re-checked against the indexed code |
| `POST /api/canvas/claim` | Claim/renew using `{workspaceId, connectionId, agent, messageId?}`; no ID sees only `open` work |
| `POST /api/canvas/context` | Read a context page using `{workspaceId, msgId, leaseToken, offset}` |
| `POST /api/canvas/reply` | Resolve using `{workspaceId, msgId, leaseToken, body}` |
| `POST /api/canvas/cancel` | Cancel unresolved work using `{workspaceId, msgId}` |
| `POST /api/canvas/review` | Accept or reopen a submission using `{workspaceId, msgId, reviewId, decision, note?}` |
| `GET /api/canvas/history?workspace=…&before=…&limit=…` | Newest-first history; stable `(createdAt,id)` pagination |
| `GET /api/canvas/message?workspace=…&messageId=…` | Inspect exactly one request for delivery, without claiming or exposing its lease token/context |
| `GET /api/canvas/outbox?workspace=…&peek=1` | `queued` total and `open` count; only `open` drives generic discovery hints |
| `GET /api/agent/workspace?cwd=…&workspace=…` | Resolve persisted project/root identity |

Limits: 128 KiB request body; 16 KB instruction; 64 KB reply; 100 validated selections;
2 MiB attached context; 100 history entries per page (default 50). History excludes large
context snapshots and lease credentials. It reads messages, claims and replies together
from one SQLite snapshot. Unknown JSON fields, invalid targets, malformed input and
oversized bodies fail explicitly. A sheet revision change during context preparation
is avoided by reading attached context and comparison in one database transaction.

History is retained rather than silently deleted: closed dispatch snapshots also explain
historical architectural intent. Pagination and indexed reads bound browsing costs. An
explicit archive/retention policy can be added later without deleting open work.
The toolbar's available count covers the entire queue, independently of the loaded page.
The existing SQLite WAL/NORMAL synchronization policy is retained: process restarts are
covered, but an abrupt OS or power failure can lose recent uncheckpointed commits. This
change does not claim stronger hardware-level durability than the project's database.

## Workspace identity and local connection

Each MCP process binds once after its first successful resolution:

1. `AMBIO_WORKSPACE_ID`, if explicitly configured.
2. An explicit `AMBIO_ACTIVE_PROJECT` file (used by isolated harnesses).
3. Otherwise the longest registered root containing the process working directory,
   including persisted worktree roots. Equal matches in different projects fail visibly.

For a host without a meaningful working directory, configure a workspace ID, or explicitly
opt into the desktop pointer with `AMBIO_USE_ACTIVE_PROJECT=1`. The pointer is still read
only at binding time; start a new MCP connection to choose another workspace. Changing
the desktop's project cannot redirect a running agent's calls or replies.

The daemon generates a local random capability in `<data>/api-token` (0600 on POSIX).
Electron adds it from the main process to its own daemon requests; page scripts never
receive it through IPC. MCP reads the same file and uses a 15-second request deadline.
Overrides are `AMBIO_API_TOKEN` or `AMBIO_API_TOKEN_FILE`; `AMBIO_API_URL` must remain
loopback HTTP. The token protects against unrelated browser pages and unauthenticated
clients, not another process already running with the user's filesystem permissions.

Upgrade the daemon, desktop and MCP bundle together and restart agent connections.
Older raw HTTP integrations must provide bearer authentication. Existing manually
configured MCP paths remain usable after rebuilding that entry point.

## Renderer recovery and isolation

WebSocket subscriptions require a workspace. The hub filters by workspace and assigns
contiguous sequence numbers per connection. Core indexing, layout and sheet events carry
workspace identity. Any legacy anonymous event becomes an invalidation hint rather than
an anonymous cross-project mutation. The renderer also rejects foreign workspace events.

Project switches immediately clear conversation and selection state. Opening the inbox,
reconnecting, and canvas-message events refetch durable history. A five-second refresh
also repairs missed events and shows expired leases. Concurrent history refreshes share
one bounded request, and stale project responses cannot enter the new workspace. Graph
changes during a snapshot resync schedule another resync rather than getting lost.
Refreshing also revisits already-loaded older pages so late replies remain visible;
one shared deadline bounds the entire paginated refresh.

## Migration and verification

Existing replies are copied from their annotations once, using `INSERT OR IGNORE`.
Legacy delivered messages without a claim become queued again. Existing claims, resolved
messages and dispatch snapshots survive reopening. Already-deleted legacy reply bodies
cannot be reconstructed.

Regression tests cover 20 competing claimants, expiry and renewal, stale tokens, duplicate
and conflicting replies, rollback on injected failure, cancellation, sheet deletion,
legacy migration, database reopen, stable pagination, workspace resolution, validation,
authentication, per-workspace sockets, out-of-order broadcasts, and renderer recovery.
The real stdio MCP harness tests prompt previews, send/reply retries, context retrieval,
and a desktop project switch between claim and reply. The Electron test selects two
canvas systems, loses a send acknowledgement, reloads and retries the original send,
then restores the final answer from history.

Run `npm run test:renderer`, `npm run test:mcp`, `npm run build`, and
`npx playwright test tests/e2e/inbox.spec.ts`. In `archd-go`, run `go test ./...` and
`go test -race ./internal/db ./internal/api ./internal/hub`.

An opt-in live-host smoke test runs the complete desktop → copied handoff →
Codex CLI → desktop review → acceptance path against an isolated archd and
throwaway indexed project. The canvas drawing is a deterministic E2E fixture;
the inbox requests, daemon, MCP calls, agent edit, and review are live. It
requires an authenticated Codex CLI and invokes
that CLI with automatic approval review and a workspace-write sandbox for the
disposable project; it does not change the user's Codex settings. After building Ambio and
archd, run:

```sh
AMBIO_LIVE_HOST_TEST=1 npx playwright test tests/e2e/live-host-pipeline.spec.mjs --workers=1
```
