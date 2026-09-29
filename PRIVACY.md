# Privacy

Axiom is local-first. Your code, your project maps and everything Axiom learns
about them stay on your machine.

## What stays on your machine

- **Your source code.** Axiom reads it to build the map. It never uploads it.
- **Project maps and history:** systems, layout, sheets, the change journal
  and agent activity, stored under `~/.axiom/data`.
- **Settings and the project list:** `~/.axiom`.
- **Logs:** `~/.axiom/logs`, rotated automatically and capped at a few
  megabytes. They exist so you can look at them or choose to share them.

## What leaves your machine

- **Update checks.** Axiom periodically asks GitHub Releases whether a newer
  version exists. That request carries no information about you, your code or
  your projects beyond what any download from GitHub does (your IP address
  and Axiom's version).
- **Nothing else, unless you choose to send it.** "Report a bug" opens a
  GitHub issue in your browser with your OS and Axiom version filled in;
  you see and edit everything before submitting. "Copy diagnostics" puts a
  report on your clipboard, with your home directory replaced by `~`, for
  you to read and paste wherever you like.

Axiom does not collect usage analytics.

## Your coding agents

When you connect an agent (Claude Code, Cursor, Codex, …), the agent talks to
Axiom over a local connection on your machine. What the agent then sends to
its own provider is governed by that agent's privacy policy, not Axiom's.

## If this changes

Should Axiom ever offer crash reporting, it will be off unless you turn it on,
it will never include code, file names, paths or project names, and this page
will list exactly what is sent before the option ships.
