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
| Rust recorder | built into archd (`internal/runtime/rustrecorder`): archd is Cargo's workspace wrapper during a run. Added 2026-10-01. |
| PHP recorder | bundled (`adapters/php`), loaded through a per-run ini (`PHP_INI_SCAN_DIR`, `auto_prepend_file`). Added 2026-10-01. |
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
| Rust | source rewrite applied by archd as Cargo's `RUSTC_WORKSPACE_WRAPPER`; a recorder module added only in the rewritten crate root | done (functions and methods, returned errors, panics, mutations through references) |
| PHP | `PHP_INI_SCAN_DIR` + `auto_prepend_file`; files rewritten in memory as they are included, through the `file://` stream wrapper | done (functions, methods, generators, object mutations and drift) |
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
5. C/C++ through the system debugger (lldb-dap or gdb) - **done** for
   `debug_runtime`, verified on macOS with lldb once Developer Tools access
   is enabled.

## Versions each recorder has been run on

Each recorder runs inside the user's own runtime, so the range of versions
matters more than for ordinary code. These were run against real installs of
each version (2026-10-01, macOS x64); the adapter tests take the interpreter
or SDK from an environment variable so the sweep can be repeated.

| Recorder | Verified on | Select with |
|---|---|---|
| Python | 3.9, 3.10, 3.11, 3.12, 3.13, 3.14 | `PYTHON_BINARY` |
| Ruby | 2.6, 4.0 (the exact `:rescue` tracking needs 3.3+) | `RUBY_BINARY` |
| JVM agent | JDK 8, 17, 21, 25; Kotlin 2.4 on all; Scala 3.9 and Groovy 6 on 17+ | `JAVA_HOME`, `KOTLIN_HOME`, `SCALA_HOME`, `GROOVY_HOME` |
| C# | .NET SDK 6, 8, 10 | `DOTNET_ROOT` |
| PHP | 8.0, 8.1, 8.2, 8.3, 8.4, 8.5 | `PHP_BINARY` |
| Rust | 1.70 and 1.99 (editions 2021 and 2024) | `RUSTUP_TOOLCHAIN` |
| Go | 1.27 | - |
| Node | 22 | - |

What the sweep found: Python 3.13 rests a suspended generator one instruction
past its yield, which read as a raise; Ruby and Go did not follow returned
objects for drift. Both are fixed. Not yet run on Windows or Linux.

## Real projects each recorder has run

Each recorder was run on real projects' own test suites, with and without
recording, comparing results (2026-10-01/02):

| Recorder | Project (suite) | Result | Time, ordinary -> recorded |
|---|---|---|---|
| Node 22 | npm/node-semver (tap, 51 suites, 9,182 assertions, 89 processes) | same | 6.4 s -> 8.8 s |
| Python 3.12 | pallets/click (pytest, 2,240 tests) | same | 7.3 s -> 17.1 s |
| Ruby 4.0 | ruby/rake (test-unit, 606 tests, 71 processes) | same | 12.4 s -> 19.2 s |
| JVM (Maven) | google/gson (JUnit, 4,673 tests) | same | 5.6 s -> 6.9 s |
| JVM (Gradle, Kotlin) | michaelbull/kotlin-result (387 tests) | same | about the same |
| C# | FluentValidation (xUnit, 888 tests) | same | 3 s -> 5.2 s |
| PHP 8.5 | nikic/FastRoute (PHPUnit, 359 tests) | same | 0.18 s -> 0.26 s |
| Rust | dtolnay/semver, rust-itertools/itertools (400+ tests) | same | 2.65 s -> 3.33 s (worst binary) |
| Go | gorilla/mux, spf13/cobra, uber-go/zap | same | - |

What these found, now fixed: Rust took a global lock per call (100x slower
on itertools) and Cargo reused crates built with an older recorder; a C#
source generator that copies method bodies broke the instrumented build;
Go's flush goroutine failed zap's leak check, and its result capture renamed
the user's closures.

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
