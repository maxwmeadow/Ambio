# Launch readiness

Status: living document. Tracks everything outside the live canvas that a
public launch needs, and every decision made along the way.
Started: 2026-09-29.

Legend: ✅ done · 🚧 in progress · ⬜ not started · ❓ needs a decision

---

## 1. Decisions

| Date | Decision |
|---|---|
| 2026-09-29 | **Audience:** all software developers - hobbyists, professionals, students, teachers. Goals: GitHub stars and reputation now; paid **collaboration** features later. The local app must stand on its own as great software. |
| 2026-09-29 | **Distribution:** GitHub Releases first. Ship macOS unsigned at first with clear instructions; buy the Apple Developer Program ($99/yr) before the public push. Apply to SignPath Foundation for free Windows signing. |
| 2026-09-29 | **Telemetry:** local rotating logs + "Report a bug" / "Copy diagnostics" always; an unchecked, opt-in crash-report prompt on first run; **no usage analytics**. `PRIVACY.md` promises code, file names, paths and project names never leave the machine. |
| 2026-09-29 | **Name:** "Axiom" was a placeholder. Rename **before** launch (it is baked into `~/.axiom`, `com.axiom.app`, the `axiom` MCP server entry and `/axiom-map`). See §3. |
| 2026-09-29 | **What a project is:** usually one git repo, but multi-repo, multi-worktree and plain folders must all work. (archd already models several roots per workspace.) |
| 2026-09-29 | **No project limit.** The registry is unlimited; the launcher shows a short recent list with "Show all". |
| 2026-09-29 | **Moved folders** are detected and the user is offered to locate them. Axiom repoints its own records; it never moves user files. |
| 2026-09-29 | **Remove vs delete (decided by Claude, per "up to you"):** the row's ⋯ menu offers *Hide from recents* (non-destructive; searchable, "Show all" still lists it) and *Delete project map…* (destructive, confirmation focuses Cancel, Enter no longer confirms). |
| 2026-09-29 | **Agents when Axiom is closed:** must be graceful in every way. See §4. |
| 2026-09-29 | **One install, nothing else to set up.** The MCP server should run on Electron's bundled Node; investigations' toolchain needs (MSYS2 etc.) become a separate track. |
| 2026-09-29 | **Accessibility and light theme:** wanted, end of the list. |
| 2026-09-29 | **Sample/demo project:** not now. |
| 2026-09-30 | **License: AGPL-3.0-only + CLA** (CLA Assistant bot, signatures on the `cla-signatures` branch). The paid collaboration service stays in a separate private repository. |
| 2026-09-30 | **Menus and Settings:** build the standard basics now; specifics later. |
| 2026-09-30 | **Name:** on hold. |

---

## 2. License ✅ AGPL-3.0 + CLA (decided 2026-09-30)

The goal pulls two ways: *loved open-source tool* (stars, job offers) and
*a business that can't be taken* (paid collaboration later).

| | Read, run, contribute | Stops a competitor selling it | "Open source" label |
|---|---|---|---|
| MIT / Apache-2.0 | ✅ | ❌ | ✅ |
| **AGPL-3.0 + CLA** | ✅ | ⚠️ Deters strongly: anyone who ships or hosts a modified version must publish all of it, including their own collaboration server. | ✅ |
| **FSL-1.1-ALv2 + CLA** | ✅ | ✅ Forbids competing commercial use outright; each release becomes Apache-2.0 after 2 years. | ❌ ("fair source") |

**Recommendation: AGPL-3.0 + a CLA.** It serves both halves:

- **Stars and reputation are the near-term, certain goal.** AGPL is a real
  OSI license. "Open source" on the README, the HN post and a résumé carries
  weight that "source-available" does not.
- **The business is the paid collaboration service, which you write and keep
  closed.** The app being AGPL does not put your server in anyone's hands. A
  competitor could fork the app, but they would have to publish every change,
  including any hosted collaboration layer they build on it. In practice that
  keeps companies from building a closed rival on your code.
