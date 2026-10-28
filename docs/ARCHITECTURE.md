# Ambio - architecture

How the code is put together today. Verified against `main` on 2026-10-20.
What the product is: [PRODUCT.md](PRODUCT.md). Open work: [../WORK.md](../WORK.md).
Keep this document current: when you change a component's responsibility, a
data flow or a limit named here, update it in the same change.

---

## Project workbench chrome

`ProjectSetupScreen` edits the display name in both initial setup and Project
Settings. Confirmation trims the name and saves it with the source boundaries;
blank names cannot be submitted. Electron's folder registration reuses a known
project's saved name, so Open Codebase does not reset it to the folder name.

`Toolbar` keeps selection, Review Changes, the active sheet name, Search,
Fit and Message Agent visible. There is no permanent status footer or idle
indexing label. On the Floor, its name appears only in the left rail, with no
duplicate toolbar label or reserved space. `shared/appMenu.ts` supplies Tools
commands for recording and saved investigations, Agent → Architecture Draft for
draft recovery, and Help → Setup Guide for the opt-in legacy tutorial.
`panelStore` remembers only
the Sheet Rail and Detail Panel; older saved footer preferences are ignored.

`ProjectActivity` routes reads lasting over 1.5 seconds to the existing
interruption lane with progress and Stop. Lost live connections get a recovery
notice after 3 seconds, suppressed while Electron reports a daemon restart or
failure. Successful reconnection/read completion clears these notices.
`ProposalDraftProgress` uses the same lane on the workbench, while preserving
inline progress on initial project review. Dismissed drafts can be recovered
from Agent. The queue ranks progress below decisions, failures and invitations;
only one notice occupies the canvas at a time. Recording controls appear while
recording, starting, saving or offering the saved capture for replay.

## Integrated coding conversations

Conversation presentation (`store/conversationPreferences.ts`) stores custom
names and read watermarks per workspace/thread in renderer local storage.
Unread replies and build decisions drive the toolbar's attention count;
queued work alone is not an unread notification. Notification clicks carry the
workspace and thread through preload, opening the project and exact conversation.
Native chat lists refresh from saved metadata while the panel is closed, without
starting the harness. Rename is presentation only; deletion removes the native
saved transcript/index and/or an idle work-order thread through
`DELETE /api/canvas/conversation`. Active/queued threads refuse deletion until
stopped. Replies, claims and review events cascade with the thread; sheets,
code, work-session attribution and the structural journal remain.

The shared agent workflow and work-order handoff carry one response guideline:
use names and artifact links, ordinary architectural language, and concise
results. `AgentMessageContent` turns known system/sheet references into map links
and keeps internal identifiers out of prose while preserving code blocks.


Ambio chat is one destination in the agent panel's picker (`@chat:<service>`),
beside CLI/editor delivery. Its conversations are listed with the work-order
threads; `useAgentChat` and `ChatTranscript` (`AgentChatPanel.tsx`) supply the
sending and the streamed transcript, and a Build turn's work order carries the
thread `chat:<conversation>` so it is shown inside that conversation. `electron/agentChat.ts` manages one authenticated
loopback OpenCode server per project, persistent harness sessions, streamed text,
tool activity, questions, approvals and cancellation. The pinned platform binary
is copied to `out/agent` by `scripts/build-agent.mjs` and packaged as a resource.
Provider setup is in Settings → Agents; the picker opens it when none is set up.
The Agents page has three connection categories (`AgentConnections`): Ambio chat,
CLIs Ambio runs, and agents in other apps. Each client category keeps its selected
connector independently and shows a compact logo gallery above that connector's
management controls. Missing clients remain listed. The chat category stays
mounted while browsing clients so in-progress connection input is preserved.
`ChatProviderSettings` presents the ChatGPT account card and saved API connections;
an API editor opens only for an explicit provider or saved connection. Advanced
endpoint/context settings and ChatGPT account/model controls are disclosures.

Models: `electron/agentModels.ts` lists what each agent Ambio runs can use, read
the way that agent publishes it (Claude Code's aliases, Codex's
`~/.codex/models_cache.json`, `copilot help config`, `agy models`), cached per
session (`agent:models`). A delivery request may carry a model, which each
driver passes with its own flag. Ambio chat services keep the models found when
tested, and a turn may use any of them. The choice is made in the composer
(`AgentModelMenu`) and in setup, remembered per agent.

Setup's "Map with <agent>" (`src/renderer/screens/MapWithAgent.tsx`) creates
one durable **mapping attempt**, then starts a managed CLI or a dedicated native
chat runtime. This is a finite mapping task, distinct from ordinary Propose
conversations. External apps remain available on the canvas; onboarding only
uses agents Ambio can stop. The mapping brief requires complete source coverage
and notes before the final submission.

`internal/db/mapping_attempts.go` owns the attempt lifecycle (schema v10): one
unfinished attempt per workspace, bound to one draft and optional addressed
request. Draft commit runs in one immediate transaction with proposal creation,
notes, the submitted receipt and automatic request completion. Chunk arrival,
notes, cancellation and submission serialize on that transaction boundary.
Submitted proposals cannot receive new revisions. Cancellation preserves an
already submitted proposal; retries create new identities. A mapping draft is
never aborted, but `ResetMappingDraft` clears its chunks (keeping the attempt
and notes) so an agent can redraw before submitting. Draft systems decode
strictly (`db.DraftSystems`): an unknown key is refused with the chunk, not
dropped into a system that owns nothing.

`internal/api/mapping_attempts.go` issues a random task credential whose hash is
persisted. Every mapped MCP/HTTP call is scoped to the attempt and workspace;
only code/map inspection, mapping draft operations, notes and activity are
available. Work sessions, canvas replies, live-map edits, sheets and other work
are rejected. Submission permanently revokes all calls, with only an identical
HTTP submit replay allowed to recover a lost acknowledgement. The mapping MCP
surface and instructions describe this same terminal contract; it never receives
the desktop's general API credential.

`DeliveryRunner` observes the durable attempt independently of the renderer and
terminates the managed process tree after submission. Native chat does the same
through its main-process monitor and disposes its dedicated runtime. Only the
trusted launcher settles the attempt after process shutdown. Setup says the map
is submitted while the session is closing; it opens Review only after settlement.
Review also checks this condition in daemon write transactions and pins the
exact attempt's proposal, including after renderer reload. Other workspace
proposals cannot complete setup or replace the reviewed map.

Launch receipts and verified process creation times support crash recovery;
recovery revokes before killing and never resends inference. Unverified processes
leave Review locked. An interrupted bootstrap with no process receipt is cancelled
on the next startup recovery. A failed launch is cancelled and settled. Ordinary
Ask/Propose/Build permissions and resumable canvas conversations retain their
existing behavior. Progress comes from CLI events or cached native history;
submitted counts and timing come from the durable mapping attempt.

