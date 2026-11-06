# Agent transport assessment

Research for Max, 2026-11-04. The initial audit below describes the pre-upgrade
implementation. Max subsequently approved joint Antigravity routing and shared
ACP improvements, with Codex and Claude unchanged on this branch.

Signed-in `agy acp` 1.5.0 discovery has now confirmed Gemini-only access for
Ambio: three Gemini variants versus six CLI models, including Claude/GPT-OSS.
The implementation combines the catalogs, routes new conversations by offered
model, pins existing conversations, modernizes the explicit route to `agy acp`,
and adds model/thinking controls, permission cards, steering and tool/diff detail.
Default without a selected model and old CLI conversations retain print.
Live small no-tool prompts verified model/thinking configuration, steering and
resume. They exposed and fixed agy's early completion of the original request
while a steered replacement still runs. A harmless stand-in MCP tool also verified native per-session environment
forwarding. Full authenticated Ambio-tool coding journeys remain distinct from
these smoke checks.

Validation: `npx tsc --noEmit`, `npm run build`, the unit suite (929 passed,
7 skipped before the final additional discovery test), 11 targeted Antigravity
tests, and all four chat harness checks pass. The Electron Antigravity journey
covers approval/reload, thinking configuration, steered completion, blocking a
cross-route model change without a new work order, and a separate print-model
conversation. Inbox and client discovery Electron tests also pass. The full
MCP run has 47 passes, two skips and two already-tracked Windows EBUSY cleanup
failures (branches and investigation teardown). The legacy delivery UI journey
passes its agent checks, then fails its pre-existing retired-width-key assertion;
WORK.md records the remaining test maintenance.

## Recommendation

- Use native `agy acp` for models its signed-in catalog offers in a new
  Antigravity conversation, and print for other models. Retain print for old
  conversations and an unspecified default. Pin transport per conversation;
  never silently retry a potentially executed turn through another transport.
- For Codex, evaluate `codex-acp` against the improved shared client before
  investing in a direct App Server adapter. Native App Server remains available
  if a required capability is missing. No Codex transport change is part of
  this implementation.
- For Claude, retain the native route. Persistent native input is a separate
  follow-up; confirm supported authentication/account access before changing
  the integration. ACP is useful reuse, not a requirement for streaming,
  approvals, images or interruption.

## What Ambio actually does

`electron/agentDrivers.ts` currently starts Claude with `claude -p
--output-format stream-json`, and Codex with `codex exec --json`. Both resume
native sessions, inject workspace-bound Ambio MCP configuration, parse activity
and support Stop through the runner. They are not raw terminal scraping.

Antigravity CLI starts `agy -p --output-format stream-json`, selects a model
with `--model`, resumes with `--conversation`, and passes
`--dangerously-skip-permissions`. Its Ambio MCP connection comes from installed
configuration, guarded by `RUN_NEEDS_INSTALL`. (A separate `antigravity-acp`
client for the older `agy_acp_server` / `.par` executable existed then; it was
retired on 2026-11-05 once agy 1.5 served ACP itself, and Antigravity CLI now
uses that connection for the models it offers.)

The initial conversation-driver commit (`2ad6a95`) already used this division:
native drivers for Claude/Codex and ACP for agents exposing it directly.
DECISIONS records ACP as a driver for hosts that speak it (2026-10-13).
No explicit decision rejecting the Claude/Codex ACP adapters was found.
The October 29 [workspace roadmap](../AGENT_WORKSPACE_ROADMAP.md) already
proposes Codex App Server and a persistent Claude integration; these remain
open work, rather than an implemented native-versus-ACP comparison.

## Antigravity: benefits of native ACP

