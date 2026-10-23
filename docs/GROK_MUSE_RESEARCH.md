# Grok and Meta Muse connections

Researched 2026-10-22 against the local Ambio code and official vendor docs.
This is a feasibility assessment; no authenticated vendor run was performed.

Implementation update: dedicated local installers, detection, repair, removal
and native workflow skills are now implemented for both clients. Their
launch routes now use Grok ACP and Muse MSP with per-session MCP binding,
models, continuation, activity and Stop. Signed-in vendor trials remain pending. This does not add native subscription auth.

## Recommendation

Use Grok Build and Muse Code as external MCP clients, including Ambio-started
CLI sessions. Offer their ordinary API-key services in native Ambio chat. Do not
advertise direct subscription sign-in for native chat: neither investigation
found a published third-party flow equivalent to Ambio's ChatGPT integration.

| Route | Grok | Meta Muse |
|---|---|---|
| Coding client connects to Ambio | Grok Build supports local stdio MCP | Muse Code supports local stdio MCP |
| Ambio starts the coding client | Implemented; signed-in live validation pending | Implemented; signed-in live validation pending |
| Vendor model in native Ambio chat | Ordinary API key; compatible API | Ordinary Model API key; compatible API |
| Subscription sign-in in native Ambio chat | No public third-party flow found | No public third-party flow found; subscription credentials restricted to the coding harness |
| Vendor web chat calls Ambio | Custom remote MCP connectors available | Connector developer preview; separate from Muse Code |

## What Ambio has today

- `electron/agentInstallers.ts`, `agentRules.ts`, `agentDelivery.ts`,
  `agentDrivers.ts`, `agentModels.ts`, and `src/shared/agentDelivery.ts` contain
  the connection, launch, workflow and model-picker integration points. These
  now include dedicated Grok and Muse MCP installers and launch drivers.
- `mcp/ambio-mcp.ts` uses `StdioServerTransport`. That fits local coding
  clients; it is not a remote HTTP MCP endpoint for a web chat connector.
- `src/shared/agentChat.ts`, `electron/chatProviders.ts`, `agentChat.ts`, and
  `chatProviderProxy.ts` already support custom OpenAI-compatible API-key
  services, encrypted keys and proxied native conversations. Compatibility
  makes both vendors candidates for this path, but does not prove tool calls,
  reasoning history or streaming work end to end.
- ChatGPT is a distinct managed auth type, using independently implemented
  public SIWC registration, consent, refresh and inference contracts. See
  [CHATGPT_PLAN.md](CHATGPT_PLAN.md). Adding a vendor's CLI login is a different
  integration from making its plan power Ambio's own bundled agent.

## Grok

