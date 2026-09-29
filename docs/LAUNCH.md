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

## 4. Agents when Axiom is closed

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

## 5. Menus, shortcuts and settings - brainstorm ❓

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
- Zoom In `⌘=`, Zoom Out `⌘-`, Fit to Screen `⌘0`, Zoom to Selection
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
- ⬜ Have a lawyer glance at `CLA.md` before charging money (it grants relicensing rights, modelled on the Apache ICLA)
- ⬜ Enable GitHub private vulnerability reporting (repo Settings → Security) when the repo goes public
- ⬜ Clean the repo root: move internal notes (`CODEX_BRIEF.md`, `CANVAS_BUG_HUNT.md`, `PARALLEL_AGENTS_BRIEF.md`, …) into `docs/` or remove
- ✅ `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`, issue and PR templates
- ⬜ `CODE_OF_CONDUCT.md` (needs a contact address for reports)
- ✅ Secret scan of full git history (124 commits, 2026-09-29): no keys, tokens, private keys, env files or databases found. One manual test script hard-coded a personal Windows path; it now uses env vars / the checkout path. Re-run before flipping the repo public.
- ✅ README install section: per-OS steps including unsigned-app warnings, updates, privacy link
- ⬜ README hero: GIF/video first
- ✅ Release workflow publishes tagged builds to a draft GitHub Release with `latest*.yml`; fails fast if the tag and `package.json` version differ
- ⬜ The two macOS jobs (arm64, x64) each write `latest-mac.yml`; merge them (or build universal) before macOS auto-install is switched on
- ⬜ Windows signing via SignPath; macOS signing + notarization once enrolled
- ✅ MCP server runs on Electron's bundled Node via `archd mcp-run` (no system Node needed). Existing agent configs keep working on system Node; reinstalling from Connect an Agent moves them over.

### First launch
- ✅ Single-instance lock; launching again focuses the existing window
- ⬜ Real application menu (§5) and Windows/Linux title-bar menu button
- ✅ Remember window size, position and maximized state (never onto a disconnected monitor)
- ⬜ First-run crash-report opt-in

### Project setup and management
- ✅ Unlimited projects; launcher shows 8 recents + "Show all"; search covers everything
- ✅ Command Deck status loads for every visible row (was: first 6 only)
- ✅ Missing-folder detection, "Locate folder…" and "Change folder location…"; archd repoints the root and keeps the map (`POST /api/workspace-relocate`)
- ✅ Row actions menu; Hide from recents separate from Delete project map
- ✅ Resume skips a project whose folder is missing
- ⬜ Project Settings screen (rename, exclusions after setup, re-index, add folder)
  - ⚠️ Changing exclusions must not journal as file deletions. Today a re-scope
    reconciles through `RemoveFile`/`ReindexFile`, which record drift, so the
    Morning Delta would claim excluded files were deleted. Needs a quiet
    reconcile mode (like the baseline/migration passes) before this ships.
- ⬜ Multi-root projects in the UI (backend already supports roots)
- ⬜ Worktrees of one repo: one project or two - decide and make it explicit

### Daily use
- ⬜ Settings window (§5)
- ⬜ Command palette and keyboard shortcut reference
- ⬜ Canvas undo/redo

### Staying current
- ✅ Auto-update via electron-updater + GitHub Releases: Windows and AppImage download and install on restart; macOS and non-AppImage Linux are told a version is available and linked to it
- ⬜ Turn on macOS auto-install once signed
- ⬜ What's New after update
- ✅ Database downgrade guard: `PRAGMA user_version` stamped with `db.SchemaVersion`; a newer database is refused with a clear message. **Bump `SchemaVersion` whenever `migrate` changes.**

### When it breaks
- ✅ archd auto-restarts with backoff (5 in 60s), the open project is re-registered, and the UI says what is happening; gives up loudly with "Try again"
- ✅ Port-in-use and repeated crashes explained in plain language
- ✅ Launch-failure dialog written for users (build instructions only in dev)
- ✅ Log files (main, archd, renderer warnings/errors) in `~/.axiom/logs`, 2 MB × 3 each
- ✅ Report a Bug / Copy Diagnostics / Open Logs on the launcher, the archd failure notice and the crash screen (Help menu later)
- ✅ Crash screen rewritten for users: code and map are safe, Try again, report, details folded
- ⬜ Opt-in crash reporting
- ⬜ Daemon discovery and graceful agent behaviour when the app is closed (§4)

### Leaving
- ⬜ "Remove Axiom from agents" (undo every installer write)
- ⬜ "Clear all Axiom data" in Settings; document uninstall per OS
