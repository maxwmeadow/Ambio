# Axiom

**See your entire codebase. Steer what your agents build.**

Axiom is a local-first architecture workbench for developers working with AI
coding agents. It reads your code into a live map of systems, files and the
relationships between them, and gives your agents the same map through MCP.
You and your agents look at, and change, one shared picture of the project.

<!-- Hero: a short GIF or video of the Floor, a sheet sent to an agent, and
     the review of what it built goes here, before anything else. -->

> Axiom is in active development and has not had a stable release yet. Expect
> things to change, and please [report what breaks](https://github.com/maxwmeadow/Axiom/issues).

[Install](#install) · [How it works](#how-it-works) · [Your data](#your-data) ·
[Uninstall](#uninstall) · [Development](#development-setup) ·
[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md)

## What it does

- **A live map of your code.** Files are grouped into nested systems by what
  they do, not by folder, and the map updates as files change, whether you or
  an agent changed them.
- **Your agents see the same map.** Claude Code, Codex, Copilot, Cursor and
  other MCP agents can ask Axiom where things are and what depends on what,
  and propose how the code should be organised. You review a proposal on the
  canvas and approve it, rearrange it or send parts back.
- **Plan on the canvas, then hand it off.** Sketch a feature on a sheet laid
  over the map and send it to an agent as a work order. Axiom checks what the
  agent built against the plan and shows you the differences.
- **Review what changed.** Review Changes shows what moved in the
  architecture since you last looked, instead of a forty-file diff.
- **Infrastructure in view.** Databases, queues, caches, external APIs and
  hosting are detected from code and config. They sit in a sidebar and draw
  their connections onto the map when selected; what runs your code is shown
  as frames around the systems it hosts.
- **Keyboard first.** A command palette (`⇧⌘P` / `Ctrl+Shift+P`) reaches every
  command; `⌘/` / `Ctrl+/` lists the shortcuts.
- **Local.** Maps, layouts and history live on your computer. There is no
  account, no analytics, and your code is never uploaded.

## Install

Download the installer for your platform from the
[latest release](https://github.com/maxwmeadow/Axiom/releases/latest). Axiom is
a single application: it brings its own runtime, so there is nothing else to
install before connecting your coding agent.

Early builds are not yet code-signed, so your operating system will warn you
the first time you open Axiom:

- **macOS** - open the `.dmg`, drag Axiom to Applications and open it. When
  macOS says it cannot verify the developer, open **System Settings → Privacy &
  Security**, scroll to the message about Axiom and choose **Open Anyway**.
- **Windows** - run the installer. If SmartScreen shows "Windows protected your
  PC", choose **More info → Run anyway**.
- **Linux** - make the AppImage executable (`chmod +x Axiom-*.AppImage`) and
  run it.

Axiom checks GitHub Releases for new versions. On Windows and Linux (AppImage)
updates download in the background and install when you restart; on macOS
Axiom tells you when a new version is available.

Open a project from a terminal with `axiom .` (install the command from
Settings → Advanced), by dropping a folder on the window or dock icon, or from
an `axiom://open?path=/absolute/path` link.

Everything Axiom knows about your code stays on your machine - see
[PRIVACY.md](PRIVACY.md).

## How it works

1. Open a codebase in Axiom.
2. Review which folders and files belong in the index.
3. Add Axiom to a supported agent harness from the setup card.
4. Restart that agent so it loads the MCP server and mapping workflow.
5. Run the harness-specific mapping command shown by Axiom.
6. Review the proposed systems, nesting, and file placement.
7. Approve the proposal to make it the live canvas state.

The currently supported installers are:

- Claude (Claude Code CLI and Claude Desktop)
- GitHub Copilot (VS Code extension and Copilot CLI)
- Codex
- Cursor
- Windsurf
- Antigravity
- JetBrains IDEs (IntelliJ, WebStorm, PyCharm, and siblings)
- Zed

The mapping command is harness-dependent. For example, Codex uses `$axiom-map`, Claude Code uses `/axiom-map`, and Antigravity uses its installed `axiom-map` skill. The setup screen always shows the correct instruction for the selected harness.

Agents keep working when the Axiom window is closed: Axiom's background
service starts when an agent needs it and stops again when it has been idle.

## Your data

Everything lives in `~/.axiom` (`%USERPROFILE%\.axiom` on Windows):
project maps and their history in `data/`, logs in `logs/`, settings in
`settings.json`. Axiom never changes your code unless an agent you connected
does.

- **Backups.** Axiom keeps a daily copy of each project's map for a week.
  Restore one from Project Settings → Map backups.
- **Recently Deleted.** A deleted map can be restored from the launcher for
  30 days.
- **Moving computers.** File → Export Map saves a project's map to a
  `.axiommap` file; File → Import Map opens it on another computer and asks
  where the code lives there. Backups sit next to the map, so exporting is
  also the way to keep a copy somewhere else.
- **Moved a folder?** Axiom notices and asks where it went; the map follows.
- **Something wrong?** Report a bug and Copy diagnostics are on the launcher
  and in the Help menu. Diagnostics list versions and settings, never code.

## File policy

Architecture indexing currently supports:

- TypeScript and JavaScript: `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`
- Python: `.py`
- Go: `.go`
- Rust: `.rs`
- C#: `.cs`
- C/C++ headers and sources: `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx`
- Ruby: `.rb`
- Java: `.java`

Readable documentation is indexed separately from the architecture canvas:

- `.md`, `.mdx`, `.txt`, `.rst`, `.adoc`

Binary media, PDFs, images, generated output, dependencies, and unknown formats are skipped. PDFs will remain unsupported until Axiom has a real text-extraction pipeline.

## Uninstall

1. **Disconnect your agents** - Settings → Agents → Remove Axiom from all
   agents. This removes only Axiom's entry and the workflow files it added.
2. **Delete Axiom's data** (optional) - Settings → Privacy & Data → Delete all
   Axiom data, or delete `~/.axiom` yourself while Axiom is closed.
3. **Remove the app:**
   - **macOS** - quit Axiom and drag it from Applications to the Trash.
   - **Windows** - Settings → Apps → Installed apps → Axiom → Uninstall.
   - **Linux** - delete the AppImage.
4. If you installed the `axiom` command, delete the `axiom` link it made (in
   `~/.local/bin`, `~/bin`, `/opt/homebrew/bin` or `/usr/local/bin`), or on
   Windows remove `%USERPROFILE%\.axiom\bin` from your PATH.

Your code is not touched by any of these steps.

## Architecture

Axiom has three main runtime pieces:

- `src/renderer` - React and React Flow desktop interface.
- `archd-go` - Go daemon responsible for indexing, parsing, persistence, HTTP APIs, and WebSocket updates.
- `mcp` - MCP server that translates agent requests into operations against the local daemon.

The Electron main process starts the desktop application and bundled daemon. archd prefers port `7743` for its local HTTP API and `7744` for WebSocket updates, and moves to free ports when another program holds them; the ports in use are published in `~/.axiom/data/daemon.json`. Every request needs the token in `~/.axiom/data/api-token`, and archd only answers on loopback - see [SECURITY.md](SECURITY.md). Each project's map is its own SQLite database under `~/.axiom/data/<project id>/`.

More detailed references are available in [ARCHITECTURE.md](ARCHITECTURE.md), [CANVAS_BEHAVIOR_CONTRACT.md](CANVAS_BEHAVIOR_CONTRACT.md), [MCP_SURFACE.md](MCP_SURFACE.md) and [INFRA_LAYER_PLAN.md](INFRA_LAYER_PLAN.md). Launch readiness and product decisions are tracked in [docs/LAUNCH.md](docs/LAUNCH.md).

## Development setup

### Prerequisites

Every platform needs:

- Node.js - the version in [`.nvmrc`](.nvmrc). A version manager (`fnm`, `nvm`) will pick it up automatically.
- Go 1.22 or newer.
- Git.
- A C toolchain. `archd` uses CGO (`mattn/go-sqlite3`, `go-tree-sitter`) and the
  renderer depends on `better-sqlite3`, so both halves compile native code.

Then, per platform:

- **macOS** - Xcode Command Line Tools (`xcode-select --install`) supply the
  clang that CGO and node-gyp need. Go via `brew install go`.
- **Linux** - `build-essential` (or your distribution's equivalent) and Go.
- **Windows** - MSYS2 installed at `C:\msys64`, providing the MinGW64 Go 1.22
  and GCC toolchains. This one is not interchangeable: TDM-GCC produces broken
  binaries on Win11 26200. If MSYS2 lives elsewhere, point `AXIOM_MSYS2_BASH`
  at its `usr/bin/bash.exe`.

### Install and run

```bash
git clone https://github.com/maxwmeadow/Axiom.git
cd Axiom
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

A build only ever targets the host it runs on: neither the CGO daemon nor
`better-sqlite3` cross-compiles cleanly. Builds for every platform are produced
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

Axiom is free software under the [GNU Affero General Public License v3.0](LICENSE).
You can use it, study it, change it and share it. If you distribute a modified
version, or run one as a network service, you must publish its source under
the same license. Contributions are welcome under the [CLA](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md).