| Benefit | Practical consequence and limit |
| --- | --- |
| Official interactive transport | `agy acp` is shipped by Google in CLI 1.5.0; no third-party adapter is needed. It reuses CLI credentials/settings. |
| Structured interaction | Replies, tools, diffs, permissions and questions can arrive through a documented protocol instead of vendor print-event parsing. Ambio must retain/render the richer data. |
| Permission requests | The agent can pause for a response instead of print mode needing broad permission bypass. Ambio must implement user-facing approval policy; its current ACP client auto-answers. |
| Active-turn steering | Google documents another prompt during a running turn as steering. Ambio needs an input path and delivery acknowledgement before this is usable. |
| Attachments | Images and embedded resources are supported upstream. Shared Ambio delivery types/composer currently send text, so changing the transport alone adds no attachment UI. |
| Session operations | Load/resume/list/close and extra workspace directories are available. Print mode already resumes conversations; ACP improves control rather than introducing memory for the first time. |
| Model and thinking controls | ACP exposes configuration options. Ambio must implement those options to preserve model selection and add thinking controls. |
| Session MCP configuration | Ambio already sends per-session MCP servers over ACP. If qualified with `agy acp`, this could remove the CLI's dependency on modifying app configuration. Keep the existing install prerequisite until verified and the recorded decision is revisited. |
| Shared implementation | Existing ACP process lifecycle, cancellation and event handling can be reused. Vendor differences still require tests. |

## Antigravity: costs and possible regressions

1. **Model access is the largest potential regression.** Google's current ACP
   guide says Gemini is available to every client, but third-party models are
   offered only to specified editors (JetBrains, Android Studio/Performance
   Analyzer, Zed and Xcode). Ambio is a custom client. Locally, `agy models`
   lists Gemini 3.8 Flash at three thinking levels, Claude Sonnet 4.6, Claude
   Opus 4.6 Thinking and GPT-OSS 120B. Thus a forced switch could remove useful
   choices. The signed-in ACP check subsequently confirmed the three-model
   difference on this account; hybrid routing preserves the others. Do not spoof an editor's
   identity to obtain entitlements. T3's provider documentation describing its
   runtime/account models does not establish identical access for Ambio.
2. **A command change is insufficient.** `AcpTurn` carries no selected model;
   the client handles legacy modes but not `configOptions`, rich diffs, usage,
   questions, commands or child sessions. Ask/Propose protection also cannot
   rely solely on callbacks when agent settings already allow an action.
3. **Permissions need real integration.** Current ACP Build auto-allows offered
   actions, and other modes reject tool kinds `edit`, `delete` and `move` while
   allowing others. It does not display each ACP permission request at the
   human permission desk. ACP capability alone is not stronger enforcement.
4. **Compatibility and continuity need testing.** Old `agy` versions lack the
   command; old print conversations may not resume identically under ACP.
   Authentication errors and unsupported configurations must not trigger a
   silent second execution through print mode.
5. **Client work remains.** The composer is disabled during ordinary active
   turns; activity stores four kinds of clipped text. Without changing those
   layers, much of ACP's richer experience is invisible.
6. **No demonstrated model-quality, price or speed gain.** This changes the
   integration surface. Account limits and offered models remain vendor-owned;
   no comparative performance or billing measurement was performed.

