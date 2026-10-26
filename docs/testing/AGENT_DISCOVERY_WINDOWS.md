# Agent discovery investigation — Windows, 2026-10-23

Max reported Codex/ChatGPT and Copilot missing from project setup on this
desktop, although they appear on the laptop. The original findings below
describe the pre-fix behavior. Max subsequently confirmed that this desktop
has no standalone Codex or Copilot CLI; an extension's private executable is
not evidence of a separately installed CLI. The laptop was not inspected.

## Implemented correction

- A shared catalog keeps all seven terminal clients and eleven app routes
  listed in setup, Settings and the delivery picker. Missing clients remain
  visible with their status and next action. GitHub Copilot retains its product
  name in the VS Code row.
- Codex and Claude IDE/desktop routes have separate installation evidence and
  reuse the canonical installer's configuration. They remain available to
  connect independently of whether a standalone CLI is installed.
- Private Codex extension/desktop PATH entries are excluded from automatic
  standalone detection. Known standalone/native/npm search paths remain
  supported. No attempt is made to harvest other apps' credentials.
- Selecting a missing CLI offers Locate. Successful selections are remembered
  across restarts and used by actual launch. Native files and installed npm
  entries are supported; npm shortcuts are resolved without running shell or
  installer scripts. An explicit, bounded version probe checks client identity
  where supported. Locating an ACP server records its expected executable
  without starting an interactive protocol session.
- Found and manually selected paths are visible and selectable as text. Deleted
  or inaccessible saved executables produce an actionable error; they do not
  silently switch to a different installation. Users can change a location or
  restore automatic discovery.
- Rescan refreshes app, CLI and provider sources. Bounded requests and generation
  guards expose failures and prevent older responses from replacing newer
  results. An unreadable scan keeps the client catalog visible.

ChatGPT sign-in wording and connection redesign remain separate work, as Max
requested. Finding a CLI or passing its version probe does not verify account
authentication or a successful model request.

The automated UI fixture verifies all-client visibility, a missing standalone
CLI alongside a detected extension, canonical installation from the extension
route, executable selection, actual delivery through the selected path,
restart persistence, deletion, override clearing, installation followed by
Rescan, a rejected scan, and out-of-order scan completion. Settings layout and
ordinary delivery tests exercise the larger catalog too. All profiles, accounts
and projects used by these UI fixtures are disposable and isolated.

Final verification on Windows:

- `npx tsc --noEmit`, `npm run build` and `npm run test:renderer`: passed.
- Discovery, ordinary delivery and Settings Playwright specs: **3 passed**
  together (50.7 seconds). Settings now waits for its initial document before
  querying the shared title bar, avoiding the observed startup attachment race.
- Eight focused discovery regressions passed, covering catalog completeness,
  extension/desktop separation, overrides and stale files, wrong binaries,
  npm shortcuts, corrupt storage, ACP selection, and bounded bridge failures.
- A read-only check using this desktop's real installation paths now reports
  standalone Codex and Copilot unavailable, Claude Code and Antigravity CLI
  available, and the Codex extension/desktop artifacts detected separately.

## Findings

### Codex: session-dependent classification and hidden app routes

Two real Codex executables exist on this desktop:

- `%USERPROFILE%/.vscode/extensions/openai.chatgpt-26.1007.21434-win32-x64/bin/windows-x86_64/codex.exe`
  responds to `--version` with `codex-cli 0.162.0-alpha.17.2`.
- `%LOCALAPPDATA%/OpenAI/Codex/bin/37f54d68e5533a51/codex.exe`
  responds with `codex-cli 0.163.0-alpha.11.2`.

These are observations of this machine, not paths to hard-code. A version
response proves the binary starts; authentication and an actual Ambio turn
were not tested.

`findDeliveryCli` in `electron/agentDelivery.ts` searches PATH, selected
standalone/native locations and npm packages. It does not discover either
of the app/extension-managed locations independently of PATH. The current
coding session injects the extension's binary directory into PATH.

Calling the existing resolver with this session's environment finds Codex.
Removing only its injected OpenAI extension and temporary Codex PATH entries
makes Codex unavailable, while Claude Code and Antigravity CLI remain
available. This reproduces the setup screenshot's runnable-agent list.
It demonstrates launch-environment dependence; the running Ambio process's
environment and the laptop's environment were not captured.

The installer detector independently reports Codex present because `.codex`
exists. `ChooseAgent.tsx` excludes every `modality === 'cli'` host from the
other-app list, while `useRunnableChoices` in `MapWithAgent.tsx` excludes
every unavailable CLI. Thus Codex disappears entirely, including its shared
IDE and desktop connection routes, when executable discovery fails.

### Copilot: editor identity is obscured; no standalone CLI found

The setup row labeled **VS Code Extension** is GitHub Copilot: installer ID
`copilot`, family label `GitHub Copilot`. Rendering `modalityLabel` alone hides
the product's name.