- **The CLA is what keeps it yours.** Contributors grant you the rights to
  their contributions, so you alone can relicense, sell commercial licenses
  to companies that won't accept AGPL, or tighten the license later. This is
  the open-core playbook of Grafana, Mattermost, Cal.com and Plane.

Choose **FSL** instead if a *hard* ban on competing products matters more
than the open-source label. Sentry and GitButler use it. The cost is some
"that's not open source" pushback.

Either way:

- Relaxing a license later is well received; tightening one after launch
  causes backlash (HashiCorp → OpenTofu, Redis → Valkey).
- A license protects code, not ideas. Your moat is shipping first, the
  community, and the closed collaboration server.
- Get a quick legal review before charging money.

---

## 3. Name - first pass (2026-09-29)

Not a trademark clearance: domain checks by RDAP lookup, conflicts by web
search. A real USPTO/EUIPO search comes before committing.

**Why rename:** Axiom (axiom.co) is a funded observability company that
sells to developers - same name, same audience.

**What the check shows:**

- Every single dictionary word tried is registered in both `.com` and `.dev`:
  Orrery, Trellis, Floorplan, Cartograph, Strata, Truss, Plinth, Overlook,
  Topos, Surveyor, Tessera, Holon, Groundplan, Girder, Vantage, Archway,
  Meridian, Terrain, Keel, Isograph, Lintel, Architrave, Mapwright,
  Codewright, Cairn, Waymark, Plat, Cadastre, Topograph, Gantry, Corbel,
  Ossature, Armature, Tecton, Codescape.
- The AI-coding-tool namespace is crowded. There are at least 5 "Cairn"
  agent tools; "Mapwright" is already an AI app-spec tool; "Lintel" has two
  developer tools; "Orrery" is a new MCP-speaking desktop editor.
- Registered does not mean in use; many are parked. The usual pattern is a
  distinctive name plus `.dev`/`.app`/`.sh`, or `get<name>.com`.

| Candidate | Metaphor | Domains free (2026-09-29) | Known conflicts |
|---|---|---|---|
| Codeterrain | the lay of the land of your code | .dev, .app | none found |
| Systemscape | the landscape of your systems | .dev, .app | small OSS "visual systems sandbox" on GitHub; SystemScape Ltd (embedded) |
| Stratagraph | a drawing of layers | .app | oilfield data company |
| Orrerium | a live mechanical model of moving parts | .dev, .app | a tiny GitHub project |
| Structory | structure + story | .dev, .app | not searched |
| Kinetograph | a picture of motion | .dev, .app | not searched |
| Mapstead | where the map lives | .dev, .app | not searched |

What makes a good name here: easy to say, spell and search; evokes seeing or
steering *live* structure; free as a GitHub org and on npm; no developer-tool
trademark collision. Next step: shortlist 3, check USPTO/EUIPO classes 9 and
42, check GitHub org and npm, say them out loud.

---

## 4. Agents when Axiom is closed ✅ (2026-09-30)

**Built:** archd writes `~/.axiom/data/daemon.json` (pid, version, ports,
headless) while it runs. In packaged builds the MCP server knows where archd
is (`archd mcp-run` passes `AXIOM_ARCHD_PATH`); when archd does not answer it
starts it with `-headless`, waits for it and retries, and otherwise tells the
agent "Axiom is not running. Open the Axiom app, then try again." A headless
daemon exits after 15 minutes with no requests and no open windows. When the
app starts it attaches to a running daemon of its own version, asks one from
another version to stop (`POST /api/daemon/shutdown`), and polls an attached
daemon so it can take over if it disappears. Quitting the app stops only the
daemon the app started.

**Still open:** a headless daemon
answers from the persisted map but does not watch files until the app opens
the project, when reconcile catches up (the Morning Delta covers the gap).

Original design notes:

How it works today: the agent (Claude Code, Cursor, …) launches the MCP
server itself as a separate process over stdio. The MCP server talks HTTP to
archd on `127.0.0.1:7743`, and archd only runs while the desktop app is open.
So with Axiom closed, the agent still *connects* to the MCP server, and every
tool call then fails with a network or token error.

Target design, graceful in every case:

1. **archd outlives the window.** One daemon per machine, found through a
   discovery file (`daemon.json`: pid, ports, version, token path) instead of
   hard-coded ports. The app attaches to a running daemon rather than
   spawning a second one. This also fixes port conflicts and the
   second-instance race.
2. **The MCP server starts archd on demand** when it isn't running (headless,
   no window), so agent work is still recorded, and the Morning Delta shows
   it next time the app opens.
3. **If archd cannot start,** tool calls return one clear, actionable
   sentence ("Axiom isn't running - open Axiom and retry"), never a stack
   trace.
4. **Version handshake:** an MCP server or app newer than the running daemon
   restarts it cleanly after an update.
5. **Idle shutdown:** a headless daemon with no clients exits after a quiet
   period, unless a "keep running in the background" preference (tray or
   menu-bar icon) is on.

---

## 5. Menus, shortcuts and settings - basics built ✅, specifics open

**Built (2026-09-30):** one command model (`src/shared/appMenu.ts`) drives
the native macOS menu bar, the title-bar menu bar on Windows/Linux, the
command palette (`⇧⌘P` / `Ctrl+Shift+P`), keyboard shortcuts and the
Keyboard Shortcuts reference (`⌘/`). Menus: Axiom (macOS), File, Edit, View,
Agent, Window (macOS), Help. Settings (`⌘,`): General (reopen last project,
automatic update checks, check now), Appearance (interface zoom, reduce
motion), Agents, Privacy & Data (data/log folders, diagnostics), Advanced
(developer menu). About dialog. Production builds no longer show Electron's
Reload/DevTools unless the developer menu is on.

**Added 2026-09-30:** Go menu (The Floor `⌘1`, next/previous sheet
`⌘]`/`⌘[`), Map menu (New Sheet `⌘T`, Add Infrastructure, Lasso Select, Tidy
Layout `⇧⌘L`, Review Changes), File → Open Recent (native submenu on macOS, inline
list on Windows/Linux, Clear Recently Opened), Re-index Project, and
right-click menus on the live canvas: files (Open in Editor, Reveal, Copy
Path, Copy Relative Path, Show Details, Message Agent), systems (Show Details,
Zoom to System, Copy Name, Message Agent), infrastructure, and empty canvas
(New Sheet, Add Infrastructure, Lasso, Fit).

**Not yet:** Export, canvas undo/redo, light theme, rebindable shortcuts. The list below is the
original brainstorm those will come from.

Desktop apps share a grammar. Users expect standard items in standard places;
Axiom-specific commands go in their own menus. This is a proposal to react
to, not a decision.

On **macOS** the menu bar is native. On **Windows/Linux** the window uses a
custom title bar, so no native menu bar shows. The standard answer (VS Code,
Figma, Slack) is a menu button in the title bar that opens the same menus.
Keyboard accelerators then work everywhere.

`⌘` means Ctrl on Windows/Linux.

### Axiom (macOS only; on Windows/Linux these items move to File and Help)
- About Axiom
- Check for Updates…
- Settings… `⌘,`
- Services, Hide Axiom `⌘H`, Hide Others, Show All
- Quit Axiom `⌘Q`

### File
- New Project… `⌘N`
- Open Folder… `⌘O`
- Open Recent ▸ (last 10, "Show All Projects…", "Clear Recents")
- Add Folder to Project… (multi-repo roots)
- ---
- Project Settings… (name, folders, exclusions, re-index)
- Reveal Project in Finder/Explorer
- Re-index Project
- ---
- Export Map… / Import Map… (`.axiommap`, §6 Protecting maps)
- Export ▸ Canvas as PNG / SVG, Architecture as Markdown / Mermaid *(later)*
- ---
- Close Project `⇧⌘W` (back to the launcher)
- Settings… / Exit (Windows/Linux)

