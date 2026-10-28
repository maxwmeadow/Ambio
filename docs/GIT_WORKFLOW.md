# Git, natively (design)

Status: **direction decided 2026-10-28** (DECISIONS §1, "Ambio handles Git
natively"). Stage 1 is being built; the questions under *Open questions* need
Max's answers before the stage that depends on them. Builds on
[GIT_AND_PROJECT_SHAPES.md](GIT_AND_PROJECT_SHAPES.md), which stays the source
for what a project, a checkout and an overlay are.

## Why

Ambio already knows more about a branch than any Git tool: what it changes in
the architecture, which systems two branches both touch, which agent is
working where. But the moment you want to *do* something with a branch -
bring in what a teammate pushed, commit what an agent built, merge two
branches - you leave for a terminal or an editor. That breaks the loop Ambio
exists to keep: you, your agents and the map, all looking at the same thing.

The goal is that the everyday Git a developer does happens in Ambio, feels
calm, and shows its meaning on the map: not "14 files changed" but "this
pull makes Api depend on Storage".

## Principles

1. **Say where you stand in words.** "3 to pull from origin/main · 1 to push",
   "Up to date · checked 2 min ago", "No upstream yet". Counts without a
   direction or a remote are not an answer.
2. **One obvious next action.** The branch popover leads with the action the
   state calls for (Pull, Push, Publish, Check for updates) and keeps the rest
   secondary.
3. **Git only when asked.** Nothing runs in the background except reading
   status and, when the popover opens, a fetch (which changes only
   remote-tracking refs, never your files or branches).
4. **Never destructive by surprise.** Fast-forward pulls only until merge
   lands. No force push, no reset, no rebase, no branch deletion without a
   confirmation of its own that names what is lost.
5. **Git's refusal is the answer, in plain words.** When Git says no
   (diverged branches, local changes in the way, a rejected push, a sign-in
   failure) Ambio says why and what to do, and never works around it.
6. **Meaning shows on the map.** Every Git change that moves code is
   reviewable as architecture: pulls already journal as one "Pulled N
   commits" entry; merges and commits get the same treatment.
7. **Bidirectional.** What a person can do here, an agent can ask for through
   MCP and a person can hand to an agent (PRODUCT.md §1).

## The branch popover

Git's usual symbols carry the meaning (`GitIcon.tsx`, drawn like the rest of
Ambio's icons): ↓ pull, ↑ push, a cloud for the remote, a fork for a branch.

1. **Header: the branch is the switcher.** The branch name with a ▾ opens
   Switch branch; under it the folder (home written as `~`), and "on the
   Floor" when other checkouts are open. Reveal folder and Open in editor
   are icon buttons on the right.
2. **The remote line:** the upstream (`origin/main`), ↓/↑ counters (lit when
   non-zero), when it was last checked, and a ↻ Check for updates button that
   spins while fetching.
3. **The one action**, full width with its symbol: **↓ Pull N commits**,
   **↑ Push N commits** or **Publish to origin**. When there is an action,
   the button is the status; a glyph tile and headline appear only when
   there is nothing to press or it needs explaining: ✓ Up to date,
   ⚠ Diverged (needs a merge, so no button), Not published yet, No remote.
4. **The working tree:** ✎ N uncommitted files, or ✓ No uncommitted changes
   (stage 2 makes this the way into committing).
5. **Agents working in this checkout.**
6. **Other worktrees**, only when there are any: name, what it changes,
   its agent, and a row of icon buttons (show on the Floor, review, apply,
   discard, folder, editor), each named in its tooltip. Discard asks inline
   before anything is removed.

Labels that mean nothing with one checkout (a count badge, "on the Floor",
"primary", a subtitle) are not shown. "Review this branch" is not offered for
the Floor's own branch, where it would compare the branch with itself.

## Stages

### Stage 1 - sync (building)

- `POST /api/checkouts/sync {workspaceId, action}` with `fetch`, `pull`,
  `push`, `publish`, on the Floor's checkout. One Git network operation per
  project at a time.
- Git runs with no terminal to prompt on (`GIT_TERMINAL_PROMPT=0`) and a time
  limit, so a missing credential is a clear error rather than a hang. Saved
  credentials (keychain, credential manager, ssh-agent) work as they do in a
  terminal.
- Pull is `git pull --ff-only`. Push is `git push` to the upstream; Publish is
  `git push -u <remote> <branch>`, offered when the branch has no upstream and
  the repository has exactly one remote (or one named `origin`).
- The checkout snapshot carries `fetchedAt` (Git's `FETCH_HEAD` time) and
  `remotes`, so the popover can say when Ambio last heard from the remote and
  whether Publish is possible.
- The popover is rebuilt as above.

### Stage 2 - commit

- Changed files grouped by the system they belong to, on the popover and on
  the map (the Floor already marks uncommitted files).
- Stage by file or by system; write the message, or have the conversation's
  agent draft it from the diff and the architectural summary.
- Commit journals as one entry, reviewable as claims like a pull.

### Stage 3 - merge, with the map

Meaning is project-wide (GIT_AND_PROJECT_SHAPES rule 1), so two branches never
carry two maps. What diverges is the **code** (which moves files between
systems and adds dependencies) and the **map edits made on a branch** (a
sheet, a moved file, a new or renamed system, a relationship an agent drew).
A merge in Ambio:

1. **Previews** the result as architecture before touching anything, from
   the branch review and the collision marks: "merging feature makes Api
   depend on Storage; both branches changed Billing".
2. **Merges** when Git can do it cleanly, and journals the merge as one
   reviewable entry.
3. **Shows each conflict on the systems it hits**, and offers three ways
   through it:
   - resolve here, side by side;
   - open it in the editor;
   - **hand it to an agent** as a work order whose result comes back to
     Review like any Build.
4. Treats **map edits that disagree** the same way: a file moved to different
   systems on each branch, a system renamed two ways, a relationship drawn on
   one branch and removed on the other. Pick one, keep both where that makes
   sense, or send it to an agent.
5. Can always be **abandoned** (`git merge --abort`) until it is committed.

### Stage 4 - pull requests

Open a pull request from a branch, its description written from the
architectural diff; see review state and checks on the branch's row.

### Stage 5 - agents

MCP gets the same operations (`op` values on an existing tool, per
MCP_SURFACE.md), each one the person can see and, for anything that writes,
approve. An agent can be handed a conflict, a failing pull or a commit to
write.

## Open questions

- **Q1. Fetch on open, or also on a timer?** Recommendation: on open and on
  demand only (principle 3). A timer means network traffic and possible
  credential prompts nobody asked for.
- **Q2. What may an agent resolve without asking, in a merge?**
  Recommendation: nothing in stage 3; every resolution an agent proposes is
  reviewed like a Build. Revisit once there is a record of how good the
  resolutions are.
- **Q3. Map edits on a branch: where do they live?** Today a sheet or a moved
  file belongs to the project, not the branch, so "map edits that disagree"
  needs a record of which branch an edit was made on. Recommendation: stamp
  map edits with the checkout they were made in (the journal already stamps
  work sessions), and decide stage 3's map merge from that.
- **Q4. Pull when diverged:** offer merge (stage 3) or rebase too?
  Recommendation: merge only at first; rebase rewrites history and needs its
  own confirmation and explanation.
