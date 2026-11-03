# Review a meaningful change

Design, 2026-10-29, from Max's first Helios Propose baseline. Compact sidebar
cards, atomic node/connection decisions, planned file summaries and scaled
containment are implemented on `codex/sheet-review-polish`. Moves and renames
retain separate decisions. This document does not approve the Helios plan. Open tasks:
[WORK.md](../WORK.md). Observed baseline: [HELIOS_AGENT_BASELINE.md](testing/HELIOS_AGENT_BASELINE.md).

## Problem observed

Offline Scene Replay is one small capability: a new tool boundary with a CLI,
synthetic scene inputs and verification, reusing existing heuristics. The
screenshots show eight separate pending rows: four additions and four
relationships. At overview zoom the relevant proposal is not apparent among
many existing systems; at detail zoom planned file cards expose No symbols,
member-add controls and repeated Added labels. Max reports node containment
issues and excessive review burden.

`SheetProposalReview.tsx` confirms that pending nodes, moves, renames and
relationships are concatenated into a flat list. The count is the number of
graph requirements, not independent architectural decisions. Confirm all loops
through individual mutations sequentially; it is not an atomic revision-bound
approval transaction. Planned files use the shared file-card rendering, which
explains the empty symbol editor chrome. The containment root cause has not been
reproduced, and must not be inferred from screenshots alone.

The reviewing connector is bound to Ambio's own project and lists no sheets.
Helios's exact saved proposal, notes, paths, approvals and compare results have
not been inspected. These observations concern presentation and apparent intent;
they do not certify the plan's complete structural correctness.

## Recommended review unit

Present **a named, coherent change** with exact details in an inspector:

> Add Offline Scene Replay Tool
>
> Inside Reflex Collision Heuristics. Adds the CLI, synthetic scenes and
> verification. Uses the existing evaluator; its behavior remains unchanged.
>
> 1 system · 3 files · 4 connections
>
> Inspect changes
>
> Approve change · Request changes

Grouping reduces navigation and repeated decisions. Every actual proposed node,
move, rename and relationship remains represented, inspectable and individually
decidable. Approving a group explicitly approves its displayed constituent
requirements. Approval does not start a build or approve new future additions.
This preserves DECISIONS' 2026-10-20 rule that every part waits for the human.

Use these principles:

- Count changes at the top level. Show the number of constituent details
  separately; do not conceal scope or label eight graph records as one file.
- Group by explicit proposal intent and the smallest coherent boundary, using
  containment as a clue. Do not blindly make the whole sheet one approval or
  infer that everything sharing a parent has the same purpose. Ambiguous
  relationships/independent changes stay separate until explicitly assigned.
- Keep boundary moves, deletions, public-interface changes and cross-system or
  external dependencies prominent, including when grouped. A new local test
  file and a new production-service dependency do not deserve equal emphasis.
- Explain before/after, ownership, reused dependencies, behavior constraints and
  verification in ordinary language. Expand the exact files/edges as evidence.
  Existing contextual imports are not new approval requirements.
- Request changes can address a group or a precise detail, with the reason
  delivered to the agent. Human and agent can inspect decisions and resulting
  scope; the agent cannot approve its own proposals.

## Sidebar refinement (Max, 2026-10-29)

Keep To review at the bottom-left, with compact counts and intent. Inspect
changes opens a styled nonmodal panel grouped by additions and connections,
with individual decisions and the existing revision-checked group actions.
There is no native details dropdown or raw “8 details / 2 outside” label.

Sheet navigation is a per-sheet expansion in the list above. A chevron expands
contents without activating the sheet; the title activates it, using two lines
when necessary. Ctrl/Cmd-click toggles extra visible layers with one primary
editing target. Remove visibility checkboxes, abbreviated type/author badges,
inline dispatch and persistent deletion. Hover/focus or right-click opens the
same contextual Rename / Discuss or implement / Delete menu. Approved contents
stay in the tree; the bottom Contents dropdown is removed. Connection controls
live in the expanded active sheet.

