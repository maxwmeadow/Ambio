# Releasing Axiom

The release workflow (`.github/workflows/release.yml`) builds every platform
from a `v*` tag into one **draft** GitHub Release. Nothing reaches users until
you publish that draft by hand; installed copies are offered the update once
it is published.

## Before the tag

1. **main is green.** The `ci` workflow passes on Linux, macOS and Windows,
   and the `e2e` job passes (Playwright and the MCP end-to-end suite).
2. **CHANGELOG.** Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and
   start a new empty `## [Unreleased]` above it. That section is shown in the
   app as What's New after updating (`releaseNotes` in `electron/main.ts`),
   so read it as a user would: what changed for them, not how.
3. **Version.** Set `"version"` in `package.json` to `X.Y.Z` (and run
   `npm install` so `package-lock.json` agrees). The workflow refuses a tag
   that does not match: the updater compares this version, so a mismatch
   would publish an update nobody is offered.
4. **Schema.** If `db.SchemaVersion` changed since the last release, check
   that `archd-go/internal/db/testdata/schemagen` has a fixture for every
   version left behind, and that the upgrade test passes. Users open their
   maps with the new version; there is no downgrade.
5. **Notices.** `node scripts/third-party-notices.mjs --check` passes (CI runs
   it on Linux). A new dependency must be AGPL-compatible.
6. **Commit** the version and CHANGELOG as `Release X.Y.Z`.

## Tag and build

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow packages linux-x64, macos-arm64, macos-x64 and windows-x64, then
merges the two macOS update manifests into one `latest-mac.yml`. A manual run
(`workflow_dispatch`) builds the same artifacts without publishing, for a dry
run.

## Review the draft

- Every platform's installer is attached, plus `latest.yml`,
  `latest-linux.yml` and a single merged `latest-mac.yml`.
- The release notes are the CHANGELOG section for this version.
- Until signing exists (`mac-signing`, `windows-signing` in WORK.md), the
  notes say how to open an unsigned build on macOS and Windows.

## Smoke test per OS (before publishing)

Install the draft's artifact on each OS you can reach, then:

1. The launcher opens; What's New shows this version's notes.
2. Open a real project: indexing finishes, the Floor draws, a file opens in
   the editor.
3. Connect an agent (Agent → Connect an Agent…), then from the agent call
   `get_architecture` and see it in the agent log.
4. Draw a planned system on a sheet, send it, and see the work order in the
   Agent inbox.
5. Quit and reopen: the project and its layout come back.
6. On a machine with the previous version installed, check that it offers
   this update after the draft is published.

## Publish

Publish the draft. Then:

- Watch Help → Report a Bug issues for a day.
- If something is badly wrong, unpublish (mark as draft again) to stop the
  update being offered; installed copies keep what they have. Fix forward
  with `X.Y.Z+1`; never retag a version that was published.
