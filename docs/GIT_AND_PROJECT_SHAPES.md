# Git, branches and project shapes (design proposal)

Status: **decided 2026-10-20** (DECISIONS §1; Q1-Q6 below accepted as
recommended). Build items are in WORK.md under *Git and project shapes*,
starting with `git-checkout-truth` (stage 0). It replaced four open questions:
`project-shapes`, `branches-and-worktrees-ux`, `worktrees-one-or-two` and
`multi-root-projects`.

## Why

Ambio assumes one project = one git repository = one checkout = one branch.
Real projects break that every day:

- You switch branches. Agents switch branches.
- Claude Code, Codex and Cursor each put parallel agents in their own
  worktrees (`.claude/worktrees/`, `~/.codex/worktrees/`, …).
- Polyrepo teams keep a frontend, an API and infra in three repositories.
- Some folders have no git at all yet. Some are a package inside a monorepo.

Each of these should feel like a first-class, designed state, not an edge case.

Parallel agents are where this pays off most. Every agent manager is converging
on "one agent per worktree", and none of them shows how the architecture of
five branches relates. Ambio already computes cross-branch semantic collisions;
it just hides the result behind a panel that pops up unasked.

## What happens today (audited 2026-10-20)

The daemon has a real foundation: `internal/gitworktree` discovers worktrees,
watches `refs/` and `worktrees/` for changes, and computes merge bases. Every
worktree becomes a `roots` row. History rows carry `root_id` and `branch`.
`collision` projects each branch's changed files onto systems.

What is broken or missing, verified with throwaway tests against real git repos
(the tests are not committed):

| Situation | What happens | Where |
|---|---|---|
| `git checkout feature` then back to `main` in the open folder | Journaled as code changes by `human`. The branch stamps are **inverted**: the watcher's file batch lands before the HEAD monitor updates the root, so feature's code is recorded "on main" and its removal "on feature". `main`'s Review Changes then reports edits after a round trip that left it byte-identical. | `indexer/journal.go` stamps `root.Branch` at write time; `api/worktrees.go` updates the branch 200 ms+ later |
| Open `monorepo/packages/web` | The root silently becomes the repository top level and the whole monorepo is indexed. | `canonicalGraphRoot` falls back to the primary worktree when the opened path is not a worktree path |
| `git init` in a folder Ambio already has open | Not noticed until the 5-minute safety poll. Live branch tracking never starts until restart: the metadata watcher is attempted once. | `startWorktreeMonitor` |
| An agent works in a linked worktree | Its files are never indexed, so its work never appears live on the map (the "alive" law). Only the collision panel, polling git every 4 s, notices it. | `syncWorkspaceWorktrees` clears linked projections by design |
| A second worktree appears | A floating "Parallel branches" panel opens, expanded, over the bottom-left of the canvas. This is the popup. | `AgentLane.tsx`, shown whenever `branches.length > 1` |
| Which branch am I on? | Shown nowhere unless there are two or more worktrees. | - |
| Two Ambio-launched agents at once | Refused: "An Ambio-launched agent is already running in this project". Every run uses the project folder. | `electron/agentDelivery.ts:277` |
| Review Changes watermark | Per root, not per branch, so reviewing on one branch acknowledges another. | `GetDeltaReviewedAtForRoot` |
| Parent folder holding several repos | Indexed as one plain folder: no branches, no co-change history, no collisions. | `discoverInitialWorktrees` fallback |
| Agents asking about other branches | No MCP surface for collisions or other checkouts. | `mcp/ambio-mcp.ts` |

## The model

Three nouns, used the same way everywhere (UI, API, MCP, docs):

- **Project**: what you open in Ambio. It owns the systems, sheets, rules,
  layout and history. Unchanged.
- **Repository**: a source of files inside the project. It is either a git
  repository, or a **plain folder** (no version control). A project has one
  or more. It records its folder within the git checkout (`subpath`), so a
  monorepo package is a repository with `subpath: packages/web`.
- **Checkout**: one working copy of a repository at a branch, a detached
  commit, or an unborn branch (`git init`, no commits yet). Git worktrees are
  checkouts. A plain folder has exactly one checkout, with no branch.

