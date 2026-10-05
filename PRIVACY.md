# Privacy

Ambio is local-first. Your code, your project maps and everything Ambio learns
about them stay on your machine.

## What stays on your machine

- **Your source code.** Ambio reads it to build the map. It never uploads it.
- **Project maps and history:** systems, layout, sheets, the change journal
  and agent activity, stored under `~/.ambio/data`.
- **Settings and the project list:** `~/.ambio`.
- **Logs:** `~/.ambio/logs`, rotated automatically and capped at a few
  megabytes. They exist so you can look at them or choose to share them.

## What leaves your machine

- **Update checks.** Ambio periodically asks GitHub Releases whether a newer
  version exists. That request carries no information about you, your code or
  your projects beyond what any download from GitHub does (your IP address
  and Ambio's version).
- **Nothing to draw the interface.** Fonts and every other asset ship with
  the app; Ambio loads nothing from the internet to display itself.
- **Nothing else, unless you choose to send it.** "Report a bug" opens a
  GitHub issue in your browser with your OS and Ambio version filled in;
  you see and edit everything before submitting. "Copy diagnostics" puts a
  report on your clipboard, with your home directory replaced by `~`, for
  you to read and paste wherever you like.

Ambio does not collect usage analytics.

## Your coding agents

When you connect an agent (Claude Code, Cursor, Codex, …), the agent talks to
Ambio over a local connection on your machine. What the agent then sends to
its own provider is governed by that agent's privacy policy, not Ambio's.

## If this changes

Should Ambio ever offer crash reporting, it will be off unless you turn it on,
it will never include code, file names, paths or project names, and this page
will list exactly what is sent before the option ships.
