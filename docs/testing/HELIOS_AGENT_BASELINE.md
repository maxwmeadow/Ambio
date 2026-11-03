# Helios: first coding-session baseline

Prepared 2026-10-29 for [the agent workspace roadmap](../AGENT_WORKSPACE_ROADMAP.md).
Status: Codex Ask, Build, follow-up recall and a separate Propose turn are recorded
from twelve user-supplied screenshots.
The Build's two-line diff and passing typecheck were independently checked.
Review controls were opened. Acceptance, revision and other engine routes remain
untested; restart before the recall screenshot is not independently established.
This reviewing session changed no Helios source.

## What this experiment answers

Can Max complete a useful coding task through Ambio, understand what the agent
is doing, review its changes and continue the conversation without opening
Claude Code or Codex separately? Which friction belongs to Ambio, which to
the engine, and which to the old project environment?

Max should operate the first session. An automated host smoke test cannot
measure whether the conversation feels natural or whether the controls make
sense. Observe the current product before implementing workflow transitions.

## Project and preflight

- Project: `C:/Users/maxst/VSCodeProjects/project-helios-spartahack`.
- Current branch: `polishes`; inspected commit: `c90db0d`. Record the full
  commit when creating each baseline checkout.
- React Native/Expo mobile app sends camera and motion information over
  Socket.IO to a Python backend. YOLO, contextual Gemini processing and person
  memory support guidance returned to mobile audio/haptics.
- The existing checkout has two modified mobile hooks, four modified data files
  and 329 tracked debug-image deletions. Do not reset, clean or incorporate these
  into comparative runs. No existing source change was overwritten during audit.
- On the existing checkout, `npm run typecheck` in `mobile` fails with:
  - `components/AudioStreamView.tsx(201,36)`: property `message` does not exist
    on type `string` (TS2339).
  - `hooks/useDeviceSensors.ts(201,11)`: `number` is not assignable to `Timeout`
    (TS2322).
- Those failures are a working-checkout observation. Re-run on each isolated
  checkout before assigning the task; do not assume identical results at HEAD.
- `backend/heuristics.py` loads with Python 3.14 using the standard library.
  Its scene evaluation can support an offline task without importing the server.
- Full backend startup loads models and may initialize memory/remote services;
  the first task does not require it. Native iOS, camera, sensors and audio
  validation are separate future journeys, not prerequisites for this baseline.
- Ambio MCP reported unavailable during preflight. No Helios map, sheets or
  approvals were read or written. Confirm project binding in the actual session.

## Setup and fair comparison

1. Start Ambio and open the already indexed Helios project. Verify the displayed
   folder and checkout; ensure a read-only agent request identifies Helios too.
2. Start with **Codex through Ambio**. Once that session is recorded, repeat with
   **Claude Code through Ambio**, then **native Ambio chat**. These are three
   execution routes, not three labels for the same agent implementation.
3. Give each route a fresh isolated worktree at the same recorded commit, with
   no earlier solution committed into it. Use Ambio's own-worktree control where
   available; otherwise prepare a separate checkout explicitly and open it in
   Ambio. Record missing native worktree support as product friction.
4. Restore mobile dependencies from the same lockfile in each checkout, recording
   Node/npm versions and install failures. Do not mix dependency installation time
   into agent response latency or silently upgrade dependencies to unblock a run.
   Do not copy personal credentials, runtime databases or camera captures.
5. Record engine/version, model, access level, Ambio revision and initial Git
   status. Use comparable settings. Hold task, prompts, dependency versions and
   success criteria constant; acknowledge model/harness differences.
6. If the isolated typecheck is already green, record that outcome and select
   the offline task below. Do not intentionally break the source to manufacture
   the two working-checkout failures.

No paid agent inference or additional checkout was started by this preparation.

## Session A: a small real fix

Allow about 20–30 minutes for the first human-operated session, excluding setup.
This is a budget for learning, not a performance claim. Avoid steering the agent
toward a known implementation; the compiler output supplies the evidence.

**First message, using Ask:**

