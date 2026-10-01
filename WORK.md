# WORK

The single list of everything still to do on Axiom: features, bugs, ideas,
decisions, launch tasks. Every person and every agent session works from this
file and adds to it. If it is not here, it is not planned.

- What the product is: [docs/PRODUCT.md](docs/PRODUCT.md)
- Why things are the way they are: [docs/DECISIONS.md](docs/DECISIONS.md)
- How the code works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- What shipped for users: [CHANGELOG.md](CHANGELOG.md)

---

## How to use this file

**Status marks:** ⬜ open · 🚧 in progress · ❓ needs Max's decision (don't
build until decided) · 👤 needs Max personally (accounts, money, people) ·
⏸ parked · ✅ done (move it to the Done log).

**Item format:** one bullet, starting with a status mark and a short
`slug` in backticks. Slugs are the IDs: they never change, and nobody has to
coordinate numbers across sessions. Then a bold title, the context an agent
needs to start cold, **Done when** (how to know it is finished) and **Start**
(where in the code to look), when known.

**Agents - picking up work:**
1. Pull the latest `main` and read *Now* first, then the section your task
   belongs to.
2. Take the highest ⬜ item in *Now* that is not ❓ or 👤 and that no other
   session holds (🚧). If Max assigned you an item, take that.
3. Claim it: change ⬜ to 🚧 and append `(🚧 <agent>, <branch>, <date>)`.
   Make that your first commit, so the claim travels with your branch.
4. Read the linked docs, and read [docs/CANVAS_BEHAVIOR_CONTRACT.md](docs/CANVAS_BEHAVIOR_CONTRACT.md)
   before touching the canvas.
5. When done, delete the item here and add one line to the *Done log*
   (date, slug, what changed, branch). Add a CHANGELOG line if users would
   notice. Update `docs/ARCHITECTURE.md` if you changed how something works.

**Everyone - adding work:** anything you notice that you are not doing right
now - a bug, an idea, a missing test, a doc that lies - goes at the bottom of
the *Inbox* section, with the date and where it came from. Don't stop to
research it; one or two lines is enough. Max (or an agent asked to triage)
sorts the Inbox into sections. Never delete someone else's item without doing
it or saying why in the Done log.

**Merge conflicts in this file:** keep both sides. It is a list.

---

## Now

The next things to do, in order. Max reorders this; agents pick from the top.
The area tag says which part of the code an item touches: when several
sessions run at once, pick items in **different areas** so branches don't
collide. Full context for each item is in its section below.

1. ⬜ `work-order-delivery` - investigate and fix how a work order reaches an agent. [mcp, electron, docs]
2. ⬜ `agents-draw-first` - agents draw on a sheet before structural changes. [installers, mcp descriptions]
3. ⬜ `canvas-undo-redo` - undo and redo on the canvas. [canvas]
4. ⬜ `rules-and-drift` - standing architecture rules and drift checks (design first; large). [archd, mcp, canvas]
5. ⬜ `model-explorer` - outline panel for large maps. [renderer]

---

## Decisions needed (❓ Max)

Each has a recommendation. Once decided, record it in `docs/DECISIONS.md` §1,
turn the item into build work, and remove the ❓.

- ❓ `committed-maps` **Should maps (or their human-authored parts) live in the repo as `.axiom/`?** Pros: teams and open-source projects share one map, versioned with the code, readable by agents in CI. Cons: SQLite does not merge (needs a text format for intent only), and it gives away the core of a paid shared-map tier. Notes: DECISIONS §7. Recommendation: yes eventually, intent-only text, opt-in, read-only import first; monetise review/governance rather than sharing.
- ❓ `worktrees-one-or-two` **Are worktrees of one repo one project or several?** Today they are roots of one project with branch-stamped history and collisions. Recommendation: one project, made explicit in the UI (a branch switcher), since collisions across branches are a differentiator.
- ❓ `multi-root-projects` **Unrelated folders in one project.** Held: needs root sync that adds roots, per-root clustering, cross-root delta/history/sessions, a cross-root edge policy, and MCP connections that know about several roots. Recommendation: after launch; opening a parent folder covers most cases.
- ❓ `multi-window` **More than one window.** First decide which project agents act on when two are open (today `active_project.json` names one). Recommendation: agents name the project explicitly (also needed for multi-root), then per-window state, then File → New Window. Notes: DECISIONS §7.
- ❓ `cla-or-dco` **Keep the CLA, switch to DCO, or add a public commitment.** Research (Sept 2026): contributors read a CLA as a relicensing warning after Cal.com closed its AGPL code (Apr 2026); HashiCorp and Redis relicensing caused forks. Options: keep CLA + publish a pledge that the local app stays AGPL; or DCO and give up relicensing. Recommendation: keep CLA, add the pledge to README and CONTRIBUTING.
- ❓ `demo-project` **Ship a demo project after all?** Decided "not now" (DECISIONS). The research suggests the first ten minutes decide adoption, and the bidirectional loop needs a codebase and an agent to show. Recommendation: a guided first run on the user's own project instead of a bundled demo, plus the README video.
- ❓ `name` **The rename.** On hold. Candidates and checks: DECISIONS §3.