Today's `roots` table becomes checkouts; a new `repositories` table sits above
it.

### One map, many checkouts

The rules that make this feel coherent:

1. **Meaning is project-wide, not per branch.** Systems are Ambio's
   interpretation (PRODUCT §2). Renaming a system while `feature` is checked
   out renames it everywhere. Branching meaning would fork the map every time
   an agent opens a worktree, and nobody wants to merge diagrams by hand.
   (If `committed-maps` ships, git versions the shared text files and this is
   revisited there.)
2. **Layout is project-wide.** Positions are keyed by system and file
   identity, so a node keeps its place across branches. A file that exists
   only on one branch keeps its position while hidden.
3. **The Floor shows one focused checkout per repository.** By default that
   is the folder you opened. The Floor stays complete and current for it.
4. **Every other checkout is an overlay.** Ambio indexes only what differs
   between that checkout and its merge base with the focused one: committed
   changes plus working changes. This usually means tens of files, not the
   whole tree, so it is cheap. The result is drawn on the shared map as that
   branch's additions, edits and removals. Your agents' work in their
   worktrees arrives live, file by file.
5. **Focusing another checkout is a re-projection, not a re-index.** It is
   the same operation as a branch switch (next section): re-read only the
   files that differ, quietly.

This answers `worktrees-one-or-two`: worktrees of one repository are **one
project**, and the branch chip makes that explicit.

### HEAD moved: what kind of change was it?

Every time a checkout's HEAD moves, Ambio classifies the move before it
journals anything. This fixes the checkout bug at the root:

| What moved HEAD | Disk changed? | Journal |
|---|---|---|
| Commit (yours or an agent's) | No, files were already journaled when written | Update the head only |
| Switch to another branch | Yes | **Not code change.** One `checkout.switched` row. Files whose content now equals the new HEAD's blob are reconciled quietly; uncommitted changes carried across the switch are journaled normally. |
| Pull, merge, rebase or reset on the same branch | Yes | One grouped "Pulled 4 commits" entry, attributed to the commit authors (`git:<author>`), reviewable as claims. This is often exactly what you want to review: what changed when you pulled. |

Mechanically, the watcher's debounced batch reads the checkout's HEAD (one
`git rev-parse HEAD`, or reading `.git/HEAD` and the ref file) before
journaling. If HEAD differs from the recorded one, it updates the checkout row
first. It then compares each changed file's git blob hash
(`sha1("blob <len>\0" + content)`) against the new tree (`git ls-tree`). That
removes the race instead of tuning debounce timers.

### Review Changes and history across branches

- The watermark becomes per checkout **and** branch, so each branch keeps its
  own "unreviewed since".
- Review Changes shows the focused checkout's branch, with a branch picker in
  its header.
- **New: Review a branch.** This is the architectural diff of a branch against
  its base (merge base with `main`, or a chosen base), computed from git and
  the overlay rather than from the journal. It is effectively the
  architecture of a pull request: "this branch makes Api depend on Storage,
  adds a Billing system, touches Payments and Orders". It reuses
  `delta.BuildClaimsWithSnapshots` with an overlay snapshot as *after*. It is
  also the natural input for `rules-in-ci`.
- Work sessions and agent actions already carry checkout and branch. Keep
  them, and show the branch on session rows only when the project has more
  than one checkout.

## Shapes, one by one

| Shape | How Ambio treats it |
|---|---|
| One repo, one checkout (most users) | Looks exactly like today, plus a quiet branch chip. Branch switches no longer pollute Review Changes. |
| Plain folder, no git | Everything works: history comes from the journal, which never needed git. The chip reads "No Git" in muted text and offers nothing pushy. Clustering loses co-change weight only. If `.git` appears (the root watcher sees it), Ambio starts tracking branches immediately. |
| Unborn repository (`git init`, no commits) | A branch with "no commits yet". Collisions and branch review explain that they need a first commit, instead of showing "git unavailable". |
| Detached HEAD | The chip shows `abc1234 (detached)`; everything else works. |
| Worktrees of one repository | One project. Each worktree is a checkout; the focused one is the Floor, the others are overlays. Worktrees outside the project folder (agent-managed) are found through `git worktree list`, as today. |
| Monorepo opened at a subfolder | One repository with `subpath`. Only that subfolder is indexed and watched. Git commands use the subfolder as a pathspec, and each linked worktree maps to `<worktree>/<subpath>`. |
| Parent folder holding several repositories | Each git repository found under it (bounded depth, respecting exclusions) becomes a repository in the project. Files outside every repository form a plain-folder repository. |
| Folders added from different places (File → Add Folder to Project…) | Same as above: each added folder is a repository. This is the held `multi-root-projects` work, now with a shape. |
| Submodule | A nested repository, shown pinned to its commit (`vendor/sdk @ 1a2b3c4`). Its branch moves only when the parent repository moves the pin. |

With more than one repository, the Floor's top level groups by repository: a
frame per repository, like the hosting frames. Clustered systems never span
repositories, though a human or agent may group across them as a meaning
edit. Relationships between repositories are drawn when they resolve: a
shared package, an HTTP client to a detected service, or infrastructure both
use.

## Agents and worktrees

- **Every agent resolves to its checkout from its cwd**
  (`findWorktreeForCwd`, `resolveWorkspaceRootForCwd`, as today). Its work
  session, actions and journal rows are stamped with that checkout. With
  overlays, its files appear on the map live, tinted by branch.
- **Ambio-launched runs can get their own worktree.** Send gains a "Where"
  choice: *This checkout* (today's behaviour), or *New worktree*. A new
  worktree is created with `git worktree add -b ambio/<slug>` under
  `~/.ambio/worktrees/<project>/`, outside the repository so nothing leaks
  into it. This removes the one-run-at-a-time limit: two work orders can run
  in parallel, each on its own branch, both visible on one map, with
  collisions shown before either merges.
- **Finishing a worktree run** comes back to Work Order Review with the
  branch's architectural diff (Review a branch), plus three actions:
  *Merge into <base>*, *Keep the branch* (removes the worktree, keeps the
  branch for a PR), *Discard*. Ambio never pushes, and never touches a
  branch it did not create without asking.
- **MCP.** Agents get the same picture through an existing tool, inside the
  surface budget (MCP_SURFACE): `get_architecture` scope `branches` returns
  checkouts, what each is changing at the system level, and collisions
  involving the caller's branch. The installed workflow can then say "before
  editing Payments, check whether another branch is already changing it".

## The experience

The goal: git state is always visible and never in the way. Nothing pops up.

1. **Branch chip in the toolbar**, beside the project name, always shown:
   `main`, a dot when there are uncommitted changes, ↑2 ↓1 when it is ahead
   or behind its upstream. In a multi-repo project it reads `3 repos` and
   opens the same popover. The status bar can be hidden, so it does not go
   there.
2. **Checkouts popover** (click the chip, or `⇧⌘B` from `appMenu.ts`): one
   row per checkout, grouped by repository, each showing its branch, the
   agent working there, how many systems it touches, and a collision mark.
   Row actions: *Show on the Floor* (focus), *Review this branch*,
   *Open in editor / terminal*, *Remove worktree*. The footer has *New
   worktree…* and, for the focused checkout, *Switch branch…* (see Q3).
3. **Overlays on the Floor.** A lens control in the popover: *Other branches:
   Off · Agents only · All*. Default: *Agents only*. A branch's new files and
   systems draw as dashed, tinted ghosts; edits get a small branch-coloured
   edge on the node; removals strike through. Hovering a ghost names the
   branch and agent.
4. **Collisions live on the systems.** A system touched by two or more
   branches gets a small stacked-branch badge; clicking it opens the
   system's Properties with a "Changing on other branches" section. The
   floating Agent Lane is retired; its content moves into the popover and
   Properties.
5. **Arrivals are calm.** A new worktree appears as a count change on the
   chip with the canvas's usual arrival animation, not a panel. A branch
   switch fades the outgoing branch's nodes and fades the new ones in, the
   same "files arrive" motion the Floor uses, so you see what the switch
   changed without anything being called a change.
6. **Empty and odd states are written, not errors.** "No Git: history still
   works from Ambio's own record." "No commits yet: branch comparisons start
   after your first commit." "Detached at abc1234."

The canvas contract (`CANVAS_BEHAVIOR_CONTRACT.md`) gains rules for overlays,
the branch-switch transition and focus changes when this is built.

## Data (sketch)

- `repositories(id, workspace_id, kind: git|plain, folder, git_toplevel,
  subpath, common_dir, display_name)`.
- `roots` (checkouts) gain `repository_id`, `kind: primary|linked|plain`,
  `is_focused`, `head_state: commit|detached|unborn`, and upstream
  ahead/behind.
- File identity becomes per repository (`repository_id, rel_path`) rather
  than per root, so a file keeps its system, layout and history across
  checkouts.
- `overlay_files` and `overlay_edges` per non-focused checkout: diff-sized,
  rebuilt from git plus a parse of the changed files.
- Delta watermarks keyed by `(root_id, branch)`.
- Journal kinds: `checkout.switched`, `git.pulled` (grouped, with commit
  range and authors).
- One schema bump, with an upgrade fixture (AGENTS.md). Existing single-root
  projects migrate to one repository with one focused checkout.

## Slices

Each slice ships on its own and leaves the app better.

0. **Bugs, now:** `checkout-journaled-as-code` (classify HEAD moves, per-branch
   watermark), `subfolder-opens-whole-repo`, and retrying the metadata
   watcher after `git init`. No UI change.
1. **See it:** branch chip and Checkouts popover; retire the floating lane
   (collision badges on systems, details in Properties); "No Git", "no
   commits yet" and detached states written properly.
2. **Live worktrees:** overlay indexing for linked checkouts, the lens, and
   *Show on the Floor* (focus).
3. **Review a branch:** the architectural diff of a branch against its base,
   in Review Changes and in Work Order Review; MCP `get_architecture` scope
   `branches`.
4. **Parallel runs:** Send → *New worktree*; finish actions (merge, keep,
   discard); lift the one-run limit. This closes Inbox
   `work-order-isolated-roots`: slices 2-3 are what bind comparison and
   review to the run's own checkout.
5. **Monorepo subfolders:** a repository with `subpath`, from setup through
   worktrees.
6. **Several repositories:** `repositories`, nested-repository discovery,
   Add Folder to Project…, repository frames, cross-repository edges,
   submodules.

## Decisions (accepted 2026-10-20)

- **Q1. Is meaning project-wide or per branch?** Recommendation:
  project-wide (rule 1 above). Per-branch systems would make every agent
  worktree fork the map.
- **Q2. Worktrees: one project or several?** (was `worktrees-one-or-two`)
  Recommendation: one project, with the branch chip and overlays making it
  explicit. Collisions across branches are the differentiator.
- **Q3. Does Ambio run git that changes your checkout?** Options: (a)
  read-only, plus worktrees Ambio creates for its own runs; (b) also *Switch
  branch…* on the focused checkout (refused while there are uncommitted
  changes, with a clear message); (c) also commit, push and open PRs.
  Recommendation: (b). Switching is the one action people expect next to a
  branch chip, and Ambio already follows switches safely. Leave commits and
  pushes to the user's tools and agents.
- **Q4. Where do Ambio-made worktrees live, and what are their branches
  called?** Recommendation: `~/.ambio/worktrees/<project>/<slug>` on
  `ambio/<slug>`, so nothing is written inside the repository.
- **Q5. Default overlay lens.** Recommendation: *Agents only*, meaning
  checkouts with an active work session. All branches at once is noisy on a
  repo with many stale worktrees.
- **Q6. Multi-repo before or after launch?** (was `multi-root-projects`)
  Recommendation: slices 0-4 before launch, since they fix what users
  already hit. Slice 5 next. Slice 6 after launch; until then, opening the
  parent folder covers most polyrepo setups.