### Edit
- Undo `⌘Z`, Redo `⇧⌘Z`, which needs a canvas undo stack (a big item on its own)
- Cut, Copy, Paste, Select All, required for text fields to behave natively
- Rename `F2`, Delete `⌫`
- Find in Map… `⌘F`

### View
- Command Palette… `⇧⌘P` *(recommended: every command, searchable - the
  single biggest discoverability win)*
- Search Files… `⌘K` (today's search)
- ---
- Map: Fit `⌘0`, Zoom In `⌘=`, Zoom Out `⌘-`, Infrastructure Sidebar `⇧⌘E` (Zoom to Selection later)
- Interface zoom: `⌥⌘=`, `⌥⌘-`, Actual Size `⌥⌘0` (the map owns the plain zoom keys; decided when merging the infrastructure work)
- Agent Log `⇧⌘A` (moved from `⇧⌘L`, which is Tidy Layout)
- ---
- Panels ▸ Sheet Rail, Detail Panel, Documents, Agent Log, Status Bar
- Review Changes (Morning Delta)
- ---
- Appearance ▸ Dark / Light / System *(light is end-of-list)*
- Reduce Motion
- Toggle Full Screen `⌃⌘F` / `F11`
- Developer ▸ Reload, Toggle DevTools (hidden unless enabled in Settings)

### Go
- Back `⌘[`, Forward `⌘]` (camera and selection history)
- Go to File… `⌘P`, Go to System…, Go to Symbol… `⇧⌘O`
- The Floor `⌘1`, Next Sheet, Previous Sheet
- Next Change `J`, Previous Change `K` (delta review)
- All Projects `⇧⌘H`

### Map (Axiom-specific)
- New Sheet… `⌘T`, New System…, Add Infrastructure…
- Lasso Select `L`, Tidy Layout
- Review Proposal…

### Agent
- Message Agent… `⌘↵`
- Inbox
- Investigations ▸ …
- Start/Stop Recording
- Agent Log
- ---
- Connect an Agent… (today's Connect screen)
- Repair Agent Connections
- Remove Axiom from Agents… (uninstall: the MCP entries and skills Axiom wrote)

### Window
- Minimize `⌘M`, Zoom, Bring All to Front

### Help
- Getting Started (reopen the setup guide)
- Keyboard Shortcuts `⌘/`
- Documentation, What's New
- ---
- Report a Bug… (pre-filled GitHub issue), Copy Diagnostics, Open Logs Folder
- Request a Feature / Discussions
- ---
- Privacy, License and Acknowledgements
- Check for Updates…, About (Windows/Linux)

### Right-click menus
- **File or system node:** Open in Editor, Reveal in Finder/Explorer, Copy
  Path, Copy Relative Path, Rename, Send to Agent…, Show Dependencies / Show
  Dependents, Move to System…
- **Empty canvas:** New System Here, Paste, Tidy Layout, Fit to Screen
- **Launcher project row:** ✅ built. Open, Reveal, Change Folder Location…,
  Hide from Recents, Delete Project Map…

### Settings
- **General:** reopen last project on launch, number of recents, check for
  updates automatically, update channel (stable/beta), keep running in
  background (tray)
- **Appearance:** theme, UI scale, reduce motion, canvas animation intensity
- **Canvas:** edge style, semantic-zoom thresholds, show churn heat, snap to grid
- **Agents:** connected agents, default agent, repair, remove from agents
- **Indexing:** global exclude patterns, max file size, languages, docs indexing
- **Privacy:** crash reports on/off, open logs, clear all Axiom data
- **Advanced:** data folder, ports (until auto-discovery lands), developer
  tools, reset onboarding
- **Shortcuts:** view and rebind *(later)*

---

## 6. Checklist

### Get it and trust it
- ⬜ Rename (§3)
- ✅ LICENSE (AGPL-3.0, official text), `CLA.md`, CLA Assistant workflow, `license` in package.json
- ✅ Third-party licenses: `scripts/third-party-notices.mjs` checks every shipped npm package and linked Go module against an AGPL-compatible allowlist (CI fails otherwise), writes `THIRD_PARTY_NOTICES.txt` at package time, and the app shows it in Help → Acknowledgements. The audit removed five unused dependencies, including `elkjs` (EPL-2.0 without a GPL secondary-license notice, which is not AGPL-compatible)
- Have a lawyer glance at `CLA.md` before charging money (it grants relicensing rights, modelled on the Apache ICLA)
- ⬜ Enable GitHub private vulnerability reporting (repo Settings → Security) when the repo goes public
- ⬜ Clean the repo root: move internal notes (`CODEX_BRIEF.md`, `CANVAS_BUG_HUNT.md`, `PARALLEL_AGENTS_BRIEF.md`, …) into `docs/` or remove
- ✅ `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`, issue and PR templates
- ⬜ `CODE_OF_CONDUCT.md` (needs a contact address for reports)
- ✅ Secret scan of full git history (124 commits, 2026-09-29): no keys, tokens, private keys, env files or databases found. One manual test script hard-coded a personal Windows path; it now uses env vars / the checkout path. Re-run before flipping the repo public.
- ✅ README install section: per-OS steps including unsigned-app warnings, updates, privacy link
- ✅ README rewritten for users (what it does, your data, uninstall, docs links); ⬜ hero GIF/video still to record (placeholder comment at the top)
- ✅ Release workflow publishes tagged builds to a draft GitHub Release with `latest*.yml`; fails fast if the tag and `package.json` version differ
- ⬜ The two macOS jobs (arm64, x64) each write `latest-mac.yml`; merge them (or build universal) before macOS auto-install is switched on
- ⬜ Windows signing via SignPath; macOS signing + notarization once enrolled
- ✅ MCP server runs on Electron's bundled Node via `archd mcp-run` (no system Node needed). Existing agent configs keep working on system Node; reinstalling from Connect an Agent moves them over.

### Opening Axiom (2026-09-30)
- ✅ `axiom .` terminal command (Settings → Advanced → Command-line launcher): installs into a writable folder on PATH, or gives the one command to run
- ✅ Drop a folder (or a file inside a project) on the window, or on the macOS dock icon
- ✅ Recent projects in the macOS dock menu, the Windows jump list, and the OS recent-documents lists
- ✅ `axiom://open?path=…` and `axiom://project/<id>` links; a link to a folder Axiom does not know asks before adding it
- ✅ A path inside a known project opens that project (most specific wins); launching with a path skips resuming the last project

### Large projects (2026-09-30)
- ✅ Files over 1 MB and `*.min.*` files are skipped (generated code); a file that grows past the limit keeps its last parse
- ✅ Setup and Project Settings estimate the scope as you toggle folders and warn above ~15,000 source files, naming the largest folders
- ✅ Stop button while indexing; a stopped index explains itself and links to Project Settings
- ✅ Linux inotify / open-file limits no longer fail silently: the app says live updates are off and offers the exact command to raise the limit
- ✅ Measured idle cost: archd uses no CPU and ~6 MB when idle; Git is watched by events with a 5-minute safety poll

### Security and privacy (2026-09-30)
- ✅ Renderer sandboxed; production Content Security Policy (own scripts + WebAssembly, loopback connections only); no new windows, navigation, web views or device permissions; links open in the browser (http/https only)
- ✅ Fonts bundled: Axiom no longer requests Google Fonts on every launch (a privacy leak and an offline failure)
- ✅ "Open in Editor" opens source in the detected code editor (Settings → General → Open files in), never through the OS default handler that can execute scripts; file open/reveal/list only inside registered projects
- ✅ archd rejects non-loopback Host headers (DNS rebinding); older token files tightened to 0600
- ✅ SECURITY.md documents the security model and its one known boundary (the runtime-adapter port)

### Protecting maps (2026-09-30)
A map holds hours of human and agent work (systems, layout, sheets, history) that re-indexing cannot recreate.
- ✅ Recently Deleted: deleting a project map moves it to `~/.axiom/data/.trash` for 30 days (archd `DELETE /api/workspace/:id?trash=1`, or a local move when archd is down). The launcher lists them (Import a map · Recently deleted (n)) with Restore and Delete Forever; expired entries are purged at startup. Restoring refuses to take over a folder another project now owns
- ✅ Daily backups: when a project opens, archd takes a `VACUUM INTO` snapshot if the last one is over 24 h old, keeping 7 (`<project>/backups/`). Project Settings → Map backups lists them; Restore snapshots the current map first (`before-restore-*`), so a restore can be undone
- ✅ Export / Import: File → Export Map… writes a `.axiommap` (a SQLite snapshot plus a manifest table: project id, name, folder, settings, app and schema version). Import refuses maps from a newer schema, asks before replacing an existing map (the old one goes to Recently Deleted), uses the exported folder when it exists here or asks where the code lives, and rebases exclusions. Moves a project to a new computer; also a manual backup
- Not covered: backups live in the same data folder as the map, so a lost disk loses both. Export is the off-machine answer until sync exists

### First launch
- ✅ Single-instance lock; launching again focuses the existing window
- ✅ Application menu (§5): native on macOS, drawn in the title bar on Windows/Linux
- ✅ Remember window size, position and maximized state (never onto a disconnected monitor)
- ⬜ First-run crash-report opt-in

### Project setup and management
- ✅ Unlimited projects; launcher shows 8 recents + "Show all"; search covers everything
- ✅ Command Deck status loads for every visible row (was: first 6 only)
- ✅ Missing-folder detection, "Locate folder…" and "Change folder location…"; archd repoints the root and keeps the map (`POST /api/workspace-relocate`)
- ✅ Row actions menu; Hide from recents separate from Delete project map
- ✅ Resume skips a project whose folder is missing
- ✅ Project Settings (File → Project Settings…, the palette, or the launcher's project menu): rename, and change included folders starting from the project's saved choices; exclusions inside unexpanded folders are kept
- ✅ Quiet re-scope: files moving in or out of scope (and relationships touching them, and system births/deaths during the re-scan) are not journaled, so the Morning Delta never reports an exclusion as deleted code; concurrent real edits still are
- ✅ Re-index Project (File menu, palette, Project Settings): re-reads every file regardless of timestamps, keeping systems, layout and history; real content changes are journaled, unchanged files are not, and files indexed before content hashes existed are refreshed quietly
- ⏸ Add a second folder/repo to a project - **held: needs a core design pass, not launch plumbing.** What works today: open the *parent* folder that holds several repos; it is indexed as one project. Separate folders in unrelated locations need:
  - root sync that adds a root instead of deactivating every root it did not just discover (`syncWorkspaceWorktrees` treats the requested path as the only graph root);
  - clustering that only removes stale systems belonging to its own root (`clusterAndAssign` runs per root, systems are workspace-wide);
  - Morning Delta, history identity and work sessions that span roots (all resolve to one primary root today);
  - a decision on cross-root edges (imports between repos) and how roots appear on the Floor.
- ⬜ Multi-root projects in the UI (backend already supports roots)
- ⬜ Worktrees of one repo: one project or two - decide and make it explicit

### Daily use
- ✅ Settings window, basics (§5)
- ✅ Command palette and keyboard shortcut reference
- ⬜ Canvas undo/redo

### Staying current
- ✅ Auto-update via electron-updater + GitHub Releases: Windows and AppImage download and install on restart; macOS and non-AppImage Linux are told a version is available and linked to it
- ⬜ Turn on macOS auto-install once signed
- ✅ CHANGELOG.md (Keep a Changelog) ships with the app; after an update Axiom shows that version's section once as What's New (Help → What's New any time); contributors add a line per user-visible change
- ✅ Database downgrade guard: `PRAGMA user_version` stamped with `db.SchemaVersion`; a newer database is refused with a clear message. **Bump `SchemaVersion` whenever `migrate` changes.**

### When it breaks
- ✅ archd auto-restarts with backoff (5 in 60s), the open project is re-registered, and the UI says what is happening; gives up loudly with "Try again"
- ✅ Port-in-use and repeated crashes explained in plain language
- ✅ Launch-failure dialog written for users (build instructions only in dev)
- ✅ Log files (main, archd, renderer warnings/errors) in `~/.axiom/logs`, 2 MB × 3 each
- ✅ Report a Bug / Copy Diagnostics / Open Logs on the launcher, the archd failure notice and the crash screen (Help menu later)
- ✅ Crash screen rewritten for users: code and map are safe, Try again, report, details folded
- ✅ Crashes captured locally (Electron minidumps, never uploaded) and counted in diagnostics; uncaught errors in the main process and the window are logged
- ⬜ Opt-in crash upload, when there is a destination (Sentry/GlitchTip project). Design: a first-run choice with nothing pre-selected, the exact fields listed, never code, file names, paths or project names; PRIVACY.md updated before it ships
- ✅ Daemon discovery and graceful agent behaviour when the app is closed (§4)
- ✅ Ports: archd prefers 7743-7745 and, when another program holds one, binds a free port and publishes it in `daemon.json`; the app, renderer and MCP server follow it. archd also takes an OS lock on its data folder, so two daemons can never share the databases

### Leaving
- ✅ "Remove Axiom from agents": per agent on Connect an Agent, or all at once in Settings → Agents. Removes only the `axiom` entry and Axiom's workflow files; leaves files it cannot parse untouched, and keeps config or skill folders another still-installed agent shares
- ✅ Settings → Privacy & Data → Delete all Axiom data (native confirmation, stops archd, restarts fresh)
- ✅ Uninstall per OS documented in the README

## 7. Design notes (not built)

### Maps committed to the repo (`.axiom/` in the project)
The question: should a project's map live in the repository, so cloning a repo brings its architecture with it?

- **For:** teams and open-source projects share one map; the map is versioned with the code it describes; agents on CI or another machine read the same systems; strong growth loop (a public repo's `.axiom/` advertises Axiom).
- **Against:** SQLite does not merge. Two branches that both move a node conflict as a binary file. A text format (one JSON/YAML file per system and sheet, stable ordering, positions rounded) would merge, but it means a serialization layer and a merge story for every table. Index data (symbols, edges) is derived and must stay out of git; only human intent (systems, names, layout, sheets, decisions) belongs in the repo.
- **Business overlap:** shared maps are the core of the paid collaboration tier. A committed `.axiom/` is free collaboration through git. That is fine and probably good for adoption (it is how people will first share maps), as long as the paid tier offers what git cannot: live presence, comments, review workflows, cross-repo maps, hosted agents, org history. Decide deliberately before building either.
- **Suggested shape if pursued:** `.axiom/map/` text files for intent only, written on save and read on open; the local SQLite stays the working copy and index; a `.gitattributes` merge driver later. Opt-in per project ("Share this map with the repo"). Start read-only (import a committed map) before write-back.

### Multiple windows
Today one window shows one project; opening another replaces it.

- **Needed for:** comparing two projects, a map on one monitor and review on another, two repos an agent works across.
- **Cost:** main assumes one `mainWindow` and one `activeProject` (IPC handlers, menu state, the token-injection hook's `webContentsId` check, the MCP `active_project.json` pointer, dock/jump list, resume). Each becomes per-window state. archd already serves many workspaces at once, so the backend is ready.
- **Open decisions:** which project agents act on when two are open (today `active_project.json` names one; agents could instead name the project, or follow the focused window); whether a second window of the *same* project is allowed (probably yes, read-only views like review); window restore on relaunch.
- **Suggested order:** make agent project selection explicit first (it is also needed for multi-root), then per-window state in main, then File → New Window.
