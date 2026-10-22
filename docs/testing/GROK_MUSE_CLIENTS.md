# Grok Build and Muse Code MCP client checks

2026-10-22. Installer support is implemented; authenticated vendor CLI trials
remain to be recorded. These clients use their own accounts and coding
harnesses. This does not enable their subscriptions in native Ambio chat.

## Automated coverage

- `electron/grokMuseClients.test.mjs`: Windows/macOS/Linux path layouts,
  preservation of unrelated settings, repeat install, workflow repair,
  removal, custom config paths, malformed Muse server maps and shared rules.
  Muse preserves whichever existing project instruction file it reads.
- `mcp/e2e/grokMuseClients.e2e.mjs`: reads each installer's saved command and
  arguments, starts the actual stdio MCP server against archd, reads the map,
  creates a sheet and pending proposal, claims an exact addressed request,
  replies to it and checks host-attributed live presence. This uses a protocol
  client rather than the vendors' CLIs and requires no model credentials.
- Existing all-host installer, draw-first, uninstall and delivery tests
  include both clients. Delivery stays on the copy-handoff/watch route.
- Review regressions cover Muse → Codex/Grok/Copilot setup followed by both
  removal orders, stale managed blocks in lower-precedence files, explicit
  optional Muse mode, invalid JSON shapes, ancestor Grok configurations, and
  preservation/reporting of shared compatibility files.
- `ChooseAgent.test.mjs` renders the real setup view with deterministic
  discovery: both MCP-only CLIs remain visible and preselected even while
  launch discovery is unavailable. Shared launch capability also keeps
  Settings grouping stable when its discovery call fails.

## Live trial still needed for each vendor

1. Install the official [Grok Build](https://docs.x.ai/build/overview) or
   [Muse Code](https://dev.meta.ai/docs/muse-code) CLI and sign in using the
   vendor's own browser flow. Open the same project in Ambio and the terminal.
2. In **Settings → Agents**, choose the client and **Add Ambio**. Check the
   displayed config and workflow paths, then start a fresh terminal session.
   Muse must trust the project to load project instructions.
3. Check Ambio in Grok's `/mcps` or Muse's `/mcp`. Run `/ambio-map`, review
   the proposed map in Ambio, and confirm it only after review.
4. Send an Ask message to that client from Ambio. Paste the handoff into its
   terminal chat. Confirm the exact request is claimed and its reply appears
   in the right Ambio conversation. Test follow-ups while the chat watches.
5. Ask for a structural proposal. Confirm it draws on a sheet and leaves the
   plan pending before any build. Explicitly authorize a build and check the
   structural comparison and final reply.
6. Test **Repair**, **Test**, and **Disconnect**. Other MCP servers and authored
   instructions must survive. Record OS, CLI version, selected model and plan,
   path overrides, observed tool calls and any prompts or errors; omit tokens.

Direct launch, resume, event translation and permission modes from Ambio need
separate conversation drivers. Until then, start `grok` or `muse` yourself.

## Recorded automated results

- TypeScript check and production build passed.
- Unit suite after PR #10 review fixes: 737 passed, 14 skipped, zero failures.
- Both new installed-launcher MCP round trips passed.
- Full MCP suite: 39 passed, six skipped, two unrelated failures. The Go
  investigation selected an executable reporting `Go: Unknown option: run`;
  `proposalPlacement.e2e.mjs:94` hit the clustering race already tracked as
  `proposal-placement-e2e-race` in WORK.md. Neither runtime nor proposal logic
  was changed for the client integrations.