---

## Needs Max (👤)

- 👤 `rename` Pick the name (candidates in DECISIONS §3), then an agent does the mechanical rename (`~/.axiom`, `com.axiom.app`, MCP server entry, `/axiom-map`, docs).
- 👤 `apple-developer` Buy the Apple Developer Program ($99/yr) → then `mac-signing`.
- 👤 `signpath` Apply to SignPath Foundation for free Windows signing → then `windows-signing`.
- 👤 `code-of-conduct` Choose a contact address for conduct reports → then an agent adds `CODE_OF_CONDUCT.md` (Contributor Covenant).
- 👤 `cla-legal-review` Have a lawyer look at `CLA.md` before charging money.
- 👤 `private-vuln-reporting` Turn on GitHub private vulnerability reporting when the repo goes public.
- 👤 `hero-video` Record the README hero: a short video of the bidirectional loop (you draw → agent builds → review; agent draws → you confirm). Needs the real app.
- 👤 `real-app-test-pass` Test the recent work in the real app: map safety (Recently Deleted, backups, export/import), the new shortcuts, Map → Add Infrastructure, `axiom .`, drag-drop, `axiom://` links, What's New. Put bugs in the Inbox.
- 👤 `canvas-qa-pass` Run [docs/testing/CANVAS_QA_CHECKLIST.md](docs/testing/CANVAS_QA_CHECKLIST.md) sections D onward (86 items untested). Report by ID.
- 👤 `secret-scan-before-public` Re-run the history secret scan right before the repo goes public (last run covered 124 of 165+ commits).

---

## Bidirectional core

The product's first rule: every artifact can be written by both you and your
agent, and each sees the other's changes ([docs/PRODUCT.md §1](docs/PRODUCT.md)).

