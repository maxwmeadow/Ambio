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
| Go recorder | built into archd (`internal/runtime/gorecorder`), applied through the go command's `-overlay`. Added 2026-09-30. |
| C# recorder | bundled (`adapters/dotnet`: `Axiom.targets`, a 92 KB rewriter, and the recorder source it compiles into each project). Ships nothing third-party: the rewriter loads Roslyn from the user's own SDK. Prebuilt and committed; `adapters/dotnet/build.mjs` rebuilds it. Added 2026-10-01. |
| JVM recorder | bundled (`adapters/java/axiom-agent.jar`, 255 KB, ASM relocated inside it), loaded through `JAVA_TOOL_OPTIONS`. Prebuilt and committed, so building Axiom needs no JDK; `adapters/java/build.mjs` rebuilds it. Added 2026-10-01. |

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
| Ruby | `RUBYLIB` + `RUBYOPT -r`, `TracePoint` | done (methods, drift; exact rescue tracking on 3.3+) |
| Java / Kotlin / Scala | `JAVA_TOOL_OPTIONS=-javaagent:axiom-agent.jar`, bytecode advice on classes compiled from workspace sources | done (methods, constructors, drift, suspend functions) |
| C# | source rewrite applied by MSBuild (`CustomAfterMicrosoftCommonTargets` imports `Axiom.targets`), with a recorder source compiled into each project | done (methods, constructors, local functions, accessors, async results, drift) |
| Go | source rewrite applied with `GOFLAGS=-overlay=...`; a recorder package added only in the overlay | done (functions and methods; panics from output) |
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
3. Readiness readout in the UI and in `investigation start` - **done**
   (`/api/investigation/readiness`, the Investigations menu, the case-open reply).
4. Go overlay recorder - **done**. JVM agent - **done**. C# build-time
   recorder - **done**.
5. Debugger detection and install hints for C/C++; on-demand delve and
   netcoredbg.

## Why C# is rewritten at build time, not patched at run time

The obvious .NET hook is `DOTNET_STARTUP_HOOKS` plus a method-patching library
(Harmony). It was prototyped and rejected: a patched method runs as a generated
copy, so the program's own stack traces lose their line numbers and show names
like `Reserve_Patch1`, and an exception passing through a patch loses the
frames below it. A recorder must not make a crash harder to read than it was.

The build-time rewrite keeps traces exact (code is added on existing lines, an
exception filter records an exception without catching it), records what an
`async` method actually returned, and needs no runtime patching at all. The
cost is that it only sees C# that the run's command builds.