## Approval semantics

An approval acts on exact current requirement identities and a sheet revision.
The server revalidates the selection, nested parents and edge endpoints, then
applies the included decisions atomically. A stale revision fails visibly and
refreshes the review instead of partially approving an old/new mixture.

Individual rejection must expose the consequences: a rejected parent or missing
endpoint can leave related requirements unbuildable. Show those requirements as
needing resolution. Never silently approve them, silently erase their decisions,
or construct a build plan that implies an unapproved dependency. Mixed-status
groups display partial review and the remaining scope accurately.

After an agent revises a plan, show what changed since the person's last review.
New or changed scope remains pending. Preserve accepted unchanged requirements
only where their identities/content remain valid; old approval cannot authorize
changed semantics under a reused label. Keep proposal approval distinct from
Build permission, completed-code acceptance and technical execution policy.

The first implementation can use a deterministic grouping of currently nested
additions and their explicit attached relationships, with uncertain items kept
separate. Broader first-class change-intent authoring requires an explicit
human/agent contract rather than hidden UI-only metadata. Prefer an operation
on the existing sheet surface under the MCP budget.

## Canvas and node presentation

- Provide an explicit Show proposed change action that frames the proposed
  boundary, necessary context and relationships. Whole-sheet Fit remains
  available. Do not reset authored layout or automatically fight the user's
  camera whenever a proposal event arrives.
- Planned file cards lead with responsibility, proposed path/type and short
  notes. Symbol editing remains available as an intentional detail action;
  missing future symbols should not dominate a file that does not exist yet.
  Both human editing and agent editing remain supported.
- Show a clear proposed state without repeating Added badges at every nested
  level. Rejected and partially approved scope remains discoverable.
- Reproduce containment using the actual saved geometry or a faithful fixture
  before fixing it. Audit header/tab clearance, child body bounds, interior scale,
  nested frame depth and shadows/badges at ordinary and extreme zoom. Distinguish
  visual overflow from incorrect semantic parentage.
- Layout fixes must use the shared canonical content rectangle and preserve
  authored geometry, scales and Floor/sheet isolation. Clipping content is not
  an adequate fix for incorrect packing or measurement.

## Delivery slices

1. Reproduce and fix planned-node containment within existing layout boundaries;
   capture regression geometry and before/after visual evidence.
2. Build the grouped review presentation and explicit change focus with current
   underlying records. Keep detailed and individual review available.
3. Add revision-bound atomic group decisions and safe partial-review behavior.
   A visual group button must not promise atomicity over the current sequential
   implementation. Draw any new structural boundaries/dependencies first.
4. Connect the reviewed scope back into the conversation's explicit Build
   request, preserving the frozen work-order specification and revision.

This is a recommended product sequence, not a reprioritization of Now or
authorization to implement the existing Helios sheet.

## Acceptance

- Helios's four additions/four relationships read as one coherent change with
  all eight details discoverable, correct count and exact reviewed scope.
- A sheet with two independent changes offers two decisions; unrelated
  cross-boundary effects cannot disappear inside a group.
- Approve group, reject detail, request revision, partial review, stale revision,
  disconnect/retry and changed-plan cases preserve correct durable decisions.
- Agents receive the same approved scope the person sees. Confirmed plans do
  not start execution; future edits cannot inherit accidental permission.
- A nested planned-node fixture fits its canonical content area at all tested
  depths/scales and zooms; placement survives re-opening without mutating Floor
  geometry. Existing file/symbol editing and accessibility remain available.
- The UI can focus only the proposed change while retaining inspection of the
  existing dependency it reuses. Human navigation is not repeatedly overridden.

Two contained review sketches accompany this discussion: Change card leads with
the change and its three parts; Review brief leads with scope, reuse, verification
and exclusions. Both offer exact detail inspection, revision requests and
approval separately from Build. Their interactions are local previews, not live
plan decisions.
