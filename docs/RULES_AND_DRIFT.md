# Rules and drift (design proposal)

Status: **proposal, needs decisions** (WORK `rules-and-drift`, questions at the
end). Nothing here is built. The historical version is "Intent sheets" in
[history/UML_UX_PLAN.md](history/UML_UX_PLAN.md) §4; this revision fits it to
what Ambio is now.

## Why

A sheet describes one piece of work, and is resolved when that work lands.
Staying aligned over months needs agreements that outlive any one change:
"Payments never calls Email directly", "the UI never imports the database",
"only downward dependencies between layers". Today nothing records them, so
an agent cannot know them and the human only finds out a boundary eroded by
reading diffs. Drift detection is also the architecture feature teams pay for
(vFunction, Structurizr, Archyl), which makes it the most likely team entry
point (`rules-in-ci`).

The principle stays the product's: **a rule blocks nothing; it is reported the
moment code breaks it, to the human and to the agent.**

## What a rule is

Rules are model-level, not per sheet: they hold for the whole project until
someone deletes them. Four kinds, all over systems (and infrastructure), never
individual files, because systems are the vocabulary people and agents share:

| Kind | Says | Broken when |
|---|---|---|
| `forbid` | A must not depend on B | any import or call from a file in A (or below) to a file in B (or below) |
| `only_through` | A reaches B only through C | a call path A → B exists with C removed from the graph |
| `layers` | ordered bands: UI > Domain > Data | a dependency goes upward |
| `allow` | A → B is expected | never; documents intent and silences the "new coupling" claim for that pair |

`forbid` reuses the containment-aware dependency check written for drawn
dependencies (`db.relationshipPresent`, `within`), inverted. `only_through` is
a reachability check on the call graph with C's files removed, scoped to A's
and B's files so it stays cheap. `layers` is `forbid` generated from the band
order.

Exceptions are part of the rule, not a separate mechanism: an `exclude` list of
path globs (tests, mocks, generated code) and an optional note saying why.

## Who writes them, and how (both directions)

- **On the canvas.** On a sheet, a connection drawn between two systems gets a
  kind picker: *should depend* (today's planned edge), *must not depend*
  (`forbid`), *only through…* (`only_through`). Saving a sheet's rules is an
  explicit "Make this a standing rule", so a sheet stays a proposal and a rule
  is a decision. Layers are bands drawn across the Floor in a rules view.
- **By an agent.** `edit_systems` gains `op: "rule"` (create, update, delete,
  list), within the MCP budget (an op, not a tool). An agent's rule arrives
  pending, like its planned elements, and appears in the same To review list
  (`agent-sheet-arrival`) until you confirm it. Agents can propose rules; only
  confirmed rules are enforced.
- **Recorded like meaning edits.** Creating, changing or deleting a rule is a
  journaled, attributed meaning edit, so it shows in Review Changes and can be
  undone (`meaning.go`, `meaning_undo.go`).

## How drift is found and shown

- **Checked after indexing settles**, never inline with a save: a debounced
  pass after the watcher's classification (the same point infra detection
  runs), plus on demand. Violations are materialized in a `rule_violations`
  table with first-seen / last-seen, so a violation that existed before the
  rule was written is distinguishable from one introduced later.
- **Review Changes** gets a claim per newly broken rule ("Payments now calls
  Email directly - breaks *Payments never calls Email*"), attributed to the
  session that introduced it, with the offending files as evidence. A rule
  that becomes satisfied again gets a "fixed" claim.
- **On the map**, a broken rule draws as a red dashed edge between the two
  systems, with the count of offending imports; clicking it lists them.
- **For agents**, `get_architecture` scope `rules` lists rules and open
  violations, and `start_work` includes the rules touching the systems the
  agent declared it will work in, so it learns them before writing code. A
  work order's reply runs the check and reports new violations, like the code
  checks (`db/code_checks.go`).
- **Make the code match.** A violation offers the same written work order as
  code fit ("Payments imports email/send.ts; route it through Notifications"),
  and the order is verified by re-running the rule.

## CI (`rules-in-ci`, after this)

A headless `archd check --workspace <map> --base <ref>` exits non-zero on
violations introduced since the base, and prints them in the same words as the
claims. Rules must then live in the repo, not only in the map (see Q2).

## Data (sketch)

```sql
rules (id, workspace_id, kind, src_type, src_id, dst_type, dst_id,
       via_id,              -- only_through
       bands TEXT,          -- layers: json [[system ids]...] top to bottom
       exclude TEXT,        -- json globs
       note TEXT, status,   -- pending | active
       created_by, created_at, updated_at)
rule_violations (id, rule_id, src_file_id, dst_file_id, dependency_type,
       first_seen, last_seen, status)   -- open | fixed
```

`SchemaVersion` bump with an upgrade fixture (AGENTS.md).

## Slices

1. `forbid` and `allow`: table, meaning-edit ops, checker, Review Changes
   claims, `get_architecture` scope `rules`, MCP `op: "rule"`. Canvas: rules
   listed in a panel; violations as red edges. (Smallest useful whole.)
2. Drawing rules on sheets and "Make this a standing rule"; agent rules
   pending review.
3. `layers` (bands view).
4. `only_through` (call-graph reachability).
5. `rules-in-ci`.

## Decisions needed (Max)

- **Q1. Granularity.** Systems only (proposed), or also folders/globs ("nothing
  in `src/ui/**` imports `src/db/**`")? Globs are what ArchUnit-style tools do
  and survive regrouping; systems are the shared vocabulary and follow your
  curation.
- **Q2. Where rules live.** In the map database only (simple; per machine), or
  also exported to the repo as `.ambio/rules.json` so teammates and CI share
  them (needed for `rules-in-ci`, and the history plan's answer)?
- **Q3. Existing violations.** When a rule is written that the code already
  breaks: report all of it as debt (one "N existing violations" claim), or
  only what is introduced afterwards? Proposed: one debt claim at creation,
  then only new ones.
- **Q4. Do agents' rules need your confirmation** before they are enforced
  (proposed), or apply immediately like meaning edits (DECISIONS 2026-10-01)?
