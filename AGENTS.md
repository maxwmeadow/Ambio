# Instructions for coding agents

You are working on Axiom (a working name): the bidirectional architecture
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
- `adapters/` - runtime recording adapters (Node, Python).
- `docs/` - product, decisions, architecture, contracts; `docs/history/` is
  superseded plans.

## Checks before you commit

Run what covers your change, and read the results before committing:

```bash
npx tsc --noEmit                 # types
npm run test:renderer            # renderer, shared, Electron, MCP unit tests
cd archd-go && go vet ./... && go test ./...   # daemon
npm run test:mcp                 # MCP end to end (builds archd)
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
  changes the schema.
- New archd calls from the renderer go through `archdApi()` / `archdWs()`
  (`src/renderer/archdEndpoint.ts`); never hard-code ports.
- All commands, menus and shortcuts come from `src/shared/appMenu.ts`.
- The MCP tool surface has a size budget ([docs/MCP_SURFACE.md](docs/MCP_SURFACE.md));
  prefer a new `op` or `scope` over a new tool.
- Tests use host paths (`path.resolve`, `path.delimiter`); CI runs on Linux,
  macOS and Windows.
- Match the surrounding code's naming, comments and idiom.
