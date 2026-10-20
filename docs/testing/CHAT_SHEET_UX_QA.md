# Chat and sheet UX check — 2026-10-20

Windows computer-use walkthrough of the actual Kohler workspace, first in the
development app and then the production renderer built with `npm run build`.
The app window was 1406 × 906; the chat panel was also checked at its minimum
width and at approximately 700 px. Existing proposals were inspected without
confirming or rejecting them. Only a clearly named disposable QA chat was sent
to the real Codex CLI and deleted.

## Observed behavior

| Check | Result |
| --- | --- |
| Send an Ask and follow up in the same conversation | Both actual replies arrived; the second explained dependencies in two plain sentences without backend identifiers. |
| Reply arrives while the panel is closed | Attention rose by one, then fell by one when that conversation was opened and read. |
| Rename, save, cancel, and reopen | Title updates worked; cancel retained the saved title. |
| Full production-app restart | Saved title, messages, and read state survived. Development and production have separate renderer storage origins. |
| Delete confirmation and Keep conversation | Cancel preserved the conversation and its messages. |
| Delete disposable conversation | It disappeared from the list and its transcript cleared; it remained absent after another full restart. The existing sheet remained. |
| Historical reply rendering | The sheet identifier was hidden and `DEPENDS_ON` read as “uses.” Architecture references became working buttons after the fix below. |
| Open the original sheet from its reply | The sheet opened successfully. |
| Select Formula Skill Runtime’s move | Its one-file frame fit the file rather than retaining the previous empty area. The move’s original and proposed parents appeared in the rail. |
| Select a relationship review row | Both systems were framed, with their relationship described in plain language. |
| Show All Sheet Relationships | The broader set appeared; returning through the Floor reset the toggle. Deselecting cleared the focused relationship. |

## Issues found and fixed

- Pale inherited text in the rename input, action trigger, and deletion prompt.
- Dates competing with titles in narrow conversation lists. Dates and attention
  now occupy a quiet second row below the title.
- Neighboring row action buttons drawing over an open action menu. Only one
  action menu now opens at a time and it draws above adjacent rows.
- Architecture links rendering as plain text in the running app. Artifact
  targets now use explicit custom-scheme parsing, verified by opening the sheet.
- Proposed relationship lines becoming too faint at overview zoom. Their line
  weight now stays constant on screen and arrows remain visible.
- Deleting the implicitly selected latest conversation briefly selecting the
  next chat and clearing its unread state. Selection is pinned before the
  deletion request; an isolated regression exercises this race.

## Limits and follow-up

The live sends used Codex CLI. Native model services and Windows notification
toast click-through were not exercised in this walkthrough. Existing
architecture proposals were not accepted or rejected as part of QA.

Zoomed file cards also showed “No symbols” for known source files. This is
recorded separately as `file-symbol-detail-empty-live` in WORK.md; it was not
silently treated as passing or expanded into an unrelated loader change.

Final checks passed: `npx tsc --noEmit`, `npm run build`, 13 focused unit tests,
and the isolated conversation UI regression covering rename/read persistence,
notification targeting, active deletion protection, and deletion without
consuming the next unread reply.

## Pre-commit validation — October 20

Revalidated the complete chat/sheet and project-chrome cleanup together before
committing on `codex/canvas-performance`:

- TypeScript and app build passed.
- Full renderer/shared/Electron/MCP unit suite: 678 passed, 1 skipped.
- `go vet ./...` and `go test ./...`: passed across all daemon packages.
- MCP end-to-end suite: all 35 passed.
- Bundled chat harness suite: both tests passed, including transcript deletion
  across restart and the controlled model/MCP multi-turn workflow.
- Focused Electron UI checks: all 21 passed (19 canvas/project-page scenarios
  plus the native-chat and conversation-clarity scenarios). Includes sheet
  relationship framing and approval, compact moves, large-sheet measurement
  retention, formatted replies, chat persistence and notification targeting,
  and the contextual progress/recovery/menu flows documented in
  [PROJECT_CHROME_UX_QA.md](PROJECT_CHROME_UX_QA.md).
- `git diff --check`: passed.

These are automated fixture checks alongside the earlier real-app walkthrough;
the live-testing limits above still apply.
