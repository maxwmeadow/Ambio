# Project chrome cleanup — October 20, 2026

Scope: the approved removal of passive top/bottom project-page chrome, with
useful actions retained in menus and contextual notices. Local working tree on
`codex/canvas-performance`; earlier chat/sheet changes are also present.

## Result

- Removed the permanent indexing label, technical connection readout, graph
  counts and status footer. Canvas and chat use the reclaimed space.
- Kept selection, Review Changes, the sheet name, Search, Fit and Message
  Agent visible. Tools opens recording and saved investigations; active
  recording still has a visible stop/save control. Logs remain in menus.
  The redundant Floor label and its reserved space are removed from the toolbar;
  the left rail identifies the Floor.
- Long reads show progress and Stop; quick reads remain quiet. Connection
  failures offer recovery, without showing internal service terminology.
- Unfinished drafts use the same ranked notice lane, can be dismissed/reopened
  from Agent, and can be discarded. Review Changes remains recoverable after
  dismissal. The legacy guide is opt-in from Help.

## Automated checks

- `npx tsc --noEmit`: passed.
- `npm run test:renderer`: 678 passed, 1 skipped. Includes menu reachability on
  Windows/macOS/Linux, interruption ordering and opt-in onboarding persistence.
- `npm run build`: passed.
- 11 focused Electron/Playwright checks passed: saved investigations and replay;
  deferred Review Changes recovery and actions; quiet chrome and chat bottom
  alignment at 1400 × 900 and 900 × 600; long reads/Stop/completion; short reads;
  recording start/stop; lost connections/recovery; brief connection gaps;
  failed Stop recovery; draft dismissal/reopening; and old-draft discard.
- After the final retry-action/copy changes, the three affected chrome,
  failed-Stop and old-draft checks passed again.
- `git diff --check`: passed.

The long-read test exposed a delayed startup warning appearing after connection
recovery. The callback now rechecks the current workspace, connection and native
recovery state before raising a warning. Brief-gap coverage verifies recovery
does not leave a stale warning.

## Computer-use walkthrough

Used the Windows computer-use skill with the built Electron app and actual
Kohler workspace. Confirmed quiet top/bottom chrome, Tools menu placement,
saved-investigation empty-state guidance, Escape dismissal, Help → Setup Guide
opening/hiding, and chat reaching the bottom edge. Increased the saved-view
heading and guidance size/contrast after visual inspection.

Failure/progress injection, recording APIs, replay and draft discard were
tested against isolated fixtures. The live walkthrough did not interrupt the
real daemon or discard real architecture drafts. Native macOS menu rendering
was not visually tested. The tutorial content/layout is still the legacy guide;
its full replacement remains WORK.md `tutorial-overhaul`.

The user stopped computer use with Escape during the final post-restart visual
check. That last visual check was not completed; the earlier walkthrough and
automated checks above were completed.