[Grok Build MCP documentation](https://docs.x.ai/build/features/mcp-servers)
documents local stdio servers, `~/.grok/config.toml`, project
`.grok/config.toml`, and compatibility loading of Claude/Cursor MCP configs.
An explicit Ambio entry is preferable to relying on incidental discovery.
The documented command shape is:

```sh
grok mcp add ambio -- <ambio-node-command> <ambio-mcp-entrypoint>
```

Those placeholders must be replaced with the packaged runtime and MCP paths
Ambio already supplies to its other installers. Preserve unrelated config,
install the draw-first workflow, detect the effective server, and remove only
Ambio-owned entries on uninstall.

[CLI reference](https://docs.x.ai/build/cli/reference) documents browser login
and device authentication. [Headless integration](https://docs.x.ai/build/cli/headless-scripting)
provides an automation surface worth evaluating for the conversation driver.
Let Grok own its login and credentials when running its agent. Validate modes,
events, resume, questions, cancellation and model selection before claiming
full integration.

For native chat, use the ordinary xAI API key and base URL
`https://api.x.ai/v1`; start with Ambio's OpenAI-compatible service and discover
available model IDs. The [API reference](https://docs.x.ai/developers/rest-api-reference/inference)
documents Bearer API-key authentication and compatible inference endpoints.
The [Chat Completions reference](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions)
still supports that endpoint but recommends Responses for new integrations.

No public third-party subscription OAuth contract was found. The current
[subscription usage documentation](https://docs.x.ai/x-subscription/usage-limits)
limits the included pool to eligible first-party Grok/Cursor surfaces; it
does not establish entitlement for Ambio's native harness.

Compatibility caveat: Grok may load another client's Ambio MCP configuration,
including its `--ambio-host` identity. That connection can therefore appear
under the originating client. Settings reports shared compatibility files
separately from dedicated setup; removal preserves files owned by other
clients. Disable the relevant compatibility source in Grok to exclude them.

[Grok web connectors](https://docs.x.ai/grok/connectors) support custom MCP
servers with authentication. This would require a reachable remote MCP
transport and a deliberate authenticated bridge to the local project.
Ambio's existing local daemon URL cannot be pasted into a cloud connector.

## Meta Muse

The coding client is **Muse Code**; Muse Spark and Muse Wonder are models.
[Muse Code configuration](https://dev.meta.ai/docs/muse-code/configuration)
documents `~/.config/muse/settings.json`, project `AGENTS.md`, and headless
`muse exec` with JSONL output and prompt files. Verify platform-specific paths
and installed-version behavior before shipping an installer.

[MCP documentation](https://dev.meta.ai/docs/muse-code/extending) uses a JSON
`mcp_servers` block, with `transport: "stdio"`, `command`, `args`, and `env`.
It also supports Streamable HTTP and remote-server OAuth through
`muse mcp login <server>`. That OAuth connects Muse to an external tool; it
does not authorize Ambio to spend a Muse subscription. A required server's
startup failure aborts the run; Ambio explicitly installs `mode: "optional"`
so a moved or removed Ambio app does not prevent unrelated Muse sessions.

[Authentication](https://dev.meta.ai/docs/muse-code/auth) supports browser
sign-in or API keys. For a Muse driver, retain vendor-owned authentication;
test how a stored browser login behaves in headless runs rather than assuming
it works. API keys take precedence over browser sessions.

For native chat, the [Model API overview](https://dev.meta.ai/docs/overview)
documents `https://api.meta.ai/v1`, Bearer API keys and OpenAI/Anthropic
compatibility. Use an ordinary usage-billed Model API key and discover model
availability; validate the complete agent tool loop before labeling supported.

No public third-party subscription sign-in contract was found. More concretely,
[Meta Model API terms §3.2](https://dev.meta.ai/legal/terms-of-service)
restrict coding subscription credentials to the subscribed coding harness.
Do not extract those credentials to power Ambio's bundled OpenCode harness.
This does not prevent integrating Muse Code itself as an external agent.

Both clients may discover Ambio skills from shared user skill directories in
addition to the dedicated native directory. Settings reports existing shared
skill files as potential inherited setup; it cannot establish which sources
a particular running CLI has enabled. Removing dedicated setup preserves
other clients' skills. Deduplication and session identity need signed-in CLI
validation; neither is claimed as solved by the installer.

[Meta AI Connectors](https://dev.meta.ai/products/connectors) is a separate,
limited developer preview for bringing service tools into Meta AI using
API/MCP onboarding and OAuth account linking. It is not evidence that native
Ambio chat can use a Muse subscription, nor a generally available local-client
installation path.

## Implementation order and acceptance

1. Add dedicated local installers, detection, uninstall and draw-first
   instructions for both clients. Prove a real session can read the map,
   propose a sheet and return an addressed reply through MCP.
2. Add API-key setup guidance/presets. Verify model discovery, streaming,
   multi-turn tools, reasoning continuity, credential redaction and errors in
   the bundled native harness with each vendor.
3. Add conversation drivers after checking installed CLI/SDK contracts:
   Ask must remain read-only, Propose must wait for review, Build must follow
   authorization; also cover resume, approval prompts, stop and missing login.
4. Treat remote web connectors as separate work because Ambio currently
   exposes only local stdio MCP. Investigate native plan OAuth again only
   when a vendor publishes or grants a third-party integration contract.

The installer implementation is covered separately by unit and real MCP
protocol tests; no authenticated vendor compatibility is claimed here.


## Launch implementation and evidence (2026-10-22)

Grok uses ACP (`grok agent --no-leader --model … stdio`) with a global sandbox
profile. Official npm `@xai-official/grok` 1.0.67 was installed in a task-only
folder: native help, model catalog and ACP initialization were checked. This
binary advertises `grok.com`; older documented examples advertise
`cached_token` / `xai.api_key`. Ambio selects an offered method and requests
headless authentication, with a timeout and terminal-login recovery. The
workspace has no vendor login; no model turn was claimed as verified. Its
container cannot apply Grok's read-only sandbox; it fails closed.

Muse uses `muse serve` and the published
[Meta Muse Code SDK protocol](https://github.com/meta-models/muse-code-sdk/tree/main/schema/msp)
(v1, SDK snapshot 1.4.12), without adding an SDK dependency. Session construction
accepts per-session MCP overrides and model choice; native start/resume
subscriptions carry item and turn events. Model discovery uses `model/list`
without creating a session. The official Muse installer domain is blocked by
the workspace's network policy, so no native Muse binary was available here.
Protocol fixtures are not evidence of signed-in native compatibility.

The user will run the real account trials locally. Reproducible commands and
remaining acceptance checks are in [testing/GROK_MUSE_CLIENTS.md](testing/GROK_MUSE_CLIENTS.md).