`electron/chatProviders.ts` keeps provider metadata and OS-encrypted keys under
`~/.ambio/chat`; without a secure keychain it keeps keys only in process memory.
`chatProviderProxy.ts` injects those keys into outbound requests and redacts
credential echoes across response chunks before the harness can persist them.
The harness gets only a temporary local token and isolated configuration/cache/data directories;
the renderer talks through typed preload IPC, never directly to a provider.

Conversation/root/provider identity and redacted display history are persisted
separately from archd work orders. Ask denies modifying tools and delegation.
Build messages create normal addressed work orders with the current selection
and sheet; the harness uses the existing workspace-bound MCP tools to claim,
record progress, compare and reply. A completed model turn never marks a work
order verified. Both delivery paths prevent overlapping managed runs in a root.
Runtime receipts verify process creation time before stopping a recovered PID;
restart reads history and does not resubmit a turn. Root relocation requires
idle managed agents and invalidates the old conversation's root binding.

The panel shows the saved history when a conversation opens and polls the
harness only while a turn is working or waiting, so an idle conversation never
starts OpenCode. A one-second monitor in the main process keeps running turns
current when no panel is watching, and skips any the panel just fetched;
history and `conversations.json` are rewritten only when they change. Each
model service has a context window (`chatContextWindow`, provider defaults in
`CHAT_PROVIDER_DEFAULTS`) that the harness compacts against. Ask pre-allows
Ambio's read-only MCP tools; Build also pre-allows the work-order protocol
(`get_inbox`, `start_work`, `update_work`, `reply_to_canvas`) and asks for
everything else that changes code or the map.

`npm run test:chat` drives the actual bundled harness against a controlled model
service and MCP server, including denied/allowed edits and restart recovery.
`tests/e2e/agent-chat.spec.ts` covers provider setup, streamed follow-ups, history
restoration and coexistence with the external-agent choices in Electron.

```
Electron app (electron/)            Coding agents (Claude Code, Codex, Cursor, ...)
  main process: windows, menus,       |
  project registry, installers,       |  stdio MCP
  updates, logs, file access          v
  renderer (src/renderer): React   MCP server (mcp/ambio-mcp.ts), run by
  + React Flow canvas               `archd mcp-run` on Ambio's bundled Electron Node
        |  HTTP + WebSocket              |  HTTP
        v                                v
            archd (archd-go/): the Go daemon on 127.0.0.1
            indexing, clustering, journal, delta, sheets, inbox,
            infra detection, runtime, per-project SQLite
```


## Processes

- **archd** listens only on loopback (API `7743`, WebSocket `7744`, runtime
  adapters `7745`), moving to free ports when those are taken and publishing
  the ports it uses in `~/.ambio/data/daemon.json`. Every request carries the
  token from `~/.ambio/data/api-token` (0600); non-loopback `Host` headers are
  refused. An OS lock on the data folder allows one daemon per machine.
- The **app** starts archd, or attaches to one already running (an agent can
  start it headless while the app is closed; a headless daemon exits when idle).
- The **MCP server** finds the project from the agent's working directory and
  starts archd on demand. Agents never need Node installed.

### Direct ChatGPT plan connection

`electron/chatgptAuth.ts` owns browser OAuth, dynamic client registration,
verified account profiles, encrypted `safeStorage` credentials, serialized
token renewal and public model discovery. A stable installation host ID and
issued per-registration client IDs survive reconnects. Renderer IPC exposes
display state and named account/model operations only, with sender/frame/URL
validation. No OAuth credential enters the renderer or daemon.

ChatGPT is a managed model service for the existing integrated OpenCode chat.
`ChatProviders` exposes one service per OAuth registration, including its saved
model catalog, without duplicating tokens in the API-key file. Each native
conversation retains its provider ID; selecting another account in settings
cannot redirect an existing conversation's requests. The credential proxy
resolves and renews that account's token in Electron for each upstream request.
The bundled agent and its tools receive only the proxy's local capability.

`electron/chatgptResponses.ts` applies the public Responses API restrictions:
non-stored streaming, complete history, developer instructions, and namespaced
local tools. It translates failed/incomplete streams and missing completion
into errors understood by the native model adapter.
The proxy accepts a missing upstream Content-Type because Electron can omit it
for live OAuth streams; it labels the validated downstream response as SSE.
An explicitly different content type is rejected, and successful inference
still requires valid events ending in `response.completed`. Existing OpenCode
tools, Ask/Propose/Build permissions, approvals, streaming history and cancellation
remain the execution path. Codex is not used. Plan credentials never fall back
to API-key billing or another account. Setup and live-account validation:
[CHATGPT_PLAN.md](CHATGPT_PLAN.md).


## Data

- One SQLite database per project: `~/.ambio/data/<project id>/ambio.db`
  (cgo `mattn/go-sqlite3`, WAL, bounded pool). `PRAGMA user_version` carries
  `db.SchemaVersion` (the constant in `internal/db/db.go`, with what each
  version added beside it); a newer database is refused. **Bump
  `SchemaVersion` whenever a migration changes the schema.**
- Daily backups (`backups/`, seven kept; a map failing `PRAGMA quick_check`
  on open is never backed up and the app offers its newest backup instead),
  a 30-day trash (`data/.trash`), and
  `.ambiomap` export/import (a SQLite snapshot plus a manifest table).
- The project registry, settings and window state are JSON in `~/.ambio`.
- Before the rename the folder was `~/.axiom` and maps were `axiom.db`.
  archd, the Electron main process and the MCP server each move `~/.axiom`
  to `~/.ambio` when the new one does not exist yet (whichever starts
  first), and archd renames old map and backup files in place
  (`db/legacy_name.go`); nothing is ever overwritten.

## The model

- **Files** (one node each, fixed-size cards) and **symbols** (in files, from
  tree-sitter; not canvas nodes on the Floor).
- **Systems**: semantic groupings of files, nested as a tree; a file belongs
  to one leaf system. Folders never define systems. Sources: `cluster`
  (automatic), `agent`, `user`. Human- and agent-authored systems are protected
  from re-clustering.
- **Relationships**: import edges and a call graph (calls matched by name
  across the project, imports as a tie-breaker; no type resolution), plus
  variable references for data flow (TS/JS, Python, Go).
- **Infrastructure**: nodes with a role (database, cache, queue, storage,
  search, llm, api, auth, platform, observability, email, scheduler, flags,
  realtime), implementations, contracts (tables, topics, cache keys, flags,
  models) and evidence-carrying relationships. See [INFRA.md](INFRA.md).
