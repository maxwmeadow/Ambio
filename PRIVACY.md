# Privacy

Ambio is local-first. Indexing, project maps and architecture history stay on
your machine. Optional integrated chat sends your messages and the project
context its agent reads to the model service you configure.

## What stays on your machine

- **Your source code during indexing.** Ambio reads it locally to build the
  map; indexing does not upload it. Integrated chat has the separate behavior
  described below.
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

## Chat in Ambio

Integrated chat is optional. You choose a model service and supply its API key
(local compatible services can run without one). Your messages, attached
architecture context, and code or command results the coding agent reads are
sent to that service for inference. Its privacy, retention and billing terms
apply. A locally running harness does not make a cloud model offline.

Requests go from this computer to your chosen service through a local
credential proxy. They do not go through an Ambio inference backend. The agent
receives a temporary local token; your real service key stays in Electron's
main process. Keys use the operating system's secure storage when available.
If secure storage is unavailable, the key stays in memory for this app session
and you must enter it again after restarting; Ambio does not save it as plaintext.

Conversations and the harness's local history/cache live under `~/.ambio/chat`.
They may contain source and command output. They are not included in map exports
or automatically shared. Delete all Ambio data also removes this chat data and
saved keys. The bundled harness may fetch supporting packages from npm into its
local cache; automatic conversation sharing and harness updates are disabled.

Ask mode restricts the agent to read-only tools. Build mode can change your
project and uses work orders and interactive action approvals. Stopping a turn
does not undo changes already made.

## If this changes

Should Ambio ever offer crash reporting, it will be off unless you turn it on,
it will never include code, file names, paths or project names, and this page
will list exactly what is sent before the option ships.
