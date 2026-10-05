# Changelog

All notable changes to Ambio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's section is shown
in the app as "What's New" after updating, so write it for users.

## [Unreleased]

### Changed
- Axiom is now Ambio. Your maps, settings and agent connections move over
  automatically the first time you open it.

### Added
- Agents receive guidance to draw structural changes on a sheet before editing
  code, reuse approved plans, and compare after building. Project reminders
  support every installed coding host; Claude Desktop receives MCP/chat guidance.
- Agents can draw typed dependencies between planned and existing sheet nodes.
- Work-order destinations for every supported agent: start a new Claude Code,
  Codex or Copilot CLI run from Send, or copy the handoff and open your editor.
  Managed runs show launch failures, local output and a Stop control.
- Help → Send Feedback… (also on the launcher).
- Review Changes counts agent changes nobody explained; click to see them.
- Ask, Propose or Build when you send to an agent: a question changes
  nothing, a proposal is drawn on a sheet for you to confirm first.
- Split System… on a system's right-click menu draws the split on a sheet
  for an agent to build.
- Paste a Mermaid flowchart into New Sheet from Markdown… to draft it as a
  sheet.
- Map → Copy Map as Mermaid: paste the architecture into a README, PR or
  issue and GitHub draws it.
- Starter sheets: add an endpoint, extract a service, add a queue consumer,
  split a system (Map → New Sheet from Markdown…).
- Undo and redo moving and resizing on the map (⌘Z / ⌘⇧Z).
- The Agent inbox shows work orders by stage: waiting, working, to review,
  accepted and cancelled.
- View → Panels: show or hide the sheet rail, detail panel and status bar;
  Ambio remembers your choice.
- Review Changes shows infrastructure changes: "Orders now writes to Redis",
  "Billing no longer reads from Postgres".
- Review Changes filters: by who made a change, the work it belongs to, its
  kind and system; mark changes seen (S) and hide them.
- Agent slash commands `/ambio:propose`, `/ambio:implement` and `/ambio:review`
  in hosts that show MCP prompts.
- Sheets as Markdown: copy a sheet as a Markdown spec for a PR or AGENTS.md,
  and turn a pasted spec into a draft sheet (Map menu).
- A system notification when an agent picks up or replies to a work order
  while Ambio is in the background (Settings → General to turn it off).
- Agents starting work also hear which proposed systems and infrastructure you
  rejected or confirmed, and why.
- New Sheet from Selection: right-click a system, file or infrastructure node
  to start a sheet with it (or with everything selected).
- ⌘K finds systems, infrastructure and functions or classes, not only files;
  picking a symbol shows its file on the map and opens the code at it. The
  Model Explorer's search reaches symbols in every file.
- View → Zoom to Selection (⌘⇧0) frames what you have selected; Tidy Layout
  is in the right-click menu on empty canvas.
- Command palette, keyboard shortcuts and a shortcut reference; full menus
  (File, Edit, View, Go, Map, Agent, Help) and right-click menus on the map.
- Settings: reopen last project, update checks, interface zoom, reduce
  motion, the editor used by Open in Editor, and more.
- Project Settings: rename a project, change which folders Ambio reads, and
  re-index in place. Changing folders never shows up as code changes in your
  review.
- Open projects with `ambio .` from a terminal, by dropping a folder on the
  window or dock, from the dock menu or Windows jump list, and from
  `ambio://` links.
- Agents keep working while Ambio is closed: Ambio's background service
  starts on demand and stops when idle, and keeps the map current with what
  the agent changes.
- Remove Ambio from any agent, or from all of them, in one step.
- C projects (`.c`, `.h`) are read, with `#include` relationships.
- Rust, Java, Ruby and C++ projects get import relationships, so their
  systems group by what the code uses, not just by names.
- Moved or renamed project folders are detected; point Ambio at the new
  location and the map comes with it.
- Report a bug, Copy diagnostics and local log files; automatic updates.
- A warning before indexing a very large folder, and a Stop button while
  indexing.
- Clear all Ambio data from Settings.
- Recently Deleted: a deleted project map can be restored for 30 days.
- Automatic daily backups of every map, with Restore in Project Settings.
- Export a project's map to a file and import it on another computer
  (File → Export Map, Import Map).
- Infrastructure (databases, queues, caches, external APIs, hosting) is
  detected from code and config and shown in a sidebar; hosting appears as
  frames around the systems it runs.
- Send a sheet to an agent as a work order, and review what it built
  against the plan.
