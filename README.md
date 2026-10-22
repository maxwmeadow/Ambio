<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/renderer/assets/branding/wordmark-reversed.svg" />
  <img src="src/renderer/assets/branding/wordmark.svg" alt="Ambio" width="260" />
</picture>

**Your architecture, shared with your agents - in both directions.**

Coding agents now build faster than anyone can draw a diagram of what they
built, let alone write the UML first and hand it over. So people stop looking
at architecture and review forty-file diffs instead. Ambio is the layer between
you and your agents that keeps you both on the same page:

- **You change the architecture, your agent builds it.** Draw a new system,
  move a responsibility or rule out a dependency, and send it to your agent as
  a work order. Ambio checks what was built against what you drew.
- **Your agent changes the architecture, you see it.** Agents draw what they
  think the system is, what they plan to build and what they changed, on the
  same surface, for you to confirm or correct.
- **The code keeps both of you honest.** The architecture is derived from your
  real code and updates live as you or an agent edit it, so neither of you is
  looking at a picture of how things used to be.

<!-- Hero: a short video of the loop in both directions - draw a sheet, send
     it, watch the agent build it and review it; then an agent draws its plan
     and you confirm it. It goes here, before anything else. -->

> Ambio is in active development and has not had a stable release yet. Expect
> things to change, and please [report what breaks](https://github.com/maxwmeadow/Ambio/issues).

[Install](#install) · [How it works](#how-it-works) · [Your data](#your-data) ·
[Uninstall](#uninstall) · [Development](#development-setup) ·
[Roadmap](WORK.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md) ·
[Privacy](PRIVACY.md)

## What it does

- **Sheets: plans both of you can draw.** A sheet is a proposal laid over the
  live map - new systems, moved files, removed relationships. You draw one and
  send it to an agent as a work order; an agent draws one to show you its plan
  before it writes code. When the work comes back, Ambio compares it with the
  plan: matched, flexed, drifted or missing.
- **Review what changed, as architecture.** Review Changes shows what moved in
  the architecture since you last looked, as statements like "Api now depends
  on Storage", each attributed to you or to an agent, instead of a diff.
- **A live map that is never stale.** Files are grouped into nested systems by
  what they do, not by folder, and the map updates as files change. Agents
  propose how the code is organised; you approve or correct it.
- **Your agents read and write the same model.** Ambio can run Claude Code,
  Codex, Copilot CLI and Antigravity CLI for you, or its own Ambio chat with
  your API key; Copilot in VS Code, Cursor, Claude Desktop, Windsurf,
  Antigravity, JetBrains and Zed connect through MCP. Either way they ask where
  things are and what depends on what, author systems, record infrastructure,
  draw sheets, and pick up work orders.
- **Infrastructure in view.** Databases, queues, caches, external APIs and
  hosting are detected from code and config, with the tables, topics and keys
  your code uses. They sit in a sidebar and draw their connections onto the map
  when selected; what runs your code is shown as frames around it.
- **Branches and worktrees.** The toolbar always shows which branch the map is
  on (`⇧⌘B` opens every checkout). Other checkouts' work is drawn on the
  Floor, a branch's architecture can be reviewed against its base, agents Ambio
  runs can work in a worktree of their own, and two branches changing the same
  system show up before they are merged. Switching branches is not recorded as
  code changes.
- **Debug by running code.** Ask an agent to find the cause of a bug and it
  runs the code with the suspect functions watched - in JavaScript/TypeScript,
  Python, Ruby, Go, Java, Kotlin, Scala, C#, PHP and Rust - and gets back what
  they actually did. A run can start your server first. Each step appears
  beside the map, and you can talk back.
- **Keyboard first.** A command palette (`⇧⌘P` / `Ctrl+Shift+P`) reaches every
  command; `⌘/` / `Ctrl+/` lists the shortcuts.
- **Local.** Architecture, layouts and history live on your computer. There is
  no account, no analytics, and your code is never uploaded - except what Ambio
  chat sends to the model service you choose to set up (see [PRIVACY.md](PRIVACY.md)).

## Install

Download the installer for your platform from the
[latest release](https://github.com/maxwmeadow/Ambio/releases/latest). Ambio is
a single application: it brings its own runtime, so there is nothing else to
install before connecting your coding agent.

Early builds are not yet code-signed, so your operating system will warn you
the first time you open Ambio:

- **macOS** - open the `.dmg`, drag Ambio to Applications and open it. When
  macOS says it cannot verify the developer, open **System Settings → Privacy &
  Security**, scroll to the message about Ambio and choose **Open Anyway**.
- **Windows** - run the installer. If SmartScreen shows "Windows protected your
  PC", choose **More info → Run anyway**.
- **Linux** - make the AppImage executable (`chmod +x Ambio-*.AppImage`) and
  run it.

Ambio checks GitHub Releases for new versions. On Windows and Linux (AppImage)
updates download in the background and install when you restart; on macOS
Ambio tells you when a new version is available.

Open a project from a terminal with `ambio .` (install the command from
Settings → Advanced), by dropping a folder on the window or dock icon, or from
an `ambio://open?path=/absolute/path` link.

Everything Ambio knows about your code stays on your machine - see
[PRIVACY.md](PRIVACY.md).

## How it works

1. Open a codebase in Ambio.
2. Review which folders and files belong in the index.
3. Choose who maps it. An agent Ambio runs (Claude Code, Codex, Copilot CLI,
   Antigravity CLI, or Ambio chat) maps it when you press **Map**, with its
   progress shown live; pick its model beside the button. For an agent in
   another app, add Ambio to it, restart it, and run the mapping command shown.
4. Review the proposed systems, nesting, and file placement.
5. Approve the proposal to make it the live canvas state.

The currently supported installers are:

- Claude (Claude Code CLI and Claude Desktop)
- GitHub Copilot (VS Code extension and Copilot CLI)
- Codex
- Grok Build CLI
- Meta Muse Code CLI
- Cursor
- Windsurf
- Antigravity
- JetBrains IDEs (IntelliJ, WebStorm, PyCharm, and siblings)
- Zed

Then the daily loop: open **Review Changes** to see what changed while you
were away; draw the next piece on a **sheet** and send it to an agent; watch it
arrive on the map; check what was built against what you drew. Agents can
start the loop too, by drawing their plan on a sheet for you to confirm.

The mapping command is harness-dependent. For example, Codex uses `$ambio-map`, Claude Code uses `/ambio-map`, and Antigravity uses its installed `ambio-map` skill. The setup screen always shows the correct instruction for the selected harness.

For Grok Build and Muse Code, install and sign in to the vendor's CLI, then
choose it in **Settings → Agents** or guided setup and add Ambio. Start a
fresh `grok` or `muse` session in your project and run `/ambio-map`. Both also
get `/ambio-inbox` and `/ambio-build`. Messages from Ambio use a copied
handoff pasted into that terminal chat; direct launching from Ambio is not
available yet. Account sign-in and plan usage stay with the vendor's client.

Agents keep working when the Ambio window is closed: Ambio's background
service starts when an agent needs it and stops again when it has been idle.

## Your data

Everything lives in `~/.ambio` (`%USERPROFILE%\.ambio` on Windows):
project maps and their history in `data/`, logs in `logs/`, settings in
`settings.json`. Ambio never changes your code unless an agent you connected
does.

- **Backups.** Ambio keeps a daily copy of each project's map for a week.
  Restore one from Project Settings → Map backups.
- **Recently Deleted.** A deleted map can be restored from the launcher for
  30 days.
- **Moving computers.** File → Export Map saves a project's map to a
  `.ambiomap` file; File → Import Map opens it on another computer and asks
  where the code lives there. Backups sit next to the map, so exporting is
  also the way to keep a copy somewhere else.
- **Moved a folder?** Ambio notices and asks where it went; the map follows.
- **Something wrong?** Report a bug and Copy diagnostics are on the launcher
  and in the Help menu. Diagnostics list versions and settings, never code.

## File policy

Every language below is read for symbols (functions, classes, methods) and
for the links between files. What an investigation run can see depends on
whether Ambio has a recorder for the language; runs always use your own
installed toolchain.

| Language | Files | Links between files | Investigation runs |
|---|---|---|---|
| TypeScript / JavaScript | `.ts` `.tsx` `.js` `.mjs` `.cjs` `.jsx` | imports, `require`, dynamic `import()` | calls, arguments, returns, crashes |
| Python | `.py` | imports (from a monorepo folder's source root too) | calls, arguments, returns, crashes |
| Ruby | `.rb` | `require_relative`, `require` of project files | calls, arguments, returns, crashes |
| Go | `.go` | package imports through `go.mod` | calls, arguments, returns, returned errors, panics |
| Java / Kotlin | `.java` `.kt` `.kts` | class and wildcard imports | calls, arguments, returns, crashes |
| Scala / Groovy | `.scala` `.sc` `.groovy` | class and wildcard imports (JVM names) | calls, arguments, returns, crashes (the same JVM recorder) |
| C# | `.cs` | the types a file uses, from its own namespace and its `using`s | calls, arguments, returns (awaited results for `async`), crashes |
| Rust | `.rs` | `mod`, and `use` within the crate | calls, arguments, returns, returned errors, panics |
| C / C++ | `.c` `.h` `.cpp` `.cc` `.cxx` `.c++` `.hpp` `.hxx` `.hh` | `#include` (quoted, and `<dir/file.h>` in the project) | exit code and output |
| PHP | `.php` | `require`/`include`, `use` (PSR-4 layout) | calls, arguments, returns, crashes |
| Swift | `.swift` | `import` of a module folder in the project | exit code and output |
| Lua | `.lua` | `require` of a project module | exit code and output |
| Shell | `.sh` `.bash` | `source` / `.` of a project script | exit code and output |
| Elixir | `.ex` `.exs` | `alias`, `import`, `use`, `require` of a project module | exit code and output |

Function-level runs for more languages are planned; see
`docs/INVESTIGATION_RUNTIMES.md`.

Readable documentation is indexed separately from the architecture canvas:

- `.md`, `.mdx`, `.txt`, `.rst`, `.adoc`

Binary media, PDFs, images, generated output, dependencies, and unknown formats are skipped. PDFs will remain unsupported until Ambio has a real text-extraction pipeline.

## Uninstall

1. **Disconnect your agents** - Settings → Agents → Remove Ambio from all
   agents. This removes only Ambio's entry and the workflow files it added.
2. **Delete Ambio's data** (optional) - Settings → Privacy & Data → Delete all
   Ambio data, or delete `~/.ambio` yourself while Ambio is closed.
3. **Remove the app:**
   - **macOS** - quit Ambio and drag it from Applications to the Trash.
   - **Windows** - Settings → Apps → Installed apps → Ambio → Uninstall.
   - **Linux** - delete the AppImage.
4. If you installed the `ambio` command, delete the `ambio` link it made (in
   `~/.local/bin`, `~/bin`, `/opt/homebrew/bin` or `/usr/local/bin`), or on
   Windows remove `%USERPROFILE%\.ambio\bin` from your PATH.

Your code is not touched by any of these steps.

## Architecture

Ambio has three main runtime pieces:

- `src/renderer` - React and React Flow desktop interface.
- `archd-go` - Go daemon responsible for indexing, parsing, persistence, HTTP APIs, and WebSocket updates.
- `mcp` - MCP server that translates agent requests into operations against the local daemon.

The Electron main process starts the desktop application and bundled daemon. archd prefers port `7743` for its local HTTP API and `7744` for WebSocket updates, and moves to free ports when another program holds them; the ports in use are published in `~/.ambio/data/daemon.json`. Every request needs the token in `~/.ambio/data/api-token`, and archd only answers on loopback - see [SECURITY.md](SECURITY.md). Each project's map is its own SQLite database under `~/.ambio/data/<project id>/`.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it fits together), [docs/PRODUCT.md](docs/PRODUCT.md) (what it is for and the rules it keeps), [docs/CANVAS_BEHAVIOR_CONTRACT.md](docs/CANVAS_BEHAVIOR_CONTRACT.md), [docs/MCP_SURFACE.md](docs/MCP_SURFACE.md) and [docs/INFRA.md](docs/INFRA.md). Everything still to do is in [WORK.md](WORK.md); decisions and their reasons are in [docs/DECISIONS.md](docs/DECISIONS.md).

## Development setup

### Prerequisites

Every platform needs:

- Node.js - the version in [`.nvmrc`](.nvmrc). A version manager (`fnm`, `nvm`) will pick it up automatically.
- Go 1.22 or newer.
- Git.
- A C toolchain. `archd` uses CGO (`mattn/go-sqlite3`, `go-tree-sitter`), so it
  compiles native code. The Electron side has no native modules.

Then, per platform:

- **macOS** - Xcode Command Line Tools (`xcode-select --install`) supply the
  clang that CGO and node-gyp need. Go via `brew install go`.
- **Linux** - `build-essential` (or your distribution's equivalent) and Go.
- **Windows** - MSYS2 installed at `C:\msys64`, providing the MinGW64 Go 1.22
  and GCC toolchains. This one is not interchangeable: TDM-GCC produces broken
  binaries on Win11 26200. If MSYS2 lives elsewhere, point `AMBIO_MSYS2_BASH`
  at its `usr/bin/bash.exe`.

### Install and run

```bash
git clone https://github.com/maxwmeadow/Ambio.git
cd Ambio
npm install
npm run dev
```

`npm run dev` runs `predev`, which builds the `archd` daemon before starting
Electron through electron-vite. The daemon is named `archd.exe` on Windows and
`archd` elsewhere; the build scripts and the Electron main process both follow
the host, so the same commands work everywhere.

To build the daemon directly:

```bash
npm run build:archd
```

## Talk to your agents

**Message Agent** opens one conversation panel for every agent. Choose where a
message goes under **Deliver to**; the info button beside it explains how each
agent works from the panel and what it can do, and the first time you choose an
agent Ambio shows that explanation until you confirm it.

- **Ask** reads and answers; **Propose** draws the change on your map for you
  to approve; **Build** changes code and hands the result back for review.
- Pick the model beside the request type. Agents Ambio runs offer the models
  they publish; Ambio chat offers its service's models.
- Agents Ambio runs need only their CLI, signed in. Antigravity's and Cursor's
  CLIs also need Ambio added to their app, which setup does when you press Map
  (it says exactly what it changes). Agents in other apps need
  Ambio added once (Settings → Agents) and stay attached to the conversation
  after the first message.
- While an agent works, its turn shows what it is doing and, where the agent
  shares it, what it is thinking. Files it names in its reply are links that
  take you to them on the map.
- What an agent proposes - a new system, a file or system moved or renamed, a
  new dependency - waits under **To review** in the sheet rail until you
  confirm or reject it.

**Ambio chat** is Ambio's own agent, using your model service. In
**Settings → Agents**, connect an eligible ChatGPT plan (sign in with OpenAI in
your browser; no API key), or choose OpenAI, Anthropic, Google, or an
OpenAI-compatible service, enter your API key, test the connection, and save. Local compatible
services can use a loopback HTTP URL without a key. Set each service's context
window to match your model. A conversation keeps its service; start a new one
to use another agent.

The local OpenCode harness is bundled with Ambio. Conversations resume after
restarting; unfinished work is never silently resent. Actions needing permission
and agent questions appear in the conversation, and Stop interrupts the turn.
Provider calls use your account and may incur charges. A cloud model receives the
messages and context its agent reads; see [Privacy](PRIVACY.md). Keys use secure
OS storage, or remain in memory only when a secure keychain is unavailable.

## Tests

```bash
# Renderer, MCP unit, and Electron unit tests
npm run test:renderer

# Go daemon tests
npm run test:archd

# Third-party license check (AGPL compatibility)
npm run notices -- --check

# MCP end-to-end tests
npm run test:mcp

# Integrated harness (controlled local model service; no paid API key needed)
npm run test:chat

# Electron and Playwright end-to-end tests
npm run test:e2e
```

Go commands can also be run directly from `archd-go` when the required Go and
CGO toolchain is already configured:

```bash
cd archd-go
go test ./...
```

## Packaging

```bash
npm run package
```

Artifacts land in `release/`. `prepackage` rebuilds the daemon first, and
electron-builder copies it into the application bundle through `extraResources`
so the packaged app can spawn it from `process.resourcesPath`.

A build only ever targets the host it runs on: the CGO daemon does not
cross-compile cleanly. Builds for every platform are produced
by [`.github/workflows/release.yml`](.github/workflows/release.yml), which
packages on Linux, Windows, and both Intel and Apple Silicon macOS runners.

## Useful development commands

```bash
npm run dev          # Build archd and launch Electron in development mode
npm run build        # Build Electron main, preload, and renderer bundles
npm run build:archd  # Build and smoke-test the Go daemon
npm run test:renderer
npm run test:archd
npm run test:mcp
npm run test:e2e
npm run package      # Build distributable application packages
```

When changing Go code, rebuild the bundled daemon with `npm run build:archd` before testing the desktop application.

### Troubleshooting

**`Cannot read properties of undefined (reading 'whenReady')` on `npm run dev`.**
Something in the environment has set `ELECTRON_RUN_AS_NODE=1`, which makes
Electron start as a plain Node process, leaving the `electron` module without
its APIs. VS Code's extension host sets it, so terminals and coding agents
launched from an extension can inherit it. Launch with `env -u
ELECTRON_RUN_AS_NODE npm run dev`, or use a terminal outside the editor.

## License

Ambio is free software under the [GNU Affero General Public License v3.0](LICENSE).
You can use it, study it, change it and share it. If you distribute a modified
version, or run one as a network service, you must publish its source under
the same license. Contributions are welcome under the [CLA](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md).
