# Security

## Reporting a vulnerability

Please report security issues **privately** through GitHub's
[private vulnerability reporting](https://github.com/maxwmeadow/Axiom/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it,
and the Axiom version ("Copy diagnostics" at the bottom of the Axiom launcher gives you all of it).

You will get an acknowledgement as soon as possible. Fixes for confirmed
issues ship in a patch release, and you will be credited unless you prefer not
to be.

## Scope

Axiom runs a local background service (`archd`) on loopback ports and exposes
an MCP server to coding agents. Of particular interest:

- anything reachable from outside the machine,
- bypassing the local API token that guards `archd`,
- a malicious repository or agent causing Axiom to read or write outside the
  project it was given,
- the agent installers writing anything other than Axiom's own entries into
  agent configuration files.