> I want to get Helios mobile's existing `npm run typecheck` passing. Inspect
> the current failures and explain the affected code and the smallest correct
> fix. Don't edit yet. Use the current code as the source of truth and tell me
> which parts of the app are involved.

If Ask cannot execute the compiler, record that limitation and supply the
preflight output or use the supported access policy explicitly. Do not silently
upgrade access. Read-only inspection is enough to discuss known output.

Look for an understandable explanation, accurate file/map navigation and a
clear next step. A local type fix should not require a new architecture sheet.
Being asked to create an unnecessary sheet is a baseline failure worth recording.

**Next message, explicitly authorizing Build:**

> Make the smallest fixes and run `npm run typecheck` from `mobile`. Preserve
> runtime behavior and the existing project conventions. Don't use `any`,
> `@ts-ignore`, weaker compiler settings, dependency upgrades or new optional
> properties to hide the errors. Report exactly what changed, what you ran and
> anything you could not verify. Don't commit or push.

Use today's manual mode control when necessary; count that intervention.
If the agent needs a decision, answer through Ambio. Capture whether it was
possible and whether answering resumed the intended turn.

**Review and follow-up:**

> Show me the changes and explain why they preserve the affected behavior.
> Which runtime checks remain beyond the typecheck?

Inspect the actual diff and actual command result. A green typecheck does not
prove native audio, sensor or camera behavior. Record if reviewing the diff or
check output forces an external editor or terminal.

Reopen Ambio after the completed turn, then ask:

> What did we change, what check passed, and what still needs runtime testing?

The earlier decisions and results should be available without pasting them back.

## Session B: planning a bounded new capability

After Session A, use a separate fresh conversation/checkout for an offline
developer replay tool. This exercises planning without requiring a live phone
or a running model service. It is a distinct task, not an extension silently
added to the type fix.

**Initial discussion:**

> I'd like an offline way to feed saved, synthetic scene JSON into Helios's
> existing speech-decision logic and see whether it would speak, its urgency
> and its reason. It should work without starting the server, using a phone,
> loading models or calling external services. Explore a small design first;
> don't implement it yet.

**Planning request using today's Propose control:**

> Draw a small plan for this developer replay workflow. Reuse the existing
> heuristics implementation, show where the new developer tooling belongs and
> what it calls, and include fixture-based verification. Don't change code.

The human reviews the sheet before asking for Build. Preserve its revision and
authorized scope. A missing sheet, wrong project, duplicate live system or code
written before approval is a failure. If the plan cannot be created because the
map connection is unavailable, record the block rather than bypassing Ambio.

**Build only after reviewing and approving the concrete plan:**

> Build the approved replay plan. Keep evaluation behavior unchanged. Include
> reproducible checks for an empty scene, stationary scene, moving scene with
> an in-path object, and malformed input. Report the checks and compare the
> implementation with the approved plan. Don't commit or push.

Accept JSON input and inspectable JSON output; the approved design determines
the exact CLI/files and test command. No server imports, remote credentials,
real person data or model downloads should be required. Verify each fixture's
expected decision against the existing behavior, not an invented navigation rule.

## Interaction probes

Use these deliberately during the second session or a separate run. Do not race
the short type fix merely to force a timing test.

- While the agent is working, try to send: “Include the exact check command in
  the final reply.” Record whether the composer permits it, whether it was
  delivered to this turn or queued, and whether the agent acknowledges it.
- Stop at a safe point, inspect partial changes, and request continuation. Check
  that the agent neither loses the scope nor repeats completed side effects.
- Decline an optional action when one genuinely arises. The agent should explain
  the consequence and continue or stop honestly, without silently bypassing it.
- Review a result and ask for one small revision. Verify it remains in the right
  conversation, checkout and approved scope, with applicable checks rerun.
- Record the desired future interaction separately: agent offers Draw plan or
  Build approved plan, with durable human acceptance. Current manual mode changes
  establish the baseline; they are not evidence that this feature already works.

## Scorecard and evidence

For each step, record elapsed time, action taken, visible result and a friction
note. Screenshots/log excerpts should exclude credentials and personal captures.

