# Security

## Reporting a vulnerability

Please report security issues **privately** through GitHub's
[private vulnerability reporting](https://github.com/maxwmeadow/Ambio/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it,
and the Ambio version ("Copy diagnostics" at the bottom of the Ambio launcher gives you all of it).

You will get an acknowledgement as soon as possible. Fixes for confirmed
issues ship in a patch release, and you will be credited unless you prefer not
to be.

## Scope

Ambio runs a local background service (`archd`) on loopback ports and exposes
an MCP server to coding agents. Of particular interest:

- anything reachable from outside the machine,
- bypassing the local API token that guards `archd`,
- a malicious repository or agent causing Ambio to read or write outside the
  project it was given,
- the agent installers writing anything other than Ambio's own entries into
  agent configuration files.

## Security model

What Ambio relies on, so reports can say which assumption they break:

- **Local only.** archd listens on 127.0.0.1. Requests must carry the local
  API token (`~/.ambio/data/api-token`, readable only by your account) and
  be addressed to a loopback host name, which also stops DNS rebinding.
- **Renderer isolation.** The window runs sandboxed with context isolation
  and no Node integration, under a Content Security Policy that allows only
  Ambio's own scripts and loopback connections. It cannot open other
  windows, navigate away, embed web views or request device permissions;
  links open in your browser, and only http(s) links do.
- **Narrow bridge.** The main process only opens, reveals or lists files
  inside projects you have added. Source files open in your code editor and
  are never handed to the system's default handler, which can execute them.
- **Agents.** The MCP server runs as a child of your agent and talks to archd
  with the same token.
- **Known boundary.** The runtime-adapter port (default 7745) accepts
  connections from local processes without the token; it receives trace
  events from programs Ambio runs for investigations. Treat other local
  users and malware on the machine as outside this model.
