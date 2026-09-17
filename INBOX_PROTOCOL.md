# Canvas inbox protocol

Canvas instructions and replies are durable project records. Reading never resolves work.
An atomic claim grants one agent temporary ownership. Explicit replies resolve messages;
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

Ask an MCP-connected agent to **check the Axiom inbox**. The panel provides copyable
instructions. Installers that support skills also install `axiom-inbox` beside `axiom-map`;
manual language remains the universal entry point. Installing is optional for an already
connected agent. No hook, slash-command convention, or permanent polling loop is required.

The panel distinguishes waiting, picked up, answered, cancelled, and expired claims.
Picked up means the connector claimed the instruction, not proof of ongoing model work.
Replies remain visible after restarting Axiom or deleting the originating canvas objects.
Cancellation prevents acceptance of a later reply; it cannot stop an external coding
process. The panel tells the user to stop that agent separately if necessary.

## MCP contract, version 1

- `get_inbox()` atomically claims at most one pending instruction for the bound workspace.
  The same connector gets its existing live claim back and renews it. Other connectors
  cannot claim that instruction until its lease expires. An empty inbox returns immediately.
- Responses include `protocolVersion`, explicit workspace identity/root, selected targets
  (type, ID, original label), claim expiry, and an opaque `messageHandle`.
- `get_inbox({messageHandle, contextOffset: 0})` fetches original context in pages of at most
  12,000 Unicode characters. Continue from `nextOffset`; `-1` means complete. Fetching
  context does not claim another instruction. The handle must still own the message.
- `reply_to_canvas({messageHandle, body})` writes one final reply and resolves its message
  in one transaction. Identical retries return the original reply, including after expiry.
  A different body, wrong token, cancellation, or reassignment returns a conflict.
- Text content and structured MCP content carry the same result. Tool errors stay errors;
  a daemon outage never means an empty inbox.
- `review-canvas` is a reusable MCP prompt that describes this workflow. Retrieving a
  prompt never reads or claims user work. Legacy read names remain executable but no
  longer implement a destructive drain or a long-running wait.

Each claim lasts 15 minutes. Explicit `get_inbox()` calls renew it; passive connector
presence does not. An idle MCP process can outlive the conversation, so renewing work
from presence alone would strand messages indefinitely. Agents are instructed to renew
before expiry and check ownership before continuing after interruption.

This provides at-least-once delivery and idempotent final replies. It does not guarantee
exactly-once edits in an external repository. A stale agent can still modify files outside
Axiom. Claim tokens fence Axiom replies, not third-party tools or shell commands.

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
| `POST /api/canvas/send` | Save `{id, workspaceId, note, selection, sheetId}` |
| `POST /api/canvas/claim` | Claim/renew using `{workspaceId, connectionId, agent}` |
| `POST /api/canvas/context` | Read a context page using `{workspaceId, msgId, leaseToken, offset}` |
| `POST /api/canvas/reply` | Resolve using `{workspaceId, msgId, leaseToken, body}` |
| `POST /api/canvas/cancel` | Cancel unresolved work using `{workspaceId, msgId}` |
| `GET /api/canvas/history?workspace=…&before=…&limit=…` | Newest-first history; stable `(createdAt,id)` pagination |
| `GET /api/canvas/outbox?workspace=…&peek=1` | Available instruction count for discovery hints |
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

1. `AXIOM_WORKSPACE_ID`, if explicitly configured.
2. An explicit `AXIOM_ACTIVE_PROJECT` file (used by isolated harnesses).
3. Otherwise the longest registered root containing the process working directory,
   including persisted worktree roots. Equal matches in different projects fail visibly.

For a host without a meaningful working directory, configure a workspace ID, or explicitly
opt into the desktop pointer with `AXIOM_USE_ACTIVE_PROJECT=1`. The pointer is still read
only at binding time; start a new MCP connection to choose another workspace. Changing
the desktop's project cannot redirect a running agent's calls or replies.

The daemon generates a local random capability in `<data>/api-token` (0600 on POSIX).
Electron adds it from the main process to its own daemon requests; page scripts never
receive it through IPC. MCP reads the same file and uses a 15-second request deadline.
Overrides are `AXIOM_API_TOKEN` or `AXIOM_API_TOKEN_FILE`; `AXIOM_API_URL` must remain
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
