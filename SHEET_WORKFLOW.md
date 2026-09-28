# Sheet → live architecture

A sheet is a scoped structural target, not a screenshot to reproduce. The inbox
connects the user's instruction to that target; the agent's own harness edits
code, while Axiom compares the authored requirements against its indexed live model.

## Canvas workflow

Choose **Attach a sheet** in the agent inbox, or use the arrow beside the active
sheet in the Drawings rail. The attachment shows its name and current revision.
It remains attached when navigating to **The Floor** with **Watch live canvas**.
A project message can explicitly select no sheet. Attachments are saved with drafts;
an uncertain send keeps its original sheet ID and payload across retries/reloads.

Sending freezes the sheet context, approved build specification, and structural
comparison together from one SQLite transaction. Pending/rejected proposals are
visible in discussion context with approval labels, but excluded from executable
build specifications. The snapshot does not silently change when the sheet changes.

The attached sheet's difference panel refreshes every three seconds and on sheet
revision changes. Live graph mutations continue through the existing workspace-scoped
WebSocket/indexing pipeline. The comparison shows outstanding requirements, not
inferred model activity or a fabricated percentage complete.

Once the agent requests checked resolution, the resolved sheet leaves active
overlays and the Drawings list. **Resolved sheets** retains it with a **Restore**
action. Nothing is deleted by resolution. The inbox message/reply also remains.
Restoration creates a new revision; historical resolution evidence remains stored.

## Agent workflow

1. Read the user's inbox instruction and snapshot context, or find a named sheet.
   `edit_sheet({op:"get",sheet:"checkout redesign"})` accepts an exact ID, a
   case-insensitive exact name, or an unambiguous fragment containing all supplied
   words. Ambiguous matches fail with candidates; the agent must ask rather than guess.
2. `edit_sheet({op:"compare",sheet:sheetId})` returns the current revision, comparison
   token, requirements, planned-to-live mappings, and remaining differences.
3. Implement the requested code using the harness; use existing Axiom architecture
   tools to curate the real map. Indexing provides file/contract realization evidence.
4. Bind a new live system or infrastructure node to its planned identity with
   `edit_sheet({op:"bind",sheet:sheetId,plannedId,liveId,revision})`. The node must be
   approved, the type must match, and both must belong to the workspace. File bindings
   cannot override independently indexed realization evidence. A binding bumps revision.
5. Apply an authored nesting requirement with
   `edit_sheet({op:"apply_nesting",sheet:sheetId,nodeId,revision,token})`.
   This preserves existing live coordinates/dimensions and changes the canonical
   parent relationship. It does not create code, fabricate dependencies, move files
   on disk, or silently change semantic file ownership. Those are explicit implementation
   or architecture-curation steps. Invalid hosts and cycles are refused.
6. Recompare after changes. When structurally equivalent and the requested tests and
   implementation work are complete, call
   `edit_sheet({op:"resolve",sheet:sheetId,revision,token})`, then reply to the inbox.
   Replying alone never resolves a sheet. A discussion-only request does not authorize
   implementation or archival.

`list` hides resolved sheets unless `includeResolved:true`. `get` on a resolved sheet
includes its saved resolution context/comparison as well as the current comparison.
`reopen` takes the sheet ID and revision. The default MCP tool count is unchanged.

## What equality means

- Scope consists of referenced sheet elements, canonical sheet layout opinions
  (including inherited live nodes), approved planned nodes, and planned relationships.
- Canonical `sheet_layouts` is authoritative for the desired nesting. Canonical
  `floor_layouts` is authoritative for live nesting; absent live opinions fall back
  to indexed file ownership/system hierarchy.
- Node identity/type, parent identity, and containment kind (`root`, `part_of`,
  `hosted_by`) matter. Coordinates, dimensions, scale, and relative sibling order do not.
- Planned systems/infrastructure need explicit identity mappings. Planned files also
  need matching indexed realization. Active realized file contracts are rechecked on
  indexing, so later drift can turn an unfinished sheet back into outstanding work.
- Planned typed relationships require corresponding live relationships. `CONTAINS`
  can be established by canonical nesting; other relationship kinds match live dependency
  types case-insensitively. Unsupported/unproven requirements stay outstanding.
- Rejected proposals and their edges are excluded. Pending proposals block resolution.
  Empty sheets and deleted/symbol-only references cannot claim structural completion.
- Objects outside the sheet's scope are untouched. Omission is never a deletion request.
  The comparison does not infer filesystem removals or semantic refactors from pixels.

Structural equivalence verifies the current workspace's indexed/model structure. It
does not prove arbitrary prose requirements, runtime correctness, successful deployment,
or test coverage. The agent must report those checks separately. A matching map is not
permission to skip the user's requested implementation.

## Resolution safety and retention

Comparison and resolution use SQLite transactions. Resolution checks the supplied
revision/token against a fresh comparison and requires no remaining differences.
Supported planned-file contracts are re-evaluated against source before resolution;
a manually supplied realization status is not sufficient evidence.
Outdated/incomplete requests return HTTP 409 with the current comparison. Identical
successful retries return the original resolution. A resolution stores the comparison,
sheet context, revision, and timestamp in `sheet_resolutions`; the sheet itself remains.

Editing/restoring a sheet bumps its revision and makes it active again. Resolved sheets
are excluded from automatic planned-file reconciliation, preserving historical records.
Sheet relationship edits also advance revision. Renderer polling recovers missed
resolution events; stale same-revision events cannot resurrect a resolved overlay.

HTTP routes under `/api/sheets/:id`: `GET compare`, `GET context`, and `POST bind`,
`POST apply_nesting`, `POST resolve`, `POST reopen`. Reads use `?workspace=…`; writes
use `{workspaceId,…}` and retain the local bearer-token requirement.

## Verification

Tests cover canonical-vs-legacy export, pixel-independent comparison tokens,
nesting application with geometry preservation, infrastructure hosting, containment
edges, pending approvals, missing implementation, contract drift, workspace isolation,
stale resolution refusal, retry idempotency, archival and restoration. The real stdio
MCP harness exercises lookup through resolution; Electron exercises direct attachment,
Floor navigation, live comparison refresh, archival, and restoration.