| Measure | Record |
| --- | --- |
| Correctness | Baseline command result, final result, actual diff, scope preserved |
| Conversation | Context retained, useful questions, number of repeated explanations |
| Steering | Editable composer, delivery acknowledgement, queue/Stop behavior |
| Decisions | Mode changes, permission requests, plan approval and revision handled |
| Visibility | Useful activity, full tool/check output reachable, truthful status |
| App integration | Map/file/sheet links, diff navigation, review and notifications |
| Recovery | Reopen/continue result, partial work retained, no duplicate execution |
| Effort | Manual mode changes, copy/paste, external-app departures and why |
| Usage | Model and provider-reported usage/cost where available; unknown stays unknown |

Mark each journey step **pass**, **friction**, **blocked** or **not exercised**.
Distinguish Ambio UI/adapter, engine/account, project/environment and verification
gaps. Do not collapse these into a single numeric quality score.

| Route | Session A | Session B | Recovery/interaction probes |
| --- | --- | --- | --- |
| Codex through Ambio | Ask, Build and follow-up recall pass; acceptance pending | Sheet created; scope/approval/Build not verified | Recall observed; restart not established |
| Claude Code through Ambio | Not run | Not run | Not run |
| Native Ambio chat | Not run | Not run | Not run |

The baseline is established when the first human-operated journey is recorded,
the remaining routes have either results or explicit blockers, and the observed
friction is linked to actionable WORK items. A useful first run does not need
every route to pass. Measure the same journeys again after workflow transitions
ship; compare fewer interventions and departures without weaker verification.

## First observed result: Codex Ask, 2026-10-29

Evidence: Max supplied four screenshots showing the initial request, live
investigation, closed investigation and final reply. The visible agent/model is
Codex CLI / GPT-6.1-Sol, on Helios's `polishes` branch. Engine binary version,
exact Ambio revision, full transcript, access policy and checkout isolation were
not established by the screenshots. The connector in this reviewing chat is
bound to Ambio's own project; no Helios investigation history was fetched through
it. This is a review of user-supplied evidence, not a reproduced agent run.

### What worked

- Max used the planned Ask prompt without requesting an investigation tool.
  The agent selected the investigation workflow, created hypotheses, ran the
  typecheck, recorded verdicts and a conclusion, then closed the case. This
  demonstrates selection of an installed Ambio workflow without a tool-specific
  instruction in the user's task, on this one observed run.
- The recorded `npm run typecheck` reproduction exited 2 in 2.7 seconds. The
  investigation panel reports 55 seconds elapsed when closed; that is not a
  measurement of total conversation latency.
- The diagnosed failures match preflight: an Expo Location callback supplies a
  string, while the UI reads `.message`; a mobile timer result conflicts with
  the declared `NodeJS.Timeout` type.
- The final reply recommends two localized changes, explains the affected
  existing systems and says their interactions need no changes. No unnecessary
  architecture sheet was created.
- The agent reports a no-emit TypeScript check with both replacements supplied
  in memory, yielding zero diagnostics without writing files. This is useful
  scope-preserving validation, but the screenshots do not independently expose
  that compiler command/output or show it as a second recorded case run.
- The final reply distinguishes recommended changes from applied changes and
  calls for the real typecheck and device checks after applying them. It does
  not claim native compass/sensor behavior was runtime-tested.
- The investigation appeared live with hypotheses, run output access, file
  references and a replay control. Links/actions are visible; their click-through
  behavior and replay were not exercised in the supplied evidence.
- A read-only Git comparison after reviewing the screenshots found no current
  diff in either proposed target file. Existing totals remain six modified files
  and 329 deletions, matching preflight. This supports the reported no-edit
  outcome; it cannot prove that no temporary write occurred during the run.

### Friction and interpretation

1. **Evidence wording:** the case says the simulated compiler check has zero
   diagnostics but also says “Not yet verified by a run.” The case model stores
   an optional verification-run reference and uses that generic fallback text.
   Only the failing reproduction is visible as a recorded run. Do not mark the
   applied fix verified: it has not been applied. Present separate states for
   diagnosis reproduced, proposed fix checked in memory, fix applied and applied
   fix checked. Evidence not linked to a recorded run stays agent-reported.
