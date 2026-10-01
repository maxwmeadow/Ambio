# Changelog

All notable changes to Axiom are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's section is shown
in the app as "What's New" after updating, so write it for users.

## [Unreleased]

### Added
- Command palette, keyboard shortcuts and a shortcut reference; full menus
  (File, Edit, View, Go, Map, Agent, Help) and right-click menus on the map.
- Settings: reopen last project, update checks, interface zoom, reduce
  motion, the editor used by Open in Editor, and more.
- Project Settings: rename a project, change which folders Axiom reads, and
  re-index in place. Changing folders never shows up as code changes in your
  review.
- Open projects with `axiom .` from a terminal, by dropping a folder on the
  window or dock, from the dock menu or Windows jump list, and from
  `axiom://` links.
- Agents keep working while Axiom is closed: Axiom's background service
  starts on demand and stops when idle, and keeps the map current with what
  the agent changes.
- Remove Axiom from any agent, or from all of them, in one step.
- C projects (`.c`, `.h`) are read, with `#include` relationships.
- Rust, Java, Ruby and C++ projects get import relationships, so their
  systems group by what the code uses, not just by names.
- Moved or renamed project folders are detected; point Axiom at the new
  location and the map comes with it.
- Report a bug, Copy diagnostics and local log files; automatic updates.
- A warning before indexing a very large folder, and a Stop button while
  indexing.
- Clear all Axiom data from Settings.
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
- When an agent draws a sheet or proposes something on one, Axiom tells you
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
  another system's folder, or still mostly talks to its old system - Axiom
  says so and offers to send an agent the work that makes the code match.
  Agents that move files are told the same.
- Review Changes shows changes to the map itself - files moved between
  systems, systems renamed, nested, merged, ungrouped or newly grouped, by
  you or by an agent - and each one can be undone. Agents can ask what
  changed, so they build on your decisions instead of reversing them.
- Review Changes keeps offering to make the code match while it still
  disagrees, and a sent order shows whether Axiom found the code now matches,
  checked against the code rather than taken from the agent's reply.

### Changed
- Smaller install: the old built-in service and the native modules only it
  used are gone, so installing Axiom from source no longer compiles native
  Node code.
- Axiom runs its agent connection on its own bundled runtime; Node.js no
  longer needs to be installed.
- Unlimited projects, with a short recent list and "Show all".
- Files over 1 MB and minified files are no longer indexed.
- Map shortcuts: Fit `⌘0`, Zoom `⌘=` / `⌘-`, Tidy Layout `⇧⌘L`,
  Infrastructure `⇧⌘E` (Ctrl on Windows and Linux). Interface zoom moved to
  `⌥⌘=` / `⌥⌘-` / `⌥⌘0`, and Agent Log to `⇧⌘A`.

### Fixed
- A damaged map is caught when the project opens: Axiom offers to restore
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
- Edits made while Axiom was closed could be missed when a file's timestamp
  was too close to the last index.
- A second copy of Axiom, or another program on Axiom's ports, no longer
  breaks the connection to the map.

### Security
- The app window runs sandboxed under a strict content security policy, and
  source files are never opened with the system's default handler, which can
  run scripts.
- Fonts ship with the app; Axiom makes no network request to draw itself.
