# Changelog

All notable changes to Ambio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's section is shown
in the app as "What's New" after updating, so write it for users.

## [Unreleased]

### Fixed
- Large canvases respect the viewport buffer while the first visibility query
  loads, avoiding a burst of off-screen root cards at startup.
- Dense canvases use buffered visibility and compact cards while moving, then
  progressively reveal detail. Search and reply navigation prewarm the target;
  large symbol lists and concurrent symbol requests now have bounded work.
- Sheets retain node measurements while zooming, avoiding repeated off-screen
  card mounting. Camera and selection changes reuse layouts and unaffected
  nodes; large sheets also cull planned nodes. Search and reply file pills wait
  for a measured target and stop competing wheel zoom before flying to it.
- File cards show their functions once the file is indexed, instead of "No
  symbols" for the rest of the session when they were looked at too early.
- Systems an agent names on a sheet stay where they are on the Floor, instead
  of jumping to the middle of the map over their neighbours.
- Opening a sheet clears its "an agent proposed…" notification, however you
  open it.
- Codex can read your code in Ask and Propose on Windows; its read-only
  sandbox could not start a shell there.
- Looking up Copilot's and Antigravity's models no longer opens terminal
  windows.
- A sheet's dependencies run between the sides of the boxes that face each
  other, instead of through the boxes in between.
- The first Build in an Ambio chat conversation now creates its work order
  instead of failing with a claim-conflict error. Follow-up Builds keep their
  history and review results in the same conversation.
- ChatGPT plan conversations now accept completed responses when Electron omits
  the stream's content-type header, instead of reporting a connection failure.
- Smoother canvas zooming on the Floor and architecture proposal review: camera
  changes no longer invalidate every node's styles or rebuild the review scene.
  Idle overlays and background agent/runtime activity do less rendering work.
- Startup no longer sends an obsolete project-open command to the daemon;
  development builds no longer print daemon usage text after a successful build.
- Settings keeps the same size across sections and scrolls content inside the
  panel, with a compact layout for smaller windows.

### Changed
- While the agent panel is open, fitting the map, search and anything else
  that moves the view centres on the part of the map you can see.
- Only a Build reply waits for your review; a question or a proposal that has
  been answered is shown as Answered.
- Agent replies read as formatted text: headings, emphasis, lists, tables and
  code.
- A turn shows one status line while the agent works, and Stop takes Send's
  place in the message box.
- The agent and its model are one control in the message box, in the same
  style as Ask / Propose / Build.
- On a sheet, the stencils sit at the top, clear of the Infrastructure tab,
  and move aside when its sidebar opens. The "Sheet layer active" badge is
  gone; the PROPOSAL band already says it.
- Mapping leaves out a proposed system that ends up with no indexed files.
- Removed the redundant Architecture Workbench and view labels from title bars
  to give the app menus more space.
- Ambio has a new Open Arch logo and wordmark across the launcher, title bars,
  About dialog and desktop icons. The tray icon opens the app when clicked.
- Axiom is now Ambio. Your maps, settings and agent connections move over
  automatically the first time you open it.

### Added
- Agents can propose where things belong: a new system inside its parent,
  holding the files it takes over; an existing file or system moved to another
  boundary; a system renamed. Each waits under To review in the sheet rail with
  confirm and reject, and is marked on the map until you decide: a proposed
  move or rename is tagged, a rename shows the new name over the one it
  replaces, and a proposed dependency is drawn in amber.
- Click a file named in an agent's reply to go to it on the map. Paths in code,
  shortened names like `Chat.tsx` and names written in plain text all work when
  Ambio has indexed the file.
- Click a proposal under To review to go to it on the sheet.
- Drag the agent panel's left edge to make it wider or narrower.
- See what the agent is thinking: Claude Code, Codex, Cursor and the agents
  that run as a session (Copilot, Devin) show their reasoning in a turn's
  activity while they work, and Ambio chat shows it collapsed above the reply,
  wherever the model shares it. Antigravity's CLI does not report its
  reasoning yet.
- Connect an eligible ChatGPT plan under Ambio chat in Settings → Agents.
  Your subscription powers the built-in agent through direct API requests,
  with encrypted sign-in, account/model selection and usage controls. No
  separate CLI or API key is required. Packaged cross-platform validation remains pending.
- The agent panel is now a conversation. Ask a question, ask for a plan, then
  tell the agent to build it, and each turn stays in the same conversation; the
  agent picking up a turn is given what was said before it. Start a new
  conversation with the + button and switch between them from the title.
- Agents Ambio starts (Claude Code, Codex) continue their own session from one
  turn to the next, and the panel shows what the agent is doing while it works.
- A question or a request for a plan can no longer change your files in an
  agent Ambio starts: only a Build turn can.
- Tell a session you already have open to "watch Ambio" and your next messages
  go to that chat. For agents Ambio cannot start (Claude Desktop, Copilot in VS
  Code, Cursor, Windsurf, Antigravity, JetBrains, Zed) you paste one handoff
  and the chat stays attached for the rest of the conversation. VS Code and
  Cursor open with the handoff already in their chat.
- When an agent Ambio started wants to run something its turn did not allow,
  it asks you in the conversation and waits for your answer.
- The conversation title shows how many other conversations are waiting for
  your review, and its menu can list conversations by where they stand.
- Codex and Antigravity's CLI can be started from Ambio as well as Claude
  Code. Copilot CLI runs as a session so it keeps its place between turns.
  Experimental: Cursor's and Windsurf's (Devin) terminal agents.
- The first time you choose an agent, Ambio shows how it works from the panel
  and what it can do, and waits for you to confirm. The info button beside
  Deliver to shows the same guide any time, and choosing an agent there
  changes where your message goes.
- Installing Ambio into Antigravity also allows Ambio's tools in Antigravity's
  CLI, which otherwise refuses them when started from Ambio.
- Agents Ambio runs now have full access, so a turn no longer stops on a step
  nobody was there to approve: Build runs unrestricted, and Ask and Propose can
  run commands but not edit files where the agent allows that. Each agent's
  guide says what it may do. Choosing permission levels yourself is planned.
- Choose the model an agent runs with, beside Ask / Propose / Build and next
  to setup's Map button. Claude Code, Codex, Copilot CLI and Antigravity CLI
  offer the models they publish; Ambio chat offers every model its service
  lists, and can switch between them within a conversation.
- Setup can map your project for you: choose Ambio chat or an agent on this
  computer, press Map, and watch it work. Nothing to install or restart. Adding
  Ambio to your own sessions of that agent is on by default and can be turned
  off. Agents in other apps are set up as before.
- The agent panel says whether the chosen agent is ready in that agent's own
  terms, and Settings → Agents lists Ambio chat, the agents Ambio runs and the
  agents in other apps separately.
- Ambio chat: Ambio's own agent, picked like any other in the agent panel.
  Set up a model service with your API key, then ask, propose or build in the
  same conversation; replies stream in, and builds come back for review. Includes streamed
  responses, questions, Stop, restart recovery and secure local key storage.
  Set each service's context window to match your model.
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
- Deleting a project right after an agent opened it no longer fails with
  "workspace data still exists".
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