- **Sheets**: proposals over the Floor (moves, additions, and removals in
  `sheet_removals`, checked as "done once the code is gone") with
  planned elements; revisioned with optimistic concurrency. See
  [SHEET_WORKFLOW.md](SHEET_WORKFLOW.md). A sheet round-trips through a
  Markdown spec (`internal/api/sheet_markdown.go`, format in its header):
  `GET /api/sheets/:id/markdown`, `POST /api/sheet-import`, MCP `edit_sheet`
  export/import, Map → Copy Sheet as Markdown / New Sheet from Markdown…
  What an agent proposes on a sheet waits for the human, each part with its
  own decision: planned nodes (`approval_status`), moves (a sheet element's
  `parent_system_id` with no geometry, `db.ProposeSheetMove`, element
  `approval_status`), renames of systems (`proposed_name`, `rename_status`,
  `db.ProposeSheetRename`) and relationships (`planned_edges.approval_status`,
  `created_by`). Rejecting a move puts the node back under its Floor parent.
  `CompareSheetStructure` reports pending ones as `approval` differences and a
  confirmed rename the map does not have yet as `rename`; the build spec lists
  only confirmed moves, renames and relationships. A member saved with no
  geometry carries no layout opinion (`unplacedElement`/`unplacedPlanned` in
  `db/sheet_layouts.go`, `isUnplaced` in the canvas): it is drawn where the
  Floor has it, or inside its proposed parent, and a planned node without a
  position is placed in free space. The sheet rail's To review section
  (`SheetProposalReview.tsx`) lists every pending part with confirm/reject.
- **Work orders**: addressed inbox messages with leases, frozen sheet
  snapshots and review states. See [INBOX_PROTOCOL.md](INBOX_PROTOCOL.md).
