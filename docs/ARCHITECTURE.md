# Ambio - architecture

How the code is put together today. Verified against `main` on 2026-09-30.
What the product is: [PRODUCT.md](PRODUCT.md). Open work: [../WORK.md](../WORK.md).
Keep this document current: when you change a component's responsibility, a
data flow or a limit named here, update it in the same change.

---

## Integrated coding conversations

Ambio chat is one destination in the agent panel's picker (`@chat:<service>`),
beside CLI/editor delivery. Its conversations are listed with the work-order
threads; `useAgentChat` and `ChatTranscript` (`AgentChatPanel.tsx`) supply the
sending and the streamed transcript, and a Build turn's work order carries the
thread `chat:<conversation>` so it is shown inside that conversation. `electron/agentChat.ts` manages one authenticated
loopback OpenCode server per project, persistent harness sessions, streamed text,
tool activity, questions, approvals and cancellation. The pinned platform binary
is copied to `out/agent` by `scripts/build-agent.mjs` and packaged as a resource.
Provider setup is in Settings → Agents; the picker opens it when none is set up.

Models: `electron/agentModels.ts` lists what each agent Ambio runs can use, read
the way that agent publishes it (Claude Code's aliases, Codex's
`~/.codex/models_cache.json`, `copilot help config`, `agy models`), cached per
session (`agent:models`). A delivery request may carry a model, which each
driver passes with its own flag. Ambio chat services keep the models found when
tested, and a turn may use any of them. The choice is made in the composer
(`AgentModelMenu`) and in setup, remembered per agent.

Setup's "Map with <agent>" (`src/renderer/screens/MapWithAgent.tsx`) sends the
mapping brief (`agent:mapping-brief`, the same text the installed workflow
carries) as a Propose turn: a work order delivered to a CLI Ambio runs, or an
Ambio chat conversation, whose Propose agent may call `edit_systems`. Progress
comes from the run's events or the chat snapshot; the proposal itself arrives
through the usual draft and proposal endpoints.

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

## Data

- One SQLite database per project: `~/.ambio/data/<project id>/ambio.db`
  (cgo `mattn/go-sqlite3`, WAL, bounded pool). `PRAGMA user_version` carries
  `db.SchemaVersion` (currently 2); a newer database is refused. **Bump
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
  Projects already indexed at the repository top level stay there
  (`keepLegacyTopLevelProjection`) until `git-monorepo-subfolder` moves them.
  The Review Changes watermark is per root and branch (`delta_watermarks`);
  a branch never reviewed falls back to the root's older watermark. The
  worktree monitor also runs for a plain folder and starts watching Git
  metadata when `.git` appears. Model and plan:
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
- **Git moves files too** (`internal/indexer/checkout.go`): before a file
  change is journaled, its checkout's HEAD is read from the administration
  files, once any running Git command releases `index.lock` (a lock older
  than 10 s is taken as left over from a crash).
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
watches with a 150 ms file debounce and a 1.5 s re-cluster debounce; hitting
the OS watch limit degrades loudly. Re-scoping (changing which folders are
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
| TS/JS, Python, Go | ✅ | ✅ | ✅ | ✅ | ✅ | Node/Python recording; Go via delve |
| C# | ✅ | via `using` + namespaces | ✅ | - | regex | netcoredbg |
| Rust, Java, Ruby | ✅ | `mod`/`use`, `import`, `require` | ✅ | - | regex | Ruby rdbg; Java unverified |
| C++, C | ✅ | quoted `#include` (the header, or its implementing file) | ✅ | - | - | gdb DAP |
| Kotlin, Swift, PHP | not parsed | | | | | |

**Clustering** (`internal/cluster`): Louvain over a weighted graph of import
edges (3.0), TF-IDF similarity of symbol and file-name tokens (3.0) and git
co-change (1.5, from `git log`), recursive into nested systems with stable IDs
and TF-IDF names. Agents are asked to author the real tree (`name-architecture`
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
lists every installer host. Claude Code, Codex and Copilot CLI start fresh local
runs after the request is durably saved; editor/desktop hosts copy the handoff and
open the project/app when a launcher is available. The main process verifies the
registered project, current request state and claim before launching, supplies
workspace-bound MCP config, and records launch receipts/output under
`~/.ambio/delivery/`. Receipts prevent duplicate execution across retries/reloads;
review revisions permit another run. One managed run edits a root at a time.
Launch status is distinct from MCP claim and reply status. Runs edit the existing
graph root, can be stopped in the inbox, and are asked to stop when Ambio quits.
See INBOX_PROTOCOL's host table and recovery limits.

**Conversations** (`db/inbox.go`, `SendToAgentDialog.tsx`, `inboxModel.ts`):
a request is a turn in a thread (`canvas_outbox.thread_id`, `mode`). The claim
response hands the agent the thread's earlier turns (`db.InboxConversation`),
so context does not depend on the host. `electron/agentDrivers.ts` holds one
driver per started host: how to start a turn, continue the host's session,
apply the turn's mode as permissions, and read its output. The runner stores
host sessions per conversation and a run's activity events; `acpClient.ts`
drives hosts that speak the Agent Client Protocol. A session told to watch
waits on `get_inbox({watch: true})` and is offered as a destination; a turn
can be left for the watching session of one host (`target_host`). A started
agent's permission questions wait in archd (`api/agent_permission.go`, in
memory) and are answered in the panel (`store/agentPermissionStore.ts`).
Driver events are `text`, `tool`, `error` and `thinking` (Codex's reasoning
summaries); the turn shows the latest few while it works.

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
runs record calls in-process (Node load-time instrumentation, Python
`sys.monitoring`); DAP inspection mode for other languages is behind the MCP
debug profile. See [INVESTIGATIONS.md](INVESTIGATIONS.md).

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