- ⬜ `bidirectional-audit` **Prove each direction for each artifact.** For systems, sheets, infrastructure, changes and (later) rules, write down and test: can the human create/edit it, can the agent, does each see the other's change, is it journaled and attributed. **Done when:** a table in docs/PRODUCT.md §1 is backed by one test per cell (MCP e2e or Playwright), and every ❌ has a WORK item.
- ⬜ `agents-draw-first` **Agents draw before they build.** The tools exist (`edit_sheet` create/add, `plan_element`) but nothing asks agents to use them. The workflow files Axiom installs per agent (instructions, skills, and hooks where the host supports them) should say: for any structural change - new system, new dependency between systems, moving responsibility - draw it on a sheet first, tell the human, then build; after building, `edit_sheet compare`. Research: MCP tools are rarely chosen spontaneously; the popular code-graph tools install hooks to force use. **Done when:** a fresh Claude Code and Codex session, asked to add a feature that crosses systems, draws a sheet before editing code, in a recorded run. **Start:** `electron/agentInstallers.ts`, the installed workflow/skill files, `mcp/axiom-mcp.ts` tool descriptions.
- ⬜ `agents-see-human-changes` **(Partly done: `get_architecture` scope `changes` lists recent meaning edits.) Agents learn what the human changed.** When you rename, regroup or reject something, the next agent session should know without re-reading the whole map: e.g. `get_architecture` scope `changes_since` (or a section in `start_work`'s response) listing human meaning edits and decisions since that agent's last session. **Done when:** an agent starting work is told "Max moved `billing.ts` from Orders to Payments yesterday".
- ⬜ `floor-more-reality-gestures` **The rest of slice 4.** "Remove dependency on X" and "Split system…" should each open a pre-drawn sheet and the send dialog, like New System Here does. (Dragging a connection between two live nodes is done.) Removing a dependency needs a way to draw one on a sheet first: planned edges are additions only.
- ⬜ `rules-and-drift` **Standing architecture rules.** Sheets cover one piece of work; staying aligned over time needs lasting agreements: "Payments never calls Email directly", "UI never imports the database", layer order. Humans and agents can both write rules; agents check them before and after work (`check_architecture` or a `get_architecture` scope); violations appear as claims in Review Changes. The historical design is "Intent sheets" in [docs/history/UML_UX_PLAN.md](docs/history/UML_UX_PLAN.md) (`ALLOWED`, `NO_DEPENDENCY`, `TRANSIT_INTERCEPT`, `LAYER_ORDER`). Research: drift detection is the one architecture feature teams consistently pay for (vFunction, Structurizr, Archyl). **Done when:** a rule drawn on the canvas blocks nothing but is reported the moment code breaks it, to both the human and the agent.
- ⬜ `rules-in-ci` (after `rules-and-drift`) **A PR/CI check.** A headless `archd check` that runs the rules and reports new architectural claims on a pull request, so a team sees drift without everyone running Axiom. This is also the most likely paid-team entry point.
- ⬜ `infra-both-ways` **Human infra edits become work.** Adding "Redis cache for sessions" on the canvas should be sendable as a work order, and the agent's infra edits already show up; make both directions visible in Review Changes (`infra-claims`).
- ⬜ `verify-beyond-structure` **Raise the trust ceiling on work orders.** Today a work order passes if its structure matches; agent-reported results (commit, checks) are labelled unverified. Options: let the human attach checks (a test command) to a sheet that Axiom runs on reply; record the commit and diff; show which planned members exist as symbols. **Done when:** at least "the tests named on the sheet ran and passed" is verified by Axiom, not reported by the agent.
- ⬜ `human-decisions-to-agents` **Rejections teach agents.** When you reject an agent's proposed system, planned element or infra node, record why (optional one-line reason) and return it to agents in later sessions, so the same proposal is not made again. **Start:** proposal review (`ArchitectureProposalPanel.tsx`), sheet confirm/reject, `edit_infra decide`.
- ⬜ `agent-explains-change` **Agents annotate their own changes.** When an agent's work creates a claim in Review Changes ("Api now depends on Storage"), show the agent's stated reason from its work session next to it; flag claims no session explains (UNEXPLAINED exists - make it prominent and filterable).
- ⬜ `sheet-from-selection` **Start a sheet from what you are looking at.** Select systems/files on the Floor → "New sheet from selection" pre-populates the sheet with that context, for both humans and agents (`edit_sheet create` with node IDs).

## Sheets and work orders

- ⬜ `work-order-delivery` **Investigate and fix how a work order reaches an agent.** Today the human copies a work-order ID into the agent's chat (see [docs/INBOX_PROTOCOL.md](docs/INBOX_PROTOCOL.md): "There is no automatic delivery or reliable cross-harness hook"). This is the weakest link in "you draw, agent builds". Investigate per host, and write the findings into INBOX_PROTOCOL.md: Claude Code hooks (`SessionStart`, `UserPromptSubmit` injecting pending work orders), MCP resource/list-changed notifications and elicitation support per host, launching the host CLI headless with the work order (`claude -p`, `codex exec`, Gemini/Antigravity CLI, Copilot CLI) into a worktree, IDE deep links that open a chat with a prompt (VS Code, Cursor, Windsurf, JetBrains), and one-click "copy + focus the agent window". **Done when:** a capability table per host exists, and the best option is built for at least Claude Code and Codex so that "Send" starts the work without copy-paste.
- ⬜ `work-order-recovery` **Recovery across hosts and interruptions.** A real Sheet request, an interrupted agent, an expired claim, a retry and a requested revision all return to review without duplicate execution or lost context. **Start:** `archd-go/internal/api/inbox.go`, `internal/db/work_order_snapshot.go`, `src/renderer/components/WorkOrderReview.tsx`.
- ⬜ `send-dialog-modes` **Split Ask / Propose / Start build in the send dialog.** Asking a question, asking for a plan (agent draws, human confirms) and ordering a build are different contracts. **Start:** `SendToAgentDialog.tsx`.
- ⬜ `build-plan-panel` **A persistent Build Plan panel** replacing the modal, showing what was sent, who holds it, and realisation live.
- ⬜ `mcp-prompts-implement` **MCP prompts `/axiom:implement`, `/axiom:propose`, `/axiom:review`** so each host has a one-word way into the loop.
- ⬜ `midflight-approval` **What happens when you approve, reject or change a plan while the agent is already building.** Define and implement (e.g. the agent is told on its next `update_work`).
- ⬜ `sheet-markdown` **Sheets ⇄ Markdown specs.** Export a sheet as a Markdown spec (for PRs, AGENTS.md, Spec Kit/Kiro users) and import a Markdown spec as a draft sheet. Research: planning today is text; meeting people there lowers the switching cost.
- ⬜ `work-order-live-validation` **Validate the loop with real hosts beyond Codex:** Claude Code, Antigravity, Cursor. Record runs; file bugs in the Inbox.
- ⬜ `work-order-notifications` **OS notifications** when an agent claims, replies to or finishes a work order while Axiom is in the background or minimized (Electron `Notification`; respect a setting).
- ⬜ `work-order-queue-view` **One place for all work orders:** waiting, claimed (by which agent), in review, accepted - across sheets, with filters. Today review is per sheet/inbox.
- ⬜ `sheet-templates` **Starter sheets:** "Add an endpoint", "Extract a service", "Add a queue consumer", "Split a system" - drawn skeletons that make the first work order fast.
- ⬜ `sheet-history` **Sheet revision history** you can browse and restore (sheets are revisioned; there is no UI for past revisions).

## Review Changes and history

- ⬜ `infra-claims` **Infrastructure changes as claims** ("Orders now writes to Redis") in Review Changes. (Infra plan L7.)
- ⬜ `delta-live-validation` **Validate Review Changes with a real Antigravity (and Claude Code) session** end to end; the product plan marked it "needs live validation".
- ⬜ `hub-orphan-claims-check` **Confirm hub/orphan claims work** (listed open in the old plan, described as built elsewhere); close or fix.
- ⬜ `review-shareable` **Share a review.** Export a Review Changes summary as Markdown for a PR description or a standup.
- ⬜ `timeline` **Architecture timeline:** scrub back through the journal to see the map as it was on a day or at a commit, and compare two points. The journal already has the data.
- ⬜ `review-filters` **Filter Review Changes** by agent, work order, system and claim kind; mark claims as seen individually.

## Canvas and the Floor

- ⬜ `canvas-undo-redo` **Undo and redo on the canvas** for presentation edits (move, resize) and, via the journal, meaning edits. The contract says sheet removals are recoverable "not through undo" - keep that; undo is additional. **Start:** read the contract first.
- ⬜ `large-map-readability` **Large projects stay readable.** A realistic large map stays navigable, activity stays legible, and manual layout survives indexing, resize and reopening.
- ⬜ `split-axiom-canvas` **Split `AxiomCanvas.tsx` (~5,000 lines).** Extract gesture, projection and overlay logic into tested modules without behaviour change (the contract's refactor rule applies).
- ⬜ `zoom-glitch` **The "zoom spaz" is masked, not fixed** (old bug hunt). Find the root cause.
- ⬜ `uml-class-sheets` **Class view, generated.** Select systems or files → a class diagram generated algorithmically from symbols and relationships, scoped to the selection, live. Secondary to semantic architecture ([docs/PRODUCT.md §5](docs/PRODUCT.md)).
- ⬜ `uml-sequence-sheets` **Sequence view, generated** from the call graph (static) or an investigation run (observed), scoped to one flow.
- ⬜ `export-diagrams` **Export** the map or a sheet as PNG/SVG, Mermaid, C4 (Structurizr DSL) and Markdown. Lets the map live in READMEs and PRs.
- ⬜ `infra-local-production` **Local / Production switch for hosting frames** (infra plan "still to do").
- ⬜ `system-kinds` **Colour systems by kind** (backend, frontend, service), assigned by agents.
- ⬜ `canvas-context-empty` **Right-click on empty canvas:** New System Here, Paste, Tidy Layout, Fit (from the menu design notes).
- ⬜ `light-theme` **Light theme** (end of the list by decision).
- ⬜ `accessibility` **Accessibility pass:** keyboard navigation of the map, screen reader labels, contrast, reduced motion everywhere (end of the list by decision).
- ⬜ `model-explorer` **Outline panel:** a searchable tree of systems → files → symbols beside the canvas, synced with selection. Needed for large maps and for keyboard/screen-reader users (from the UML plan's Model Explorer).
- ⬜ `search-everything` **Search systems, symbols and infra** from `⌘K`, not only files; jump to and highlight the result.
- ⬜ `zoom-to-selection` **Zoom to Selection** (View menu, from the menu design notes).
- ⬜ `panels-menu` **View → Panels ▸** (sheet rail, detail panel, documents, agent log, status bar) with remembered visibility.
- ⬜ `html-export` **Share a read-only map:** export a self-contained HTML file of the map (pan, zoom, click through) that anyone can open without Axiom. Research: the popular code-graph tools grow through exactly this.
- ⬜ `stable-layout-tests` **Layout stability tests:** re-indexing, adding files and renaming systems never move human-placed nodes (design law). Pin it with tests on the frame packing.

## Agents and MCP

- ⬜ `mcp-tool-steering` **Make agents actually use the tools.** Measure how often each host calls Axiom tools unprompted; tune descriptions, prompts and installed instructions/hooks. Pairs with `agents-draw-first`.
- ⬜ `mcp-eval-harness` **An evaluation harness:** the same tasks with and without Axiom on a lab project (like the infra L4 eval: time, cost, reads, correctness). Needed to prove value and to publish `benchmark-public`.
- ⬜ `more-hosts` **Installers for more agent hosts:** Gemini CLI, Kiro, Cline, Roo Code, Amp, OpenCode, Continue. Check which support MCP config files and hooks.
- ⬜ `legacy-tool-names` **Remove the ~80 legacy MCP tool names** after checking `agent_actions` that nothing still calls them.
- ⬜ `mcp-op-schemas` **Per-op validation.** Consolidated tools take `op: string` with loosely typed params; validate per op and return precise errors.
- ⬜ `mcp-multi-root` **MCP connections that span roots** (single `rootPath` today; `branch_scope` falls back to `roots[0]`). Needed for `multi-root-projects` and `multi-window`.
- ⬜ `agent-onboarding-check` **Verify the agent connection end to end during setup:** after installing into a host, confirm a real tool call arrived (`get_inbox verifyOnly`) and show which hosts are connected and working in Settings → Agents.
- ⬜ `agents-md-generation` **Offer to write the project's architecture into `AGENTS.md`/`CLAUDE.md`** (systems, rules, where things live) so agents without MCP still get the map. Keep it updated from the map.
- ⬜ `mcp-resources` **Expose the map as MCP resources** (architecture overview, current rules, open work orders) for hosts that read resources into context.
- ⬜ `agent-cost-tracking` **Show what an agent's session cost in Axiom reads** (tool calls, tokens returned) in the agent log, to keep the MCP surface honest.

## Indexing and languages

- ⬜ `lang-c` **Parse C** (`.c`, `.h`); `.h` headers are not parsed today.
- ⬜ `lang-kotlin-swift-php` **Kotlin, Swift, PHP.** Not parsed at all.
- ⬜ `call-resolution` **Fewer false call edges.** Calls are matched by name across the project (`buildCallGraph`), so common names (`get`, `run`) create false edges. Options: import-scoped resolution first, stack-graphs, or LSP where available.
- ⬜ `index-benchmark` **Benchmark indexing and re-clustering on large repos** (10k, 50k files): time, memory, re-cluster cost (full `git log` read, TF-IDF pairs). Make re-clustering incremental if needed.
- ⬜ `cluster-quality-tests` **Clustering quality tests.** Only path-invariance is tested; add fixtures with known good groupings.
- ⬜ `cross-repo-links` **Services in separate repos.** Real systems span repos (frontend, backend, workers). Let a project reference another project's systems/APIs as external nodes, with HTTP/queue contracts linking them (infra plan: team-run services as `api` nodes backed by another workspace).
- ⬜ `generated-code-detection` **Detect generated code** (protobuf, OpenAPI clients, ORM output) beyond `*.min.*` and exclude or mark it, so it does not distort clustering.
- ⬜ `monorepo-workspaces` **Understand monorepo package boundaries** (npm/pnpm workspaces, Go workspaces, Cargo workspaces, Nx/Turborepo) as strong hints for systems, without letting folders define systems.

## Infrastructure

Plan and phases: [docs/INFRA.md](docs/INFRA.md).

- ⬜ `infra-contracts-demo` **A local demo that checks contracts:** a small app with a database and a queue shows roles, contracts, implementations and evidence; changing the schema or a producer exposes the gap.
- ⬜ `infra-l4-rest` **Remaining contracts:** SDK methods, webhooks, and the rest of L4.
- ⬜ `infra-l5-runnability` **L5 runnability pre-flight** (can this project run locally; what is missing).
- ⬜ `infra-l6-runtime` **L6 observe infrastructure at runtime.**
- ⬜ `infra-iac` **Detect from infrastructure-as-code:** Kubernetes, Helm, Terraform, serverless.yml, wrangler, SAM/CloudFormation.
- ⬜ `compose-yaml` **Parse compose files as YAML** (today a line scanner).

## Investigations and runtime

Current state: [docs/INVESTIGATIONS.md](docs/INVESTIGATIONS.md). Old plan: [docs/history/RUNTIME_LAYER_PLAN.md](docs/history/RUNTIME_LAYER_PLAN.md).

- ⬜ `runtime-java-ruby` **Verify Java tracing; add Ruby argument values.**
- ⬜ `investigations-at-scale` **Evaluate investigations on several-hundred-file codebases** and production-like data (the investigations doc's stated next step).
- ⬜ `runtime-toolchains` **The toolchain track:** make DAP adapters and compilers (MSYS2 etc.) installable or clearly optional, per the one-install decision.

## App, launcher and settings

- ⬜ `crash-opt-in` **First-run crash-report choice** (nothing pre-selected), and upload once there is a destination (Sentry/GlitchTip). PRIVACY.md updated first.
- ⬜ `settings-specifics` **Settings from the design notes:** global exclude patterns, max file size, languages, docs indexing; canvas edge style, snap to grid; beta update channel; keep running in background.
- ⬜ `rebind-shortcuts` **Rebindable shortcuts** (the command model already centralises them).
- ⬜ `first-run-guide` **A guided first run** on the user's own project that shows both directions of the loop (see `demo-project`).
- ⬜ `trash-orphans` **List unlabeled trash entries.** A map moved to `.trash` whose `trash.json` was never written (app quit mid-delete) is purged after 30 days but never shown in Recently Deleted. Show it by project ID. **Start:** `electron/projectRegistry.ts` `listTrash`.
- ⬜ `windows-cli-path` **`axiom` command on Windows:** add `%USERPROFILE%\.axiom\bin` to the user PATH automatically (today the user is told to do it). **Start:** `electron/cliLauncher.ts`.
- ⬜ `linux-desktop-integration` **Linux AppImage integration:** register a `.desktop` entry and the `axiom://` handler on first run (AppImages do not install one), so links and the app menu work.
- ⬜ `tray-presence` **Menu-bar/tray presence** while agents work with the window closed: which agents are active, open work orders, open Axiom.
- ⬜ `feedback-link` **Send feedback** in Help and on the launcher (a prefilled GitHub discussion or issue), distinct from Report a Bug.
- ⬜ `startup-performance` **Measure and trim launch time** (window shown, launcher interactive, project open) and memory with many projects; add a budget to CI.

## Launch, distribution and repo

- ⬜ `mac-signing` (after `apple-developer`) Sign and notarize macOS builds; then `mac-auto-install`: turn on macOS auto-install in `electron/updates.ts`.
- ⬜ `windows-signing` (after `signpath`) Sign Windows builds via SignPath.
- ⬜ `linux-packages` **deb/rpm** alongside the AppImage.
- ⬜ `rename-mechanics` (after `rename`) The mechanical rename across paths, IDs and docs.
- ⬜ `launch-plan` **A launch plan:** Show HN, r/programming and agent-tool communities, the README video, a comparison page, a short docs site. Lead with the bidirectional loop, not "see your codebase".
- ⬜ `commercial-license-page` **Explain commercial licensing** for companies that cannot use AGPL (the CLA allows it): a short section in README or a LICENSING.md, with a contact.
- ⬜ `community-space` **A place to talk:** GitHub Discussions (on) with categories for ideas, help and show-and-tell; link it from Help and the README.
- ⬜ `docs-site` **A small docs site** (GitHub Pages) generated from `docs/` user pages, once `user-docs` exists.
- ⬜ `release-checklist` **A written release checklist** (`docs/RELEASING.md`): version bump, CHANGELOG section, tag, draft release review, notices, smoke test per OS.

## Quality, tests and CI

- ⬜ `coverage-report` **Coverage numbers** for Go and the node suite, to find the untested areas beyond runtime.
- ⬜ `ci-windows-mac-go-race` **Run the Go tests with `-race`** in CI on at least Linux; this session found a real ordering bug (open-time backup) that only showed up as a flaky cleanup on macOS.
- ⬜ `flaky-test-watch` **Track flaky tests:** a note in this file (or a label) for any test that fails once and passes on retry, with the run link, so flakes get root-caused instead of re-run.
- ⬜ `e2e-real-agent-smoke` **A scheduled smoke test with a real agent** (the opt-in live Codex smoke test exists; run it weekly with a secret, and add Claude Code).

## Docs

- ⬜ `user-docs` **User documentation** for Help → Documentation: getting started, the loop, sheets, work orders, rules, troubleshooting. Short, task-based.
- ⬜ `research-archive` **Keep the competitive research somewhere durable.** The September 2026 report and notes live only in the maintainer's local `reports/` and `research_notes/` (git-ignored). Decide whether to commit a trimmed version under `docs/research/`, and refresh it quarterly.
- ⬜ `mcp-surface-sync` **Keep docs/MCP_SURFACE.md generated or tested against the real tool list** so it cannot drift (a test that compares the doc's tool table with `CORE_TOOLS`).

## Growth and positioning

- ⬜ `benchmark-public` (after `mcp-eval-harness`) **Publish a head-to-head** against codebase-memory-mcp, Graphify and GitNexus on the same repos: what each tells an agent, and what only Axiom does (the two-way loop). Research: the code-graph layer is commoditised; prove the loop instead.
- ⬜ `comparison-page` **"How Axiom compares"** page: Kiro/Spec Kit (text specs), Windsurf Codemaps (read-only, per task), code-graph MCPs (one-way), diagram tools (stale).
- ⬜ `competitor-watch` **Quarterly competitor check:** Windsurf Codemaps, Archyl, Kiro, Spec Kit, Traycer, codebase-memory-mcp, Graphify, GitNexus, Claude Code/Codex/Cursor agent views. Record what changed in `docs/research/` (see `research-archive`).
- ⬜ `positioning-copy` **One sentence and one image** that say "bidirectional architecture between you and your agents" - for the README, the app's About box, the release notes and the launch post. Test it on developers who have not seen Axiom.

## Business and collaboration (later)

- ⬜ `paid-tier-definition` **Define the paid tier.** Research: teams pay for governance and review (drift checks, PR checks, audit, SSO), shared workspaces and comments; seat norms $6-15 team, $25-45 business. Recommendation: sell reviewing and governing agent output across a team, not viewing a map.
- ⏸ `collab-service` The separate private collaboration service (presence, comments, review workflows, cross-repo maps, hosted agents, org history). Not before launch.

## Later / maybe

- ⏸ `agent-edit-approval-mode` **Approve-only mode for agent meaning edits.** Today (decided 2026-10-01) agent edits apply immediately with history and undo. Someday: a per-project setting for automatic vs approve-only, where agent meaning edits wait as proposals. Very low priority.
- ⏸ `pdf-docs` PDF text extraction for the documents panel.
- ⏸ `local-model-feedback` Learn from human corrections to clustering with a small local model.
- ⏸ `replay-links` Shareable investigation captures (a link instead of a pasted stack trace) - a collaboration feature.

---

## Inbox

- ⬜ `sheet-authoring-timing` "sheet authoring (click)" failed once in a full local Playwright run (waiting 8 s for the new planned node to become the selected parent) and passed on rerun; find what it waits on. (2026-10-01)
- ⬜ `commit-linux-baseline` After the first CI run of the `e2e` job, download `playwright-results` and commit `tests/e2e/__screenshots__/canvas.spec.ts/linux/` so the Floor baseline is compared on Linux too. (2026-10-01, ci-e2e)

New items go at the bottom: `- ⬜ \`slug\` **Title** - context. (date, source)`

- ⬜ `unassigned-regrouped` **Files taken out of every system can be regrouped by the clusterer.** Unassigned files are classifier-managed, so ungrouping a top-level system or dragging a file to empty canvas may be undone by the next cluster pass. Decide whether a human "unassign" should pin the file as deliberately unsorted. (2026-10-01, meaning-edits-recorded)
- ⬜ `seed-script-stale` **`scripts/seed-architecture.ts` (`npm run seed-arch`) calls routes that no longer exist** (`/systems/:id/assign` on the old TS daemon). Fix it against `/api/architecture/edits` or delete it. (2026-10-01, meaning-edits-recorded)
- ⬜ `readme-screenshots` **README screenshots** of the Floor, a sheet and Review Changes, once the rename and theme settle. (2026-09-30, docs cleanup)

---

## Done log

Newest first. One line each: date, slug, what changed, branch/commit.

- 2026-10-01 `runtime-tests` Runtime layer tests: the investigation case file (hypotheses, verdict words, runs linked by any name, conclusions verified by run number, human messages delivered exactly once, copies not aliases), recording start/notes/stop, the DAP client over in-memory pipes (responses matched by seq, events, failures, a hostile frame size closing the connection, headers), and frame/source matching and editor PATH stripping. Launching real debuggers stays covered by the opt-in suites. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `agent-sheet-arrival` An agent's new sheet or new pending proposal raises an invitation with Open Sheet (one per sheet, replaced while the agent works); agent sheets not yet opened are marked NEW in the rail; pending proposals are outlined PROPOSED on the canvas (rejected ones fade) and listed under "To review" in the rail with one-click Confirm / Reject and Confirm All. Playwright covers arrival → open → confirm. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `mac-update-manifest` + `actions-node24` A tagged release now ends with a job that merges the arm64 and x64 `latest-mac.yml` (`scripts/merge-mac-manifest.mjs`, tested) and replaces the uploaded one on the draft release; actions moved to their Node 24 majors (checkout v5, setup-node v5, setup-go v6, upload-artifact v5, download-artifact v6). Not yet exercised: runs on the next `v*` tag. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `log-noise` + `gofmt-dbquery` + `remove-legacy-archd` Removed the C# node-type dump and the call-graph symbol samples; gofmt'd `cmd/dbquery`; deleted the legacy TypeScript daemon (`archd/`, its electron-vite entry, `npm run archd`, the `@archd` path) and the dependencies only it used (hono, @hono/node-server, web-tree-sitter, better-sqlite3, chokidar, ws, @types/better-sqlite3), plus `postinstall: electron-rebuild` and @electron/rebuild, which existed for better-sqlite3. CI now fails on unformatted Go (Linux). (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `db-corruption-recovery` Opening a project runs `PRAGMA quick_check`; a damaged map (or one SQLite refuses as malformed / not a database) is not used or backed up, and the open answers 409 with the backups; the app raises a decision offering the newest backup. Restore keeps an unsnapshottable damaged map aside as `damaged-<time>.db.bak`. Test covers a damaged header and damaged pages. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `schema-upgrade-tests` Maps written by schema v0, v1 and v2 (fixtures generated by those versions' own code: `internal/db/testdata/schemagen`, replayed from `testdata/schema-v*.sql`) open with the current build, keep their data, and take meaning edits, code fit, removals and code checks; newer maps are refused (`schema_version_test.go`). When bumping `SchemaVersion`, add a fixture for the version being left behind. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `imports-rust-java-ruby-cpp` Import edges for Java (`import`, packages via `.*`, static), Rust (`mod x;`, `use crate::/self::/super::` incl. brace groups), Ruby (`require_relative`, `require`) and C++ (quoted `#include`, resolved to the implementing file since headers are not indexed); text-based specs in `parser/imports_more.go`, resolved with path-tail and folder-tail keys (`indexer.resolveTextImport`). (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `headless-watch` A project opened by a request instead of the app (an agent's headless daemon) reconciles and watches the root that holds its indexed map (`Server.keepWorkspaceLive`, from `dbFor`'s lazy open); test covers a change made while closed and a save afterwards. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `ci-e2e` CI gains an `e2e` job on Linux: `npm run test:mcp`, then the whole Playwright suite under xvfb; while no Linux screenshot baseline is committed, a step writes it on the runner first (Playwright fails a test whose baseline it writes); results and that baseline are uploaded as an artifact. Locally the full suite is green (38 passed, 2 opt-in skipped). Not yet run on GitHub: CI only runs on main and pull requests. After its first run, commit the uploaded Linux baseline. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `playwright-launcher-failures` The three failing canvas tests pass: each run now gets an isolated home (`HOME`/`USERPROFILE`) with a registered fixture project and a real fixture folder (`AXIOM_E2E_ROOT` → renderer `root` param), so the suite no longer reads or writes the developer's real `~/.axiom`; the setup screen browses that folder instead of `.` (refused since file access was limited to project roots); Copy check in agent setup writes through the main process, since the web clipboard refuses an unfocused window. Only the missing Linux screenshot baseline remains (see `ci-e2e`). (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `floor-connection-gesture` Drawing a connection between two live nodes on the Floor draws "A uses B" on a new sheet and opens the send dialog; on a sheet, live-to-live connections are now kept as proposals (they were silently dropped). Loose connection mode with the drawn-from node as source (overlapping handles reversed it). Comparison: `DEPENDS_ON` is met by any import or call from inside the source to inside the target, so a drawn dependency can be verified (`relationshipPresent`, used by the live and snapshot comparisons). (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `sheet-removals` Sheets propose removing live code (`db/sheet_removals.go`, schema 4): removal wins over a move, stays listed until restored, is marked done once the code is gone, and is checked by the live comparison, the frozen work-order snapshot and the build spec. Canvas: Delete on a live node on a sheet proposes removal (hidden on that sheet with its contents, Restore in the notice and in the rail's "Removed on this sheet"); Floor Delete This File… / Delete <system>'s Code… draw a "Remove …" sheet and attach it to the order. Agents: `edit_sheet` `remove`/`restore`. Go, MCP e2e and Playwright tests. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `code-fit-follow-through` Files moved on disk keep their identity, system and layout (`indexer/moves.go`: same content or the only vanished file with that name, either event order, 30 s); Review Changes move/group/merge claims carry `codeFit` with Make the Code Match…; `get_architecture` scope `changes` returns `codeDisagrees`; work orders sent with `codeFitFileIds` are re-checked by Axiom (`db/code_checks.go`, schema 3) and show "Checked by Axiom" in the inbox and in the agent's reply result. MCP e2e drives the whole loop through the real watcher. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `make-code-match` After a meaning edit archd checks the files it placed against the code (`db/code_fit.go`: outside the system's home folder, or imports mostly tied to another system) and returns `codeFit`; the canvas notice says where the code disagrees and offers Make the Code Match… (a written work order, since sheets cannot express file moves); agents get `codeDisagrees` in `edit_systems` assign/merge results. Go, unit, MCP e2e and Playwright tests. Follow-up: `code-fit-follow-through`. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `floor-reality-to-work-order` Changes that need code start a work order instead of happening on the Floor: right-click open canvas → New System Here… draws a planned system on a new sheet ready to send; right-click a file → Delete This File…, a system → Delete <system>'s Code… open the send dialog with the instruction written (dependency, split and connection gestures moved to `floor-more-reality-gestures`). Playwright covers both. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `floor-meaning-gestures` On the Floor, placement is meaning: a drop into a system assigns files / nests systems, a drop on open canvas un-assigns / un-nests, recorded before the layout is saved (`canvas/floorMeaning.ts`, `meaningActions.ts`); inline rename of live systems (`floorEditContext.ts`); right-click Ungroup, Group into New System, Take Out of <system>; Delete on a system ungroups, on a file explains; every edit confirms with an Undo notice. Contract and QA checklist updated; Playwright covers drop-nest, Delete and rename. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `meaning-edits-review-undo` Meaning edits appear in Review Changes as claims (moved, renamed, nested, merged, ungrouped, grouped), collapsed to net effect and attributed ("by you" / "by codex"); each has Undo (`POST /api/architecture/undo`, refused with a reason when later work would be overwritten; an edit and its undo cancel out); agents read recent changes via `get_architecture` scope `changes`. Not yet checked in the real app. (claude/gracious-gauss-1bgdv9)
- 2026-10-01 `meaning-edits-recorded` One recorded path for meaning edits (`POST /api/architecture/edits`, `internal/db/meaning.go`): create, rename, describe, nest, assign, merge (now atomic), ungroup; journaled with before/after and a stated actor; inferred systems touched by an edit are adopted; MCP `edit_systems` and the renderer use it; older routes refuse unattributed meaning changes; tidy/geometry never journals. Also fixes returning a file to the unsorted bin, which sent an empty system ID. (claude/gracious-gauss-1bgdv9)
- 2026-09-30 `docs-consolidation` Stray briefs and plans consolidated: current docs in `docs/`, old plans in `docs/history/`, the bug hunt became `docs/testing/CANVAS_QA_CHECKLIST.md`, LAUNCH split into this file and `docs/DECISIONS.md`, new PRODUCT/ARCHITECTURE docs, README repositioned around bidirectional architecture. (claude/gracious-gauss-1bgdv9)
- 2026-09-30 `ci-fix` Open-time backup made synchronous; path tests made host-independent. (c063eb8)
- 2026-09-30 `merge-infra-work-orders` Merged the infrastructure sidebar, hosting frames and work orders; canvas commands joined the shared command model. (d253dbc)
- 2026-09-30 `map-safety` Recently Deleted, daily backups, export/import. (1a04756)
- Earlier launch plumbing (license, security, OS integration, updates, logs, menus, settings, large projects): see [docs/DECISIONS.md §6](docs/DECISIONS.md) and [CHANGELOG.md](CHANGELOG.md).