- On the map, where you put something is what it belongs to: drag a file
  into a system to move it there, drag a system into another to nest it, or
  onto open canvas to take it out. Rename a system by double-clicking its
  name; right-click to group files into a new system or ungroup one. Delete
  on a system ungroups it and never touches code. Each change offers Undo.
- Changes that need code start a work order from the map: right-click open
  canvas for New System Here…, which draws a planned system on a new sheet
  ready to send, or right-click a file or system to draw its removal on a
  new sheet and send it to an agent.
- Draw a connection between two live systems or files on the map to propose
  a new dependency; it opens on a sheet ready to send, and counts as done
  once the code actually depends that way.
- Copy a review as Markdown, for a pull request description or a standup.
- An agent starting work is told what you changed on the map since it last
  worked here, and which of its proposals you rejected and why, so it builds
  on your decisions instead of undoing them.
- When an agent draws a sheet or proposes something on one, Ambio tells you
  and marks the sheet NEW; its proposals are outlined on the map and listed
  in the sheet rail to confirm or reject with one click.
- Edit → Undo and Redo (⌘Z / ⌘⇧Z) undo and redo map changes made on the
  map - moves into systems, renames, grouping - and still undo typing in
  text fields.
- Model Explorer (View menu, ⌘⇧O): the map as a searchable outline of
  systems, files and symbols, synced with the canvas selection and fully
  usable from the keyboard.
- Sheets can propose removing code: press Delete on a live file or system on
  a sheet. It disappears from that sheet only, stays listed with Restore, and
  a sent work order counts it as done once the code is really gone. Agents
  can propose removals too.
- When you move a file on the map and the code disagrees - it lives in
  another system's folder, or still mostly talks to its old system - Ambio
  says so and offers to send an agent the work that makes the code match.
  Agents that move files are told the same.
- Review Changes shows changes to the map itself - files moved between
  systems, systems renamed, nested, merged, ungrouped or newly grouped, by
  you or by an agent - and each one can be undone. Agents can ask what
  changed, so they build on your decisions instead of reversing them.
- Review Changes keeps offering to make the code match while it still
  disagrees, and a sent order shows whether Ambio found the code now matches,
  checked against the code rather than taken from the agent's reply.

### Changed
- Smaller install: the old built-in service and the native modules only it
  used are gone, so installing Ambio from source no longer compiles native
  Node code.
- Ambio runs its agent connection on its own bundled runtime; Node.js no
  longer needs to be installed.
- Unlimited projects, with a short recent list and "Show all".
- Files over 1 MB and minified files are no longer indexed.
- Map shortcuts: Fit `⌘0`, Zoom `⌘=` / `⌘-`, Tidy Layout `⇧⌘L`,
  Infrastructure `⇧⌘E` (Ctrl on Windows and Linux). Interface zoom moved to
  `⌥⌘=` / `⌥⌘-` / `⌥⌘0`, and Agent Log to `⇧⌘A`.

### Fixed
- Investigations on Ubuntu report Python crashes again (the system's crash
  reporter used to hide them).
- Tracing Ruby counts calls in files inside subfolders, and in projects
  reached through a symlink (every project under /var on macOS).
- A file moved on disk no longer drops off the map when the move's delete
  and create are handled at the same moment.
- Tracing C++ with gdb is reliable on a busy machine: Ambio no longer races
  its own launch request, and waits longer for a debugger's first answer.
- Tracing Go code works again for projects outside Ambio's own folder, and
  a program that does not build says why.
- A damaged map is caught when the project opens: Ambio offers to restore
  the newest backup instead of opening it, and never backs up a damaged
  map over the good backups.
- Copying the connection check during agent setup could silently do
  nothing when the window was not focused.
- Connections between two live nodes on a sheet were silently dropped, and
  a drawn dependency could never be confirmed by the code; both work now.
- A file moved or renamed on disk keeps its system, its place on the map and
  its history instead of arriving as a new, unsorted file.
- Every change an agent makes to your systems is now recorded and shown in
  Review Changes; before, agents could rename, regroup or delete systems
  without a trace.
- Returning a file to the unsorted bin could fail.
- Edits made while Ambio was closed could be missed when a file's timestamp
  was too close to the last index.
- A second copy of Ambio, or another program on Ambio's ports, no longer
  breaks the connection to the map.

### Security
- The app window runs sandboxed under a strict content security policy, and
  source files are never opened with the system's default handler, which can
  run scripts.
- Fonts ship with the app; Ambio makes no network request to draw itself.