2. **Duplicate narrative:** hypotheses appear in the summary/status list and
   again under Suspects, followed by verdict text and a long conclusion. The
   useful information is present, but requires repeated reading. Keep a concise
   current finding and expandable evidence/history.
3. **Workspace space:** investigation and conversation occupy large adjacent
   panels and obscure much of the map. Explore a conversation-linked investigation
   card with expandable or docked details, while keeping live map interaction
   available. This is a design observation, not proof that the current panel
   violates a layout contract.
4. **Progress quality:** visible thinking summaries discuss internal workflow,
   output length and a time budget. The useful progress messages explain the
   two actual errors. Prefer those task-level updates by default, with detailed
   thinking/activity available on demand. Repeated `Ambio · investigation`
   entries should say what happened: hypothesis, run, verdict or conclusion.
5. **Next action:** the finished diagnosis leaves a generic reply box and Ask
   selector. This is the exact opportunity for a scoped “Apply these fixes”
   request that continues into an authorized Build. Current screenshots show
   no such action; this supports the workflow-transition roadmap item.
6. **Live input:** the normal chat composer is visibly disabled while working;
   the investigation has its own “Tell the agent” input. No message was shown
   being sent through either. Record split input surfaces and unavailable chat
   steering, without claiming investigation feedback delivery failed.

### Current verdict and next experiment

**Ask diagnosis: pass on the observed evidence, with presentation friction.**
Autonomous investigation selection is a positive product result to preserve.
Hypothesis quality could improve: the first describes compilation scope rather
than a specific cause, and the second combines both causes. That did not prevent
a precise, bounded conclusion in this run.

At this stage, Session A was not complete: Build and the actual diff/check still
needed verification. The subsequent Build results are recorded below. Record file navigation/replay clicks,
manual mode changes and external-app departures as they occur. Permission
questions, denied actions, active-turn corrections and cancellation remain
not exercised. Claude Code and native chat comparisons remain not run.

## Second observed result: Codex Build and review panel, 2026-10-29

Max supplied three additional screenshots: a Build turn continuing the earlier
Codex session, the finished answer with Ready for review, and the expanded
Review result panel. The user explicitly authorized the two fixes and the
typecheck, required a distinction from device testing, and prohibited commit/push.

### Independently confirmed result

The reviewing session inspected Helios directly and ran its existing check:

- The diff in `mobile/components/AudioStreamView.tsx` changes only
  `setHeadingError(error?.message ?? "Heading error")` to `setHeadingError(error)`.
- The diff in `mobile/hooks/useDeviceSensors.ts` changes only the timer annotation
  from `NodeJS.Timeout | null` to `ReturnType<typeof setTimeout> | null`.
- `npm run typecheck` from `mobile`: exit 0, no compiler diagnostics.
- `git diff --check -- mobile/components/AudioStreamView.tsx mobile/hooks/useDeviceSensors.ts`:
  exit 0.
- Helios HEAD remains `c90db0d`. Modified-file count rose from six to eight,
  with the same 329 tracked deletions; this is consistent with the two expected
  source edits in the existing dirty checkout. A push was not independently
  checked; the agent reports none. The reviewing session performed no Git writes.

These checks confirm the current on-disk result. They do not constitute a new
Ambio-managed verification receipt, confirm native device behavior or prove all
pre-existing dirty content remained byte-identical. The original investigation's
historical state should not silently become verified by this separate check.

### What worked

- The UI reports that Codex continued its earlier session. The response follows
  the diagnosed scope without asking Max to restate the analysis.
- The agent recorded a work session, applied the two localized changes and
  submitted for review. No new sheet was needed for these internal edits.
- The expanded review lists both actual indexed file updates linked to this
  order, separately from the agent's claimed changed files/checks. This is useful
  attribution and evidence separation.
- The response clearly states that compiler checks passed and device checks were
  not performed. The timer change has no runtime code effect; the compass fix
  uses the error string supplied by the callback.
- Ready for review remains separate from accepted. Accept result and Request
  changes are visible; no acceptance or revision was shown in these screenshots.

### Remaining product gaps