`findDeliveryCli('copilot-cli')` returns undefined on this machine. No CLI
was found in its searched native/npm locations. The global npm root is
`C:/nvm4w/nodejs/node_modules`; this directory is already included through
the Node PATH entry, so it is not an omitted npm-prefix case here.

`%APPDATA%/Code/User/globalStorage/github.copilot-chat/copilotCli` contains
`copilot`, `copilot.bat` and `copilot.ps1`. Inspection shows these are
bootstrappers: they find a separate CLI, or prompt to install/update it.
They are not evidence of a ready standalone Copilot CLI and were not executed.
Microsoft documents that VS Code can offer a `copilot` command that installs
the actual CLI on first use:
[Windows setup documentation](https://code.visualstudio.com/docs/setup/windows#_set-up-the-copilot-command).

Copilot CLI is then removed by the same unavailable-CLI filter as Codex.
There is no setup row explaining that installation is needed.

### ChatGPT: this Ambio profile has no connection; setup hides the route

The desktop's normal `%USERPROFILE%/.ambio` directory contains neither
`chat` nor `chatgpt`. No saved native ChatGPT connection is present there.
Ambio's `CONFIG_DIR` is this directory (`electron/main.ts`). Authentication
in the separately installed Codex/ChatGPT app does not create an Ambio
connection; native chat uses `ChatGPTAuth`'s own encrypted account store.

The ChatGPT connection UI already exists in Settings → Agents and offers
**Continue with ChatGPT**. However, first-run setup only offers **Ambio chat /
Needs your API key**, and its explanation mentions API-key services only.
Even connected ChatGPT profiles are labeled **Your API key** in setup.
Existing WORK item `chatgpt-setup-label` already records part of this problem.

### Refresh and failure handling make discovery harder to recover

- `ConnectAgentScreen.tsx`'s Rescan reloads installer hosts only.
  `useRunnableChoices` reloads on mount and `CHAT_PROVIDERS_CHANGED`, not Rescan.
  Installing or locating a CLI and pressing Rescan does not reload that list.
- `useRunnableChoices` converts rejected delivery/provider requests into empty
  arrays. Users cannot distinguish a scan failure from an absent installation
  or an unconfigured model service.
- `ChatProviders.list()` suppresses a ChatGPT storage/state exception while
  preserving API-key services. This isolation is useful, but the caller gets
  no indication that ChatGPT could not be inspected. Profiles without a model
  are also omitted. Neither case should silently erase the connection route.
- Runnable choices share one Promise.all: a pending request can hold both
  sections in loading. The hook has no request-generation guard against an
  older refresh replacing newer results.

## Durable implementation direction

1. Keep a stable catalog of supported agents and their connection routes.
   Display unavailable entries with their reason and a useful next action.
   Keep product names visible: GitHub Copilot in VS Code, Codex CLI,
   Codex IDE/desktop, and ChatGPT through Ambio chat.
2. Resolve executable candidates through one provider-aware discovery service
   shared by setup, Settings and actual launch. Preserve native/npm support,
   add deliberate supported installation sources and an explicit executable
   override. Treat versioned app-managed binaries as candidates requiring
   compatibility checks, not guaranteed standalone integrations. Do not select
   opaque hash directories by lexicographic order or execute installer shims
   during discovery.
3. Track connection/configuration, executable availability, compatibility,
   authentication and probe errors separately. A config folder or a successful
   `--version` is not sufficient to claim an agent is ready to run.
4. Make Rescan refresh all relevant sources with bounded asynchronous work,
   independent partial results and protection against stale responses. Carry
   errors to the UI with retry/reconnect/locate actions.
5. Offer **Continue with ChatGPT** and API-key setup explicitly. Preserve the
   existing explicit consent and OS-encrypted credentials; do not import other
   apps' tokens to compensate for a discovery issue.

Acceptance should cover clean and installed machines; sparse versus terminal
PATH; native/npm/editor/desktop installs; missing, outdated and inaccessible
binaries; first-run bootstrap scripts; locked ChatGPT storage and missing
models; delayed/failed/out-of-order discovery; installation followed by Rescan;
and CLI-unavailable but IDE/desktop-present configurations. Test Windows,
macOS and Linux, including a packaged app launched outside a terminal.

## Validation performed

- Read-only resolver calls reproduced the Codex PATH dependence and missing
  Copilot CLI result on the desktop.
- Both located Codex binaries passed local `--version` probes. No model
  request, sign-in, installation or account modification was performed.
- Existing delivery and installer tests: **19 passed**. The restricted run
  could not complete Windows child-process termination; rerunning outside the
  filesystem sandbox passed. These tests do not cover the discovery/visibility
  cases above, so their success does not establish production readiness.

The original investigation made no production changes; the implementation
above follows Max's subsequent request. Packaged macOS/Linux and unusual
installer locations still require release validation; successful Windows
fixtures do not establish universal installation or authentication coverage.
