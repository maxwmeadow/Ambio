# Instructions for coding agents

You are working on Ambio: the bidirectional architecture
layer between a developer and their coding agents. Read
[docs/PRODUCT.md](docs/PRODUCT.md) once to understand what it is for.

## Where the work is

**[WORK.md](WORK.md) is the work list for every session.** Several agent
sessions run in parallel on this repo, each on its own branch.

- If you were given a task, check whether it is in WORK.md and follow that
  item's context and "Done when".
- If you were asked to "pick something up", follow *How to use this file* at
  the top of WORK.md: take the highest open item in *Now* that is not claimed,
  not ❓ (needs a decision) and not 👤 (needs Max), and claim it in your first
  commit.
- Anything you notice but are not doing now - a bug, a missing test, a stale
  doc, an idea - add to the *Inbox* at the bottom of WORK.md in one or two
  lines. Do not stop to fix unrelated things.
- When you finish, remove the item, add a line to the *Done log*, add a
  CHANGELOG line if users would notice, and update docs/ARCHITECTURE.md if you
  changed how something works.
- Never reverse a decision recorded in [docs/DECISIONS.md](docs/DECISIONS.md)
  on your own; raise it in WORK.md as a ❓ item instead.

## Repository map

- `archd-go/` - the Go daemon: indexing, clustering, journal, Review Changes,
  sheets, work orders, infra detection, runtime. Per-project SQLite.
- `electron/` - the Electron main process and preload.
- `src/renderer/` - React + React Flow UI; the canvas is `src/renderer/canvas/`.
- `src/shared/` - code shared by main and renderer (command model, settings).
- `mcp/` - the MCP server agents talk to.
- `adapters/` - run recorders for investigations (Node, Python, Ruby, PHP, the
  JVM agent and the C# rewriter; Go and Rust live in `archd-go/internal/runtime`).
- `docs/` - product, decisions, architecture, contracts; `docs/history/` is
  superseded plans.

## Checks before you commit

Run what covers your change, and read the results before committing:

```bash
npx tsc --noEmit                 # types
npm run test:renderer            # renderer, shared, Electron, MCP unit tests
cd archd-go && go vet ./... && go test ./...   # daemon
npm run test:mcp                 # MCP end to end (builds archd)
npm run test:chat                # Ambio chat's bundled harness, when chat changes
npm run build                    # the app bundles
```

## Rules that bite

- Canvas behaviour is specified in
  [docs/CANVAS_BEHAVIOR_CONTRACT.md](docs/CANVAS_BEHAVIOR_CONTRACT.md). Read it
  before changing the canvas; update it when behaviour changes on purpose.
- Every artifact must stay writable by both the human and the agent
  (docs/PRODUCT.md §1). Don't add a one-way feature without a WORK item for the
  other direction.
- Bump `db.SchemaVersion` (`archd-go/internal/db/db.go`) whenever a migration
  changes the schema, and add an upgrade fixture for the version you leave
  behind (`archd-go/internal/db/testdata/schemagen`).
- New archd calls from the renderer go through `archdApi()` / `archdWs()`
  (`src/renderer/archdEndpoint.ts`); never hard-code ports.
- All commands, menus and shortcuts come from `src/shared/appMenu.ts`.
- The MCP tool surface has a size budget ([docs/MCP_SURFACE.md](docs/MCP_SURFACE.md));
  prefer a new `op` or `scope` over a new tool.
- Tests use host paths (`path.resolve`, `path.delimiter`); CI runs on Linux,
  macOS and Windows.
- Match the surrounding code's naming, comments and idiom.

<!-- ambio:draw-first:v1 sha256=8943cd5d1afd14ce5091f335746208b350f93f20eb8a2a09536e663ebd14fbc1 -->
## Ambio: draw structural changes before code

When Ambio tools are available for this project, use this workflow for a new system, a new dependency between systems, or moving responsibility across a boundary. Bug fixes, tests, documentation and edits inside an existing boundary need no new sheet.

1. Read the relevant code and get_architecture overview/cross_dependencies. Confirm the connected workspace belongs to this project; if tools are unavailable or bound elsewhere, say so and do not pretend a plan was saved. Never work around missing tools by reading or writing Ambio's data (~/.ambio) or calling Ambio's local service directly.
2. Reuse the sheet supplied by the user or work order: read edit_sheet(get) and edit_sheet(compare), and the approved get_build_plan(sheet). Do not create a duplicate or replace the frozen work-order scope. Otherwise find a matching active sheet with edit_sheet(list), or create a small, named sheet with edit_sheet(create, name, purpose, members) using existing file paths/system IDs for context.
3. Before editing source, draw new systems/files/infra with plan_element(sheet, name, kind, parent, owns, declaredPath, notes): put each inside the system it belongs to (parent) and list the existing files or systems it takes over (owns). Reuse systems the map already has instead of redrawing them; propose that an existing file or system changes boundary with edit_sheet(move, sheet, members, target), and that a system is renamed with edit_sheet(rename, sheet, members, name). Draw dependencies with edit_sheet(connect, sheet, from, to, kind); use exact planned or live node IDs. Annotate responsibility moves and removals with edit_sheet(annotate, sheet, body), stating before/after and why. Never create a fictional live system or dependency to stand in for proposed code.
4. Tell the human the sheet name as a link, the proposed boundaries and dependencies, and what needs review. Agent-created elements stay pending: check get_build_plan(id) for each proposal. Do not approve your own plan or implement pending/rejected elements. An existing approved plan and explicit build instruction already authorize their scope; do not ask again. For an unapproved addition or a discussion-only request, return the concrete plan for review and wait for approval/build instruction. Do not poll continuously. An annotation or relationship alone is not an approval mechanism.
5. Build only the authorized scope. Call start_work before editing, carrying messageHandle for a claimed request; use its sessionId with update_work. After indexing, call edit_sheet(compare), bind approved planned nodes to their real counterparts and apply intended nesting using the latest revision/token. Report remaining structural differences and the actual checks you ran. Resolve only when equivalent, implementation checks pass, and completion was requested; never force a plan to match by changing the Floor. If scope changes, draw and review the addition first. Resume by reading the existing sheet and current approvals rather than redrawing it.
Write concise, user-facing replies about the project architecture. Use system and sheet names, never their IDs, hashes, internal relationship enums, claim handles or approval-state enums. Say "uses" or describe the actual interaction instead of DEPENDS_ON. Link a sheet as [sheet name](ambio://sheet/SHEET_ID); use its ID only inside the link target. Explain what changes, why it helps and what the person should review. Do not narrate tool calls, empty context pages, lease handling or absent review feedback. Mention a limitation only when it affects the result or requires the user to act. Propose only relationships that change; existing imports/calls are context, not new requirements. Keep file references selective.

<!-- /ambio:draw-first -->