Google sources: [CLI 1.5.0 release](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.0),
[CLI ACP overview](https://antigravity.google/docs/cli/acp/),
[full integration guide, including model restrictions](https://antigravity.google/docs/ide/extensions/acp/).
T3 source: [Antigravity provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-antigravity.md).

## Codex: direct App Server versus ACP

The current `codex-acp` adapter launches Codex App Server and translates its
requests/events. Both routes reach the Codex harness; ACP does not replace it
with a generic model/tool loop. The adapter supports ChatGPT/API authentication,
models/effort, permissions, images, MCP, review and other rich events.

ACP's advantage is shared translation and recovery maintained upstream, with
one client contract usable for several agents. It can be a faster path to a
capable integration than implementing every vendor protocol ourselves.

Direct App Server avoids an extra adapter/version boundary and exposes Codex's
native thread/turn identities, explicit `turn/steer` targeting, review, model
catalogs, usage, commands and evolving tools/features. OpenAI explicitly
recommends App Server when the agent is part of an application's product UI.
The cost is owning Codex-specific protocol mapping, recovery and version checks.

ACP is not necessarily a lowest-common-denominator interface: this adapter
exposes rich extensions. However, steering is currently a pre-standard
`_session/steering` extension, and several advanced behaviors require capability
negotiation or AIR extensions. They would not become available merely by
connecting Ambio's existing minimal client. The adapter also explicitly disables
the bundled Visualize skill because generic ACP clients cannot render its
OpenAI-specific result. Direct App Server would still require Ambio rendering
work; it does not provide the OpenAI desktop UI automatically.

The adapter packages a compatible Codex dependency and permits a `CODEX_PATH`
override. Consequently it can run a different version from the standalone CLI
Ambio currently discovers; account/config/version identity must remain explicit.

Sources: [official App Server documentation](https://learn.chatgpt.com/docs/app-server),
[OpenAI integration guidance](https://developers.openai.com/blog/codex-as-a-platform),
[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp),
[steering extension](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/steering.md),
[adapter developer notes and unsupported skills](https://github.com/agentclientprotocol/codex-acp/blob/main/readme-dev.md).

## Claude: persistent native streaming versus ACP

`claude-agent-acp` uses Anthropic's Agent SDK, which operates Claude Code.
It advertises images, MCP, permissions, edit review, subagent transcripts,
interactive/background terminals and other rich interactions. Like Codex ACP,
this is a translation layer over the vendor agent, not just the Claude API.
Its releases include a Claude executable, with `CLAUDE_CODE_EXECUTABLE` available
to select a different one. Version alignment and native settings must be tested.

ACP would reuse upstream SDK/event handling and shared Ambio client work.
Direct CLI/SDK integration avoids the ACP translation layer and gives Ambio
direct control over vendor events, tool policy, hooks, settings and session
lifecycle. Neither route guarantees complete CLI UI parity.

The current native driver only reads completed assistant blocks and deliberately
filters child-agent messages. Anthropic documents partial streaming and
persistent input, so these are Ambio implementation gaps, not evidence that
Claude needs ACP to become interactive.

**Account access needs a precise answer.** Anthropic's SDK overview says
third-party products may not offer claude.ai login/rate limits without prior
approval and directs developers to API authentication. The ACP adapter includes
subscription-related handling, but that is not evidence that Ambio has approval.
Nor does staying on a `claude -p` subprocess by itself establish an exception:
Anthropic's headless guide describes that path as SDK via CLI. Determine the
supported product/account arrangement before any subscription-dependent migration;
this question should not be misrepresented as a limitation of ACP itself.

Sources: [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp),
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
[programmatic CLI](https://code.claude.com/docs/en/headless),
[streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

## Evidence and release gates

Local read-only checks: `agy --version` (1.5.0), `agy acp --help`, and an ACP
`initialize` using Ambio's current advertised capabilities. The server returned
protocol v1, Antigravity ACP Server 1.5.0, image/embedded-context support,
session operations and authentication methods. The probe was terminated without
creating a session or sending a task. `agy models` returned the model list above.
Standalone `codex --version` reports 0.162.1 and exposes App Server; `claude
--version` reports 2.1.198. Neither ACP adapter was installed or run.

Before a default change, run the same isolated Ask/Propose/Build journey through
both transports: real model/account discovery; Ambio MCP workspace/request
identity; files/commands and permission denials; text/images; tool outputs/diffs;
human questions; steering acknowledgement; Stop including child/background work;
follow-up/restart/resume; authentication/quota failures; and crash/no-duplicate
recovery. Preserve raw evidence and distinguish vendor support from client UI
support. Reuse `agent-permission-modes`, `agent-run-event-contract`,
`codex-interactive-adapter`, `claude-interactive-adapter` and
`antigravity-cli-native-acp` in WORK.md.