- **Structural journal**: every structural change, attributed to a person or
  an agent session; the source of Review Changes. Code starting or stopping
  to use infrastructure is journaled as `infra.linked` / `infra.unlinked`
  (by hand through `/api/infra/connect`, or found by detection after a
  root's first run in the process; `api/infra_journal.go`) and becomes
  claims like "Orders now writes to Redis" (`delta/infra.go`).
- **Meaning edits**: every change to what the architecture says - create,
  rename, nest, group, ungroup, merge systems, and which system a file belongs
  to - goes through one path, `POST /api/architecture/edits`
  (`internal/db/meaning.go`). A batch is one transaction; each change writes a
  journal row with before/after detail and a stated actor (`human`, or a named
  agent and its work session; never inferred). Touching an inferred (cluster)
  system adopts it so re-clustering cannot undo the decision. The older
  `/api/systems` and `/api/files/:id/assign` routes funnel meaning changes
  through the same path and refuse them without an actor; geometry (position,
  size, colour) stays presentation and is never journaled.
  Review Changes turns these rows into claims ("billing.ts moved from Orders to
  Payments", "Auth merged into Identity"), collapsed to net effect, each with
  the event IDs that produced it. `POST /api/architecture/undo` reverses them
  (`internal/db/meaning_undo.go`): the inverse is itself a recorded edit that
  names the row it reverses, it is refused with 409 when later work would be
  overwritten, and an edit and its undo in the same window cancel out.
  After a batch commits, archd checks the files it placed against the code
  (`internal/db/code_fit.go`): a file outside the folder that holds most of
  its system, or one whose imports mostly connect to another system, is
  returned as `codeFit` with a sentence and an instruction. The canvas offers
  it as a work order ("Make the Code Match…"); agents get it in the
  `edit_systems` result as `codeDisagrees`. The map change stands either way.
  The same check runs when a review is read (move, grouping and merge claims
  carry `codeFit`) and in `GET /api/architecture/changes` (`codeDisagrees`).
  A work order sent with `codeFitFileIds` freezes those disagreements in
  `work_order_code_checks` (`internal/db/code_checks.go`); history and the
  reply re-check them against the indexed code (`codeChecks`: agrees,
  disagrees, map-changed, file-gone), so "the code now matches" is verified by
  Ambio, not reported by the agent.
  `start_work` hands the agent `mapChanges`: the person's meaning edits since
  that agent's previous session (or the last week), as claim sentences, with
  where the code still disagrees, and `decisions`: the person's verdicts with
  their reasons (`proposal.decided` rows) on planned elements, systems in
  architecture proposals and proposed infrastructure; an agent's own
  decisions (`decidedBy: "agent"`) are not journaled as news. Each
  `update_work` note returns the same briefing for what happened since the
  agent's previous note, so a verdict given mid-flight reaches it
  (`internal/api/map_briefing.go`, `recordDecision` in `api/sheets.go`).
  Agents read recent meaning changes with `get_architecture` scope `changes`
  (`GET /api/architecture/changes`).
- **Roots**: a project can hold several roots (worktrees of one repo); history
  is branch-stamped and collisions between branches are projected onto systems.
  Only the opened folder's checkout is indexed; when that folder is inside a
  repository, each worktree's root is the same folder in that checkout
  (`gitworktree.Discover`), and git diffs and co-change use `--relative`.
  A project indexed at the repository top level before this is moved onto
  its folder once (`narrowLegacyProjection`, `db.NarrowRootProjection`): the
  folder's files keep their IDs with re-rooted paths, the rest leave the map,
  and nothing is journaled.
  The Review Changes watermark is per root and branch (`delta_watermarks`);
  a branch never reviewed falls back to the root's older watermark. The
  worktree monitor also runs for a plain folder and starts watching Git
  metadata when `.git` appears. It follows refs, `HEAD`, `packed-refs` and
  which linked worktrees exist (`worktrees/<name>` and its `HEAD`, `gitdir`,
  `locked`), not a worktree's index or logs, which any `git status` there
  rewrites. Every git command Ambio runs goes through `gitworktree.Command`
  with `GIT_OPTIONAL_LOCKS=0`, so its own reads write nothing; before both,
  polling the other checkouts re-synced every checkout every 2 s, and an
  unindexed root was cleared and queued for a full index on each sync. A
  root's first full index is queued once while it runs. Model and plan:
  [GIT_AND_PROJECT_SHAPES.md](GIT_AND_PROJECT_SHAPES.md).
- **Checkouts** (`api/checkouts.go`, `GET /api/checkouts`): every active root
  as a checkout - branch, head state (`commit`, `detached`, `unborn`, `none`
  for a plain folder), whether the Floor shows it, `git status` (uncommitted
  count, upstream, ahead/behind), active agents and systems touched or shared,
  from the cached collision snapshot. The renderer keeps one snapshot
  (`store/checkoutStore.ts`, refreshed on `roots:changed`, focus, and every
  5 s while visible) and projects it into the toolbar branch chip and its
  Checkouts popover (`BranchChip.tsx`, `⇧⌘B`), the branch mark on systems and
  the Properties section (`checkoutModel.ts`). Revealing or opening a
  checkout goes through main by root ID (`checkout:open`), since a linked
  worktree may live outside the project folder.
- **Overlays and focus** (`api/overlays.go`): for each checkout the Floor does
  not show, `GET /api/checkouts` lists what it changes against its merge base
  with the Floor's checkout (`git diff base` plus untracked files, limited to
  what the indexer would read, `indexer.InScope`), each file tied to its Floor
  file or, if new, to the system owning most of its folder. The worktree
  monitor rebuilds this every 2 s when there are several checkouts and
  broadcasts `checkouts:changed` only when it differs. `roots.is_focused`
  (schema 9) records "Show on the Floor" (`POST /api/checkouts/focus`); the
  canonical root then prefers it, and `followCanonicalProjection` moves the
  file rows to it (`db.MoveRootProjection`, same IDs) and reconciles quietly
  (`indexer.ReconcileRootQuietly`). Removing the focused worktree moves the
  Floor back the same way.
- **Review a branch** (`api/branch_review.go`, `GET /api/checkouts/review`):
  a branch's architecture against its base, from Git rather than the
  journal, so it covers work done anywhere. Another checkout is compared
  with the Floor's branch, the Floor's own with the default branch
  (`origin/HEAD`, else `main`/`master`), or any `base`. Each changed file's
  imports are resolved at the base (its blob, parsed from a scratch copy) and
  at the branch (`indexer.ResolveImports`, the indexer's path rules), and the
  differences become journal-shaped events that `delta.Aggregate` and
  `delta.BuildClaims` word like any Review Changes ("Gateway now depends on
  Mailer"). Shown in the Checkouts popover ("Review this branch"); agents
  read it through `get_architecture` scope `branches` with `id`.
- **A worktree per run** (`api/worktree_runs.go`, `electron/main.ts`
  `agent:deliver`): Send's *Own worktree* asks archd for a worktree
  (`POST /api/checkouts/worktree`) under `~/.ambio/worktrees/<workspace>/<slug>`
  on `ambio/<slug>`, started at the Floor's commit, and returns once the root
  is registered; the run's cwd and handoff are that folder, so its MCP
  connection resolves there and the one-run-per-root limit no longer blocks a
  second run. A conversation's later turns reuse its worktree. Finishing
  (`POST /api/checkouts/finish`, Ambio's own worktrees only) applies the run's
  commits and uncommitted work to the Floor's checkout as uncommitted changes
  (`gitworktree.ChangesAsPatch`/`ApplyPatch`, refused over uncommitted edits
  to the same files, conflicts kept with the worktree) or discards it; either
  removes the worktree and its branch. *Switch branch…* (`POST
  /api/checkouts/switch`) is refused with uncommitted changes, and a branch
  open in another worktree is shown on the Floor instead. Ambio never
  commits, merges or pushes.
- **Repositories inside a project** (stage 6, first slice): a root is
  searched (depth 4, the indexer's skip rules, cached 30 s) for repositories
  inside it - several under a parent folder, or submodules
  (`gitworktree.FindRepositories`). The journal's HEAD tracker is keyed per
  repository (`rootID|folder`, `nestedRepository`), seeded on sync
  (`indexer.SeedRepositories`), so a switch inside one is quiet and leaves a
  `checkout.switched` row naming it on the root's branch. `GET
  /api/checkouts` reports them as `repositories` (`vcs: "repos"` for a plain
  folder of repositories); the chip reads "N repos". The map is one
  projection of the parent folder, with a top-level frame per repository: a
  system of kind `repository` (`systems.kind`, schema 10) with an ID stable
  per folder (`repositoryFrameID`). The classifier clusters each
  repository's files on their own, under its frame, with that repository's
  co-change (`indexer.clusterRepositories`), so no inferred system spans two
  repositories; files outside every repository cluster at the top level. A
  map indexed before frames existed reclusters once on its next sync
  (`NeedsRepositoryFrames`). Imports resolve against the whole project, so an
  edge between repositories is drawn wherever an import resolves across them
  (DECISIONS 2026-10-21). Overlays and reviews per nested repository, and
  adding unrelated folders, are WORK follow-ups.
- **Git moves files too** (`internal/indexer/checkout.go`): before a file
  change is journaled, its checkout's HEAD is read from the administration
  files, once any running Git command releases `index.lock` and `HEAD.lock`
  (a lock older than 10 s is taken as left over from a crash). Checkout
  releases `index.lock` before it moves HEAD, so for a second after the
  index is written the journal also waits for HEAD to move.
  A HEAD move since the journal last looked is classified from the reflog: a
  commit changes nothing; a branch switch makes the files Git wrote quiet and
  leaves one `checkout.switched` row; a pull, merge, reset or rebase is
  journaled with actor `git`. A file counts as written by Git only when its
  content is the new commit's blob and that blob differs from the old one, so
  carried and concurrent edits are still journaled. Rows are stamped with the
  HEAD just read, not the watcher's copy of the root. The worktree sync seeds
  the HEAD last indexed, so a switch made while Ambio was closed is caught up
  quietly.

## Pipelines

**Indexing** (`internal/indexer`, `internal/parser`, `internal/watcher`):
walk the root with ignore rules and the 1 MB / `*.min.*` limits → parse with
tree-sitter → symbols, imports, calls, variable references, package imports
and environment reads → call graph → clustering → infra detection. fsnotify
changes are gathered into bursts (150 ms quiet, at most 2 s) and a 1.5 s
re-cluster debounce; hitting the OS watch limit degrades loudly. A burst of
fewer than 8 files is indexed file by file and animates; a larger one, or any
holding a file Git wrote (`indexer.GitWroteAny`; a save in the minute after
a cherry-pick still animates), and a reconcile
of 8 or more files, go through `indexer.ReindexBatch`: each file read once,
imports and calls rebuilt from one parallel parse of the project (the
changed files' parses reused, and a file's imports rewritten only when they
differ), one relationship diff, no per-file canvas patches (the settle sends
`classification:updated`). Per file, a switch had cost a whole-project
reparse and an animation each. Changes to one root's map are serialized
(`lockRoot`), and live classification (`ClusterLive`, `ClusterOnly`) waits
on the same lock, so it never sees a batch half read in. Relationships a switch shifts between files it did not touch
are not journaled; after a pull they are Git's. The Floor moving to another
checkout (a quiet-all reconcile) always takes the batch path, so it replays
nothing on the canvas, and Review Changes neither diffs nor saves an
architecture snapshot while any root of the project is syncing
(`workspaceSyncing`); the sync's `delta:ready` re-reads it. Calls resolve by name only to
code in the caller's language family (JS dialects, C/C++, JVM) and, in a
folder of several repositories, its own repository unless it imports the
file (`internal/indexer/call_scope.go`). A file Git holds as unmerged with
conflict markers in it (a merge, rebase, cherry-pick or stash pop stopped on
a conflict) is not reindexed until it is resolved: parsed, the markers lost
its relationships (`internal/indexer/conflict.go`). Renaming the branch a
checkout is on (`git branch -m`, read from HEAD's reflog) is not a move: the
branch's journal, watermark, snapshots and agent history are carried to the
new name (`db.RenameBranchHistory`). Re-scoping (changing which folders are
read) is journaled quietly so it never shows up as code change. Content hashes
make reconcile after a closed period exact. A file moved on disk arrives as a
delete and a create in either order; the new path takes over the vanished
file's identity (same content, or the only vanished file with that name,
within 30 s), so it keeps its system, layout and history
(`internal/indexer/moves.go`).
A project opened by a request rather than by the app (an agent's headless
daemon, or a project the app does not have open) is made live the same way:
the root holding its indexed map is reconciled and watched
(`Server.keepWorkspaceLive`); indexing a project for the first time stays the
app's decision.

**Language depth:**

| Languages | Symbols | Import edges | Calls | Data flow | Infra from packages | Runtime |
|---|---|---|---|---|---|---|
| TS/JS, Python, Go | ✅ | ✅ | ✅ | ✅ | ✅ | recorded (Node instrumentation, Python `sys.settrace`, Go source overlay) |
| C# | ✅ | via `using` + namespaces | ✅ | - | regex | recorded (build rewriter) |
| Rust, Java, Ruby | ✅ | `mod`/`use`, `import`, `require` | ✅ | - | regex | recorded (Cargo wrapper, JVM agent, Ruby recorder) |
| C++, C | ✅ | `#include`: quoted, and `<dir/file.h>` project headers | ✅ | - | - | gdb or lldb-dap |
| Kotlin, Scala, Groovy | ✅ | JVM `import`s | - | - | - | recorded (JVM agent) |
| PHP | ✅ | `require`/`include`, PSR-4 `use` | - | - | - | recorded (prepended recorder) |
| Swift, Lua, shell, Elixir | ✅ | `import`, `require`, `source`, `alias`/`use` | - | - | - | exit code and output |

CSS, Sass/SCSS and Less are mapped with stylesheet imports and symbols.
`.h` is read as C. Main's readers (`parser/imports_more.go`) cover Java, Rust,
Ruby and C/C++; `parser/imports_text.go` covers the rest and C/C++ project
headers, resolved by `indexer/imports_other.go`. What a run can see per
language, and the toolchain each needs: [INVESTIGATION_RUNTIMES.md](INVESTIGATION_RUNTIMES.md).
The [README language table](../README.md#file-policy) lists supported file
extensions and investigation run capabilities.

**Clustering** (`internal/cluster`): Louvain over a weighted graph of import
edges (3.0), TF-IDF similarity of symbol and file-name tokens (3.0) and git
co-change (1.5, from `git log`), recursive into nested systems with stable IDs
and TF-IDF names; in a folder of repositories, per repository under its
frame. Agents are asked to author the real tree (`name-architecture`
prompt) rather than repair clusters.

**Review Changes** (`internal/delta`): aggregate the journal to net effect,
compact call sites and imports into claims with evidence, rank them, attribute
them, and classify realisation against sent work orders (MATCHED / FLEXED /
DRIFTED / MISSING / UNKNOWN).

**Work orders** (`internal/api/inbox.go`, `sheet_work.go`): send freezes the
sheet, build spec and comparison in one transaction → an agent claims by ID
(15-minute lease) → builds → `reply_to_canvas` → structural re-comparison →
you accept or request changes. Agent-reported results are labelled unverified.

**Delivery** (`electron/agentDelivery.ts`, `AgentDelivery.tsx`): the send panel
lists every installer host. Claude Code, Codex, Copilot CLI and Antigravity CLI
(and, experimentally, Cursor and Devin) start fresh local runs after the request
is durably saved; editor/desktop hosts copy the handoff and
open the project/app when a launcher is available. The main process verifies the
registered project, current request state and claim before launching, supplies
workspace-bound MCP config, and records launch receipts/output under
`~/.ambio/delivery/`. Receipts prevent duplicate execution across retries/reloads;
review revisions permit another run. One managed run edits a root at a time.
Launch status is distinct from MCP claim and reply status. Runs edit the existing
graph root unless Send's *Own worktree* is chosen (see the checkouts section
above), can be stopped in the inbox, and are asked to stop when Ambio quits.
See INBOX_PROTOCOL's host table and recovery limits.

**Client discovery and executable selection** (`src/shared/agentDelivery.ts`,
`electron/agentClientDiscovery.ts`, `agentExecutableOverrides.ts`): a stable
catalog lists every supported terminal and app route, independently of local
availability. Setup groups wrapping name-and-logo pills (`ConnectorLogo.tsx`)
into Ambio chat, Ambio runs it, and In another app sections, using bundled assets whose sources
are recorded in `assets/connectors/SOURCES.md`. Each pill keeps its availability
in its colored outline, accessible label and tooltip; keyboard selection uses arrows/Home/End across sections.
Selecting a pill opens a nonmodal sidebar over the field agent. `ChooseAgent`
owns selection, discovery and setup state and portals the details into a stable
slot in `ConnectAgentScreen`'s mascot area; closing returns focus to the pill.
Details scroll independently above pinned actions, with a reduced-motion
alternative and narrow-screen scrolling into the stacked agent area. The
field-agent character/title-bar transition is a separately staged UI change.
Session-option help uses the shared `InfoPopover` in the browser's top layer,
anchored to its trigger with scroll/resize tracking and native outside-click
dismissal. It does not participate in the sidebar layout; Escape dismisses the
help before the sidebar.
Ambio chat's connection links use `modelServiceNavigation.ts` to carry a typed
provider destination through Settings into `ChatProviderSettings`, which selects
and focuses the requested setup after mounting. Existing untargeted model-service
events still open the connection section. Navigation never initiates OAuth or
mutates a saved service.
Codex/Claude IDE and desktop surfaces keep separate installation
evidence while sharing their existing canonical installer's MCP configuration;
app-specific actions resolve to that installer rather than writing competing
connections. Installation/configuration evidence is shown separately from CLI
availability, and does not establish sign-in or a live connection from a
particular surface. Private Codex binaries injected into PATH by its extension
or desktop app are not automatically classified as a standalone CLI.
The file picker can remember a native executable or npm entrypoint under
`~/.ambio/agent-executable-overrides.json`. Known npm shell shortcuts resolve
to their entrypoints; prompts never pass through a shell. Explicit selections
receive a bounded version/identity check where supported; ACP server selection
does not start a protocol session merely to inspect it. Discovery and actual
delivery use the same resolver, recheck saved paths, and expose broken overrides
instead of silently substituting another executable. Setup refreshes app, CLI
and model-service sources; bounded requests and generation guards retain the
catalog and expose errors without letting late results overwrite newer scans.

**Conversations** (`db/inbox.go`, `SendToAgentDialog.tsx`, `inboxModel.ts`):
a request is a turn in a thread (`canvas_outbox.thread_id`, `mode`).
Built-in conversations use `chat:<native session ID>` for their Build work
orders; `db.EnqueueCanvasMessage` allows an addressed Build to start that
reserved thread because earlier Ask/Propose turns live in Electron.
The claim response hands the agent the thread's earlier turns (`db.InboxConversation`),
so context does not depend on the host. `electron/agentDrivers.ts` holds one
driver per started host: how to start a turn, continue the host's session,
apply the turn's mode as permissions, and read its output. The runner stores
host sessions per conversation and a run's activity events; `acpClient.ts`
drives hosts that speak the Agent Client Protocol. A session told to watch
waits on `get_inbox({watch: true})` and is offered as a destination; a turn
can be left for the watching session of one host (`target_host`). A started
agent's permission questions wait in archd (`api/agent_permission.go`, in
memory) and are answered in the panel (`store/agentPermissionStore.ts`).
Driver events are `text`, `tool`, `error` and `thinking`; the turn shows the
latest few while it works. Thinking comes from Claude Code's `thinking` blocks
(when the model fills them), Codex's reasoning summaries
(`model_reasoning_summary="auto"`), Cursor's streamed `thinking` events and ACP
`agent_thought_chunk` updates, each tidied to one line (`thought`). Antigravity
CLI 1.4 reports only a count of thinking tokens. Ambio chat keeps OpenCode's
`reasoning` parts as a `reasoning` chat part, shown collapsed above the reply.

**Agent replies** (`AgentMessageContent.tsx`, `agentMessageFormat.ts`): replies
render as Markdown (react-markdown + remark-gfm, raw HTML shown as text).
`normalizeAgentText` repairs what agents commonly break (a `\b` decoded into a
backspace, one-backtick fences, absolute project paths). File links, inline
code and plain-prose file names that resolve to an indexed file become chips
(`fileLinkTarget`, `inlineFilePath`, the `remarkFilePaths` plugin); a shortened
name counts when exactly one indexed path ends with it. A chip, like a row
under To review, brings the map to its node through `useShowOnMap`, which
opens a collapsed system, selects the node and fits the view once React Flow
has measured it. While the panel is open it publishes its width as
`--agent-panel-inset` and the canvas area ends at the panel's edge, so every
fit and selection centres in what is visible.

**Infra detection** (`internal/infradetect`, `internal/registry`): a pure
analysis of package imports, environment reads, the import graph and config
files (compose, `.env`, Dockerfile, Procfile, fly/vercel/netlify/render/railway,
GitHub workflows) against an 87-service registry; results are proposals until
confirmed.

**Investigations and runtime** (`internal/runtime`, `adapters/`): hypothesis
runs record watched functions in-process with each language's own toolchain:
Node load-time instrumentation, Python `sys.settrace`, Ruby and PHP recorders
loaded ahead of the program, a JVM agent (Java, Kotlin, Scala, Groovy), a C#
build rewriter, a Go source overlay (`-overlay`) and a Rust Cargo wrapper;
C/C++ runs under gdb or lldb-dap. A run can start a server first (`server`,
`port`) and then the command that exercises it. `GET
/api/investigation/readiness` says what runs can see per language in the
project (shown in the investigations menu). On Windows a run's command reaches
`cmd.exe` as written (`windowsShell`), and a server's process tree is killed
while its root is alive. DAP inspection for other languages is behind the MCP
debug profile. See [INVESTIGATIONS.md](INVESTIGATIONS.md) and
[INVESTIGATION_RUNTIMES.md](INVESTIGATION_RUNTIMES.md).

## MCP surface

Fifteen tools by default (`get_architecture`, `search_symbols`, `get_symbols`,
`trace_calls`, `get_data_flow`, `edit_systems`, `edit_infra`, `edit_sheet`,
`get_inbox`, `get_build_plan`, `plan_element`, `reply_to_canvas`,
`start_work`, `update_work`, `investigation`), `debug_runtime` in the debug
profile, and five prompts (`review-canvas`, `name-architecture`, and the
loop prompts `propose`, `implement`, `review` in `mcp/prompts.ts`). About 80
legacy tool names still route but are not advertised. Budget and merge rules:
[MCP_SURFACE.md](MCP_SURFACE.md). Installers for ten agent hosts live in
`electron/agentInstallers.ts`.

Draw-first guidance has one source, `src/shared/agentWorkflow.ts`, used by
installed mapping/inbox/build skills and MCP connection/prompt instructions.
`electron/agentRules.ts` adds host-specific project rules with hashed managed
blocks; inspection detects missing/edited rules and uninstall keeps authored
text and rules still shared by another configured host. `edit_sheet(connect)`
draws typed planned edges through the existing workspace-scoped sheet API; a
live system or file not yet on the sheet is added to it, and a planned node
must already be on that sheet. `plan_element` takes `parent` (a live or planned
system) and `owns` (existing files/systems moved into the new one);
`edit_sheet(move)` and `edit_sheet(rename)` propose moving and renaming existing
nodes (schema 6-7). The Propose contract (`inboxModel.ts`) tells the agent to
start from the current map, reuse what exists and draw only the change.
`get_architecture` counts a system's files including its sub-systems
(`fileCount`, with `directFileCount`), `system_files` lists sub-systems' files
with the system holding each, and `neighbors` names a system's children.
`get_symbols` accepts file paths as well as IDs. Host coverage
and validation limits are in [testing/AGENTS_DRAW_FIRST.md](testing/AGENTS_DRAW_FIRST.md).

## Renderer

The Floor and proposed-architecture review share `canvas/AmbioCanvas.tsx`.
Camera updates change the viewport without rebuilding the layout. Review nodes
are already fully visible, so camera movement does not restamp their controlled
array. Review/bin selectors ignore live-only agent/runtime channels. Empty flow
and trace overlays do not subscribe to the camera; active overlays subscribe to
zoom and cache world-space routing separately from screen-size pulse/callout work.
`canvas/canvasZoomChrome.ts` tracks mounted activity badges and writes camera
scale only to those elements; the registered non-inheriting `--ambio-zoom`
property avoids invalidating the full diagram's styles each frame. Each nested
canvas owns its own badges and camera. Performance regressions are covered by
`tests/e2e/canvas-performance.spec.ts`; measurements and limits are documented in
[testing/CANVAS_PERFORMANCE.md](testing/CANVAS_PERFORMANCE.md).

Sheets cache geometry and authoring callbacks independently of camera, selection,
layout-transition flags and runtime changes. Unchanged sheet-list polls preserve
layer identities and do not repack the canvas. `canvas/sheetPresentation.ts` merges live flags and selection
while preserving unaffected node identities. React Flow dimension notifications
are retained separately from saved layout and drag/resize snapshots: dropping
`measured` resets handle bounds and forces off-screen cards through mounting again.
Viewport culling uses the composed scene count, including planned sheet nodes.
`canvas/semanticZoom.ts` caches ancestry order and reveal/detail thresholds per
immutable scene array; between thresholds an easing frame performs a binary
search and reuses the scene. Geometry/measurement edits invalidate the cache.
Selection likewise preserves untouched objects. Search and agent reply pills use
`canvas/useShowOnMap.ts`: the latest pending request waits for a visible, measured
target and cancels wheel easing/pending growth fits on its own canvas before
flying. Cursor and bin drag diagnostics require `window.__ambioCursorDebug = true`
or `window.__ambioBinDragDebug = true`.

`canvas/scene/canonicalScene.ts` keeps the complete scene, stable ID order and
absolute geometry outside React Flow. `useCanvasRenderBudget.tsx` materializes
buffered visibility, required ancestors, selected/live nodes and endpoints of
admitted relationships. It iterates admitted IDs on camera replies instead of
mapping the project array. Flow owns a disposable interaction subset; its own
component culler can release DOM within that subset. During layout glides the
outgoing subset is retained, rather than adopting the entire project.
For a Floor projection whose initial semantic visibility is already prepared,
the preparation hook also constructs records, ID order and absolute boxes in
cooperative tasks before publication. An exact-array weak cache lets adoption
reuse those completed indexes. Selection and the runtime/slice/focus/trace
overlays carry them forward only because they preserve geometry, order, hidden
state and semantic detail; ordinary geometry/visibility edits miss that cache
and use the normal reconciliation path. Equivalent model echoes reuse record
and geometry identity. Idle overlays return the original array without stamping
unset booleans to false. Saved scenes build persistence lookups only when rows
need writing; review saved-row membership uses a set instead of nested scans.
The integrity audit remains authoritative. Floor preparation now runs that audit
cooperatively before publication, against the independent model membership. Its
completed result is cached for the exact immutable node array and membership
identity; selection/activity stamps retain it alongside the semantic visibility
index. Adoption can consume that result without repeating a project-sized audit.
Geometry, visibility, ordering or membership edits invalidate reuse and still
take the ordinary audit path. Review/sheet transforms retain their own validation.
Semantic index preparation uses bounded stable sorts (256 entries per native
sort and cooperative merges), with a linear path for already depth-ordered nodes.
No reveal threshold or camera/authoring contract changes.

Floor file projection reuses `binModel.ts`'s single-pass partition when the
canvas and bins share an indexed population and placement rules; the partition
retains all source files in input order as well as placed/unclassified/docs.
Review-specific populations keep their own filter. `DeltaPanel` leaves file and
system subscriptions inactive without a delta and builds filter lookups only
when review opens. These avoid synchronous cold-store consumer work; measured
controls and limits are in [the cold-input follow-up](testing/CANVAS_COLD_INPUT_WIN.md).
Loose-file layout membership is built only when a placement query needs it,
once per immutable layout revision. Canonical membership remains independent
of candidate geometry and is populated without temporary ID arrays. App's
authored-system decision reads system sources only; source counts are computed
when the setup screen is displayed. The [budget confirmation](testing/CANVAS_COLD_INPUT_BUDGET.md)
records repeated native cold-input results and remaining limits.
Initial-mapping Review stamps `omitConnectionHandles` in presentation data,
so full and compact nodes omit inactive React Flow endpoint components and
their store subscriptions. Disabled Floor/sheet endpoints still mount for
relationship geometry; the flag is independent of connection permissions.
WASD ownership follows browser pointer-move/boundary events, including surfaces
appearing under a stationary pointer, instead of a forced hit test every frame.
[Dense Review measurements](testing/DENSE_REVIEW_FRAME_COST.md) retain native
controls, rejected prototypes and the remaining keyboard frame-budget miss.
See the [final adoption follow-up](testing/CANVAS_FINAL_ADOPTION.md).
`useCanvasFitView.ts` fits canonical bounds when nodes are not adopted; search
waits for accepted preparation before using a target's current measurement.
Drop/initial-fit controllers have canonical geometry fallbacks. Resize snapshots
include unadopted children and apply their compensation through the normal
controlled-node callback. Only active resize owners need remain adopted.

Initial-mapping review still shows every child rather than applying Floor
semantic hiding. Its empty-pane mouse pan captures the pointer on that surface
without replacing Flow's camera math. Node drags, Shift/lasso and touch remain
native Flow gestures. Review has no edges/connection gestures: its disabled
connection handles use `display: none`, while Floor/sheet anchors stay measured.
During a review pane drag, CSS suspends the card/folder backdrop shadow filters;
resting artwork returns when Flow clears its pane-drag state. No per-move React
state or model mutation is introduced. See [review pan measurements](testing/REVIEW_POINTER_PAN.md).

Large HTTP resync snapshots use `store/snapshotLoader.ts` and its temporary
worker: transfer bytes, parse off-thread, receive acknowledged row batches and
apply only a complete snapshot. Connection changes abort the fetch/reader;
ordered WebSocket buffering remains authoritative. Small replies decode inline.
Full WebSocket snapshots/classification events remain atomic. Numeric input,
input equivalence, React-node projection and initial Floor semantic visibility
prepare cooperatively through `scene/sceneSteps.ts`. Large numeric, prepared and
spatial payloads use `scene/sceneTransfer.ts` batches on the existing scene
worker, with tokens, backpressure and monotonic spatial revisions. Generator
checkpoints and bounded entry counts do not guarantee a frame deadline for an
individual large row or primitive. Complete model storage still scales with
project size. Current lookup objects do not capture earlier canonical scenes;
this avoids retaining the complete scene history through closure contexts.
Evidence: [cold adoption and memory](testing/CANVAS_COLD_ADOPTION.md). The
[main/device handoff](testing/CANVAS_PERFORMANCE_HANDOFF.md) indexes the delivered
canvas changes, remaining scalability work and reproducible checks.

`scene/sceneGeometry.ts` contains numeric alternate-axis initialization and Floor
frame preparation, separate from `floorSceneProjection.ts` (React node data).
`scene/sceneController.ts` shares one `renderBudget.worker.ts` between Floor/sheet
preparation and spatial queries. Numeric jobs yield between loop chunks, coalesce
by channel and reject superseded tokens. Workspace/sheet scopes and immutable
input identity gate adoption and generated-placement persistence. An equivalent
metadata/save echo reuses an accepted or pending preparation. Preparation caches
are cleared when their controller/channel lifecycle is cancelled, so development
effect replay starts a fresh job rather than reusing a rejected promise.
Unchanged layout and semantic-parent echoes preserve identities in
`store/floorLayoutUpdates.ts`.
Timestamp-only layout echoes do not invalidate renderer geometry; authoritative
save timestamps remain in SQLite. Failed initial saves latch the attempt and
surface Retry instead of repeatedly rebuilding and issuing network writes.

The worker indexes conservative endpoint bounds for relationships, matching
Flow's visibility rule, including paths crossing the viewport with both endpoints
offscreen. Disconnected offscreen relationships no longer pull all their endpoints
into Flow. Endpoint shells retain their ordinary measured handles and routing;
this is not the planned batched relationship renderer. Visible high-degree hubs
still cost one edge and its required endpoint geometry per relationship.

`sceneRecords` preserves spatial revisions without JSON signatures. Admission
retention membership is prepared once per spatial revision. Initial shells
already respect the viewport buffer while the worker answer is pending. Rich
detail remains per-node subscribed and admitted in small batches. Small worker
fallbacks prepare cooperatively; scenes/relationships above 2,000 refuse a large
synchronous fallback. A worker error retains coherent content and exposes Retry.
Cancelled work that cannot acknowledge within one second is terminated, covering
an atomic packing primitive that fails to yield; current jobs then surface a
recoverable error. No such failure silently triggers a huge UI-thread rebuild.
`sceneIntegrity.ts` validates changed immutable nodes incrementally and repeats
its full canonical audit for structural revisions. Empty activity avoids full
activity indexes; scene ID signatures do not sort again on selection.

`renderBudgetStore.ts` and `nodes/BudgetedNodes.tsx` retain silhouette, compact
identity and editable detail tiers. Navigation prewarms its destination and
shared symbols while intermediate cards stay compact. Compact cards retain sheet
and checkout badges; focused relationships keep their full presentation.
See [testing/CANVAS_CANONICAL_WORKER.md](testing/CANVAS_CANONICAL_WORKER.md) for
measurements, validation and remaining cold-loading/density limits.

`nodes/VirtualSymbolRows.tsx` bounds symbol DOM work. `symbolCache.ts` owns shared
cancellable requests (four concurrent), revision invalidation and bounded LRU
storage; compact nodes do not fetch just because they are authorable. Ordered
WebSocket dispatch yields between messages through `canvas/frameWorkQueue.ts`
(3 ms / 24 messages per batch); queue overflow uses snapshot resync. Individual
messages remain atomic. `useCanvasFrameTiming.ts` samples active camera windows
and shares one renderer long-frame observer; all diagnostics are local and
bounded. Full geometry snapshots/diffs in `sceneDiagnostics.ts` require
`window.__ambioSceneDebug = true`; this investigative tracer does not run in
ordinary frames. Scene-integrity checks and recovery remain active independently.
See [testing/CANVAS_FRAME_BUDGET.md](testing/CANVAS_FRAME_BUDGET.md) for the
five-part implementation, measured results and remaining scaling limits.

`canvas/perfTrace.ts` adds opt-in stage timings for snapshot resync fetch/decode/application,
geometry/projection and worker transfer/index/query/round trip. The local
`__ambioPerfTrace.start()` switch retains 2,048 samples plus full-session aggregate
counts/maxima; no project identifiers are logged. Scale fixtures and isolated
Electron input/frame/process-memory measurements live in
`tests/fixtures/canvasScale.ts` and `tests/e2e/canvas-scale.spec.ts`; the real
SQLite query/JSON benchmark is `internal/db/canvas_scale_bench_test.go`.
See [testing/CANVAS_SCALE_BASELINES.md](testing/CANVAS_SCALE_BASELINES.md).
`CanvasMiniMap.tsx` has one React Flow store subscription and renders only admitted
marks from `minimapGeometry.ts`; camera updates reuse their geometry. It preserves
the existing passive minimap presentation without per-hidden-ID wrappers. Native
E2E checks count actual React wrapper components as well as DOM nodes so hidden
subscriptions cannot regress unnoticed. Complete canonical geometry lives outside
React Flow; Flow owns only the admitted interaction subset described above.
Snapshot decoding, canonical React-node projection, worker copying and total
model storage still scale with project size, though large HTTP decoding is now
off-thread and projection/transfer are staged. This is not a completed progressive
data/adoption boundary.
Inline node fields share `nodes/useCommitOnUnmount.ts`, which invokes the latest
normal commit if a focused field is culled. React suppresses synthetic blur during
deletion; relying on browser focus loss would discard an unfinished edit.
`edges/ClippedDashedEdge.tsx` clips very long static dashed paths to the buffered
camera before SVG stroking; `clippedEdgeGeometry.ts` preserves their canonical
arc distance and real target markers. This avoids millions of offscreen dashes
without changing relationship geometry or editing. Raster parity includes the
HTML camera at ordinary/extreme zoom. React Flow defaults and connection/selection
callbacks retain stable identities: changing the default fit options during a
queued manual fit can otherwise replace its destination and duration.

React + React Flow (`@xyflow/react` 12) with zustand stores. The canvas is
`src/renderer/canvas/` (~21k lines; `AmbioCanvas.tsx` alone is ~5k and is
work item `split-ambio-canvas`). Semantic zoom reveals contents by on-screen
size; layout is deterministic frame packing that never moves persisted
geometry. One command model (`src/shared/appMenu.ts`) drives menus, the
palette, shortcuts and right-click menus. The renderer is sandboxed under a
strict CSP; privileged work goes through `electron/preload.ts`.

Global Settings (`app/GlobalCommands.tsx`, `styles/appChrome.css`) uses an
860 × 640 px frame capped to the viewport with 24 px margins. Sections share
one scrollable content panel, while the header and navigation stay in place;
switching sections resets the panel scroll. At viewport widths of 640 px or
less the section navigation wraps above the content. Shared screen title bars
and the canvas title strip contain branding, menus, status and window controls.

Brand placements use `components/ui/AmbioBrand.tsx` and the outlined SVGs in
`src/renderer/assets/branding/`, so no display font loads at runtime. Native
icons live in `resources/branding/`, copied outside asar on every platform;
`electron/branding.ts` resolves their development/packaged location. The main
process uses the A for the window, dock, notifications and tray. Clicking the
tray restores/focuses the window; it does not change close/quit behavior or
provide the planned agent activity surface. `npm run brand:icons` regenerates
the PNG, ICO and ICNS assets from the approved A. See [BRANDING.md](BRANDING.md).

Finding things by name is one lookup for humans and agents: `⌘K`
(`components/SearchBar.tsx`, results built in `canvas/searchResults.ts`)
matches systems, infrastructure and files from the store and asks archd's
`/api/symbols/search` (`db.SearchSymbols`, ranked exact → prefix → contains)
for symbols - the same endpoint behind `search_symbols` and the Model
Explorer's search.

Work-order updates arrive as `canvas:message` patches; while the window is
not focused, a pickup or a reply becomes a system notification
(`store/workOrderNotice.ts` decides, `app:notify` in `electron/main.ts`
shows it, gated by the `workOrderNotifications` setting).

## Tests and CI

- `npm run test:renderer` - node unit tests for renderer, shared, Electron,
  MCP, adapters and scripts.
- `cd archd-go && go test ./...` - daemon tests (runtime and clustering
  quality are thinly covered).
- `npm run test:mcp` - MCP end-to-end against a real archd. **Not in CI.**
- `npm run test:e2e` - Playwright journeys in Electron. **Not in CI.**
- CI (`.github/workflows/ci.yml`) runs Go vet and tests, the license check,
  the unit suite, the typecheck and the build on Linux, macOS and Windows.

## Known limits

- Single-machine, single-user; no sync.
- The MCP connection binds to one root; multi-folder projects are held.
- Name-matched calls can create false edges; languages outside TS/JS, Python
  and Go get a weaker map.
- Full re-cluster reads the whole git history and rebuilds the root graph;
  not benchmarked on very large repos.
- macOS auto-update needs code signing.

### Sheet presentation defaults

A sheet starts with relationships hidden. Selecting a system reveals its
connections; selecting a relationship review row reveals and frames both
endpoints, accents their existing outlines and explains the relationship in
the rail. Show All Sheet Relationships is a presentation toggle shared with
the View menu; it resets on sheet navigation. Proposed relationships remain
reviewable even when their lines are hidden. Moves state their original and
proposed parent in ordinary language. Added/moved markers use `canvasZoomChrome`
to retain a small screen size without invalidating the whole scene during zoom.

`compactSheetSystems` reuses `packFrame` and frame insets to size unplaced new
systems and automatic system moves from their contents, recursively. It modifies
only the sheet projection: authored sheet layouts and surrounding Floor frames
are retained. Resizing/placing a proposal explicitly makes its saved geometry
authoritative, rather than compacting it again on refresh.
