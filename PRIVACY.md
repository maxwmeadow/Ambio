# Privacy

Ambio is local-first. Indexing, project maps and history stay on your machine.
When you choose to send a conversation to an AI provider, that agent can send
the conversation and project context it reads to the provider.

## What stays on your machine

- **Your source code.** Ambio indexes it locally to build the map. An agent you
  ask to work on the project can send code and context to its provider.
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

If you connect ChatGPT in Settings → Agents, Ambio opens OpenAI's sign-in in
your browser and stores the connection in OS-encrypted local storage under
`~/.ambio/chatgpt`. Tokens never enter the renderer, project maps or diagnostics.
Model discovery contacts OpenAI. Sending a turn to ChatGPT starts a local
Codex harness that sends the conversation and the project context it reads to
OpenAI's public Responses API using your approved ChatGPT plan. Requests use
`store: false`; this does not mean OpenAI receives no data or has no processing
policy. OpenAI's terms, privacy policy and your plan controls govern that use.
The local harness also keeps conversation history in its account-specific
folder under `~/.ambio/chatgpt/harness`.

Sign out stops Ambio-launched ChatGPT runs, clears that registration's local
tokens and attempts remote revocation. It retains the registration and local
history. If revocation cannot be confirmed, Ambio tells you to disconnect it
in ChatGPT Settings. Manage usage opens ChatGPT's usage controls. Details:
[ChatGPT plan connection](docs/CHATGPT_PLAN.md).

## If this changes

Should Ambio ever offer crash reporting, it will be off unless you turn it on,
it will never include code, file names, paths or project names, and this page
will list exactly what is sent before the option ships.
