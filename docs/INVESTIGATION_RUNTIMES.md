# Investigation runtimes: one install, every language

> Status: active plan, 2026-09-30. Goal from `docs/LAUNCH.md`: one download,
> nothing else to set up. This is the investigations track of that goal.

## The rule

**Bundle what is Axiom's. Never bundle the user's toolchain.**

`investigation run` executes the user's own command - `npm test`,
`python repro.py`, `bundle exec rspec`, `go test ./...` - with their own
interpreter, compiler, virtualenv and dependencies, and adds Axiom's recorder
through environment variables. That is deliberate: their code needs their
versions. Bundling Node, Python, Ruby, Go, .NET, a JDK and compilers would cost
gigabytes and still be the wrong versions, and a person without Python is not
debugging a Python project.

What Axiom must ship itself:

| Piece | Status |
|---|---|
| archd (Go, CGO) | bundled. On Windows it is now linked statically so it imports only system DLLs; `scripts/check-archd-imports.mjs` enforces it in CI and before release. MSYS2 is a **build** dependency, never a runtime one. |
| MCP server | bundled, runs on Electron's own Node (other track). |
| Node recorder | bundled (`adapters/node`), loaded with `NODE_OPTIONS`. |
| Python recorder | bundled (`adapters/python`), loaded through `PYTHONPATH` + `sitecustomize`. |
| Ruby recorder | bundled (`adapters/ruby`), loaded through `RUBYLIB` + `RUBYOPT=-raxiom_recorder`. Added 2026-09-30. |

## Recorders, not debuggers

Function-level evidence (arguments, returns, mutations, shared state, crashes)
comes from an **in-process recorder** loaded by the runtime's own hook. No
debugger, no install, no pause on every call, and every language feeds the same
evidence document (`EvidenceDoc` in `archd-go/internal/runtime/run.go`), so the
agent reads all of them the same way.

| Language | Hook | State |
|---|---|---|
| JavaScript / TypeScript | `NODE_OPTIONS --require/--import`, source transform | done |
| Python | `PYTHONPATH` + `sitecustomize`, `sys.settrace` | done |
| Ruby | `RUBYLIB` + `RUBYOPT -r`, `TracePoint` | done (methods; drift not yet) |
| Java / Kotlin | `JAVA_TOOL_OPTIONS=-javaagent:axiom-agent.jar`, bytecode advice on workspace classes | next |
| C# / .NET | `DOTNET_STARTUP_HOOKS`, method patching in workspace assemblies | after Java |
| Go | `go build -toolexec` source rewrite into a temp overlay, as the Node transform does | after .NET; hardest, but covers `go test` and `go run` |
| C / C++ | no in-process hook without a rebuild | debugger fallback (below) |

Each recorder is a few files shipped with the app and runs on the user's own
runtime, so adding one never adds an install step.

## Debuggers, as the fallback

The DAP sessions under `debug_runtime` (delve, netcoredbg, gdb, rdbg,
java-debug) stay for live attach and for native code. Rules for them:

1. **Use the debugger the user's toolchain already has.** C/C++ developers have
   lldb (Xcode, LLVM) or gdb (GCC, MSYS2); detect which matches the compiler.
2. **Offer, don't require.** When one is missing, say exactly what one command
   installs it (`winget`, `brew`, `apt`, `go install`) instead of failing.
3. **Download on demand** only where a recorder is not practical and the
   debugger is small and permissively licensed (delve, netcoredbg: MIT), into
   `~/.axiom/tools`, pinned and checksum-verified. Never bundle gdb (GPL, and
   tied to one compiler family).

## What the person and the agent see

A project's investigations readiness, before anyone runs anything:

- which languages the project uses and whether each records function-level
  evidence, runs with output only, or needs one tool installed;
- the one action that improves it, when there is one.

The agent gets the same line in `investigation start`, so it knows whether a
run will show values or only output before it plans a repro.

## Order

1. Self-contained `archd.exe` - **done** (verify on a clean Windows VM).
2. Ruby recorder - **done**, proves the pattern end to end.
3. Readiness readout in the UI and in `investigation start`.
4. Java agent, then .NET startup hook, then Go toolexec.
5. Debugger detection and install hints for C/C++; on-demand delve and
   netcoredbg.