- **Review the code itself:** the expanded panel lists file paths, events and
  reported commands, but no inline hunks. `WorkOrderReview.tsx` confirms the
  displayed report consists of metadata/text lists rather than a code diff.
  For a two-line task, the changes and before/after check results should be
  immediately inspectable before accepting. Reuse `agent-workspace-review`.
- **Evidence remains agent-supplied in the app:** its label is honest. Add
  reproducible command receipts bound to the checkout/source state through
  `verify-beyond-structure`; do not relabel text reports as trusted verification.
- **Canvas context is ambiguous:** screenshots center `AudioStreamTest.tsx`
  and show `useWebSocket.ts`, while the linked changes are in two other files.
  The screenshots do not establish whether Max selected that view or the app
  moved it. Measure whether actual changed targets are easy to reach; do not
  diagnose incorrect automatic focus or attribution from these still images.
- **Repeated summaries:** the answer, work-session summary and agent report
  repeat similar information. Lead with the diff and verification status; keep
  attribution/history and full logs expandable without losing access.

**Build correctness and compiler verification: pass for this scoped task.**
**Review presentation: present, with friction; acceptance not exercised.**
Next, Max can inspect/accept this bounded result, reopen Ambio and ask what was
changed, which check passed and which device checks remain. A successful recall
would finish the basic continuity path. Request-changes/revision, active input,
Stop/recovery and other engine routes still need separate observations.

## Third observed result: follow-up recall, 2026-10-29

Max supplied a screenshot of the Ask follow-up, “What did we change, which
checks passed, and what still needs device testing?” The answer correctly:

- Recalls both files and their exact changes, including the timer return type.
- Describes the typecheck and scoped whitespace check as having passed during
  implementation, without implying that this summary reran them.
- Retains the distinction between compiler verification and native runtime
  behavior: compass failure display, sensor stop on disconnect/unmount and
  reconnection without duplicate timers still need device checks.
- Reports no further source/architecture changes or commit/push for the summary.

**Follow-up recall: pass on the screenshot evidence.** No context needed to be
pasted back into this follow-up prompt. The supplied image does not show the
preceding app lifecycle, so persistence across restart remains unconfirmed rather
than failed. Acceptance and a request-changes/revision loop were not shown.
This is one successful small-task sequence, not qualification of all coding
capabilities or engine routes. Remaining presentation priorities are natural
workflow transitions, inline diffs, inspectable check evidence and concise
investigation/progress views.

## Fourth observed result: Offline Scene Replay proposal, 2026-10-29

Max supplied four screenshots of the Propose run, answer, open sheet and nested
planned nodes. The agent reports reusing Reflex Collision Heuristics directly,
placing a new Offline Scene Replay Tool inside it, with a CLI, synthetic scenes
and verification. It explicitly excludes navigation/Gemini behavior changes,
describes offline checks and says no project files changed. Eight baseline
checks are agent-reported; they were not independently rerun in this review.

The open sheet shows four pending additions and four relationships, matching
the apparent scope of one small capability. Max has not verified the saved
sheet contents or approved its scope. The reviewing connector is bound to Ambio
and returned no sheets; no Helios approval, comparison or plan verification was
performed by this reviewing session.

**Propose sheet creation: observed pass. Plan correctness and approval: pending.**
The baseline now exposes a significant usability issue: graph-level granularity
becomes eight flat approval rows for one coherent change. A detail view also
shows bulky empty symbol/member editors on planned artifacts, while Max reports
node containment problems. The overview includes broad existing project context
without making the small new proposal immediately apparent.

Reviewing `SheetProposalReview.tsx` confirms the flat concatenation/count of
nodes and relationships. Planned files share `FileNode` presentation, including
empty symbols and member controls. No actual containment root cause was proven;
faithful geometry reproduction is required before implementing a fix.

Recommended next work is [grouped plan review](../PLAN_REVIEW_DESIGN.md),
preserving individual durable decisions with expandable exact scope, plus a
separate containment reproduction/fix and quieter planned-node presentation.
This changes the roadmap priority: establish a usable review surface before
expanding agent workflow automation. Do not treat a grouped preview, the agent's
explanation or this assessment as approval to implement Helios's pending plan.
