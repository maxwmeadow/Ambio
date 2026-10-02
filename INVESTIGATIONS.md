# Investigations

Debugging by experiment, watched live. An agent states what it suspects, runs
the code that reproduces the problem with the suspect functions under
observation, and gets back what they actually did. Every step appears in a
case panel beside the architecture map, and the person watching can talk back.

Status: 2026-09-28. Node (JavaScript and TypeScript) and Python record runs;
other languages run with exit code and output only.

## The loop

One MCP tool, `investigation`, with these ops:

| op | What the agent sends | What it gets back |
|---|---|---|
| `start` | `name` - the symptom | Case opened; the project's own repro commands (`npm test`, `pytest`, ...) |
| `hypothesis` | `text` - one sentence | `H1`, anchored to the files and functions the sentence names |
| `run` | `command`, `watch`, optional `hypothesis` | The evidence report (below) |
| `verdict` | `hypothesis`, `result` (confirmed, refuted, inconclusive), `text` | Recorded; next step |
| `note` | `text` | Anchored note |
| `conclude` | `text` - the root cause, optional `fix`, optional `run` that proved the fix | Recorded |
| `stop` | - | Case saved for replay |
| `case`, `list`, `get` | - | The case file, saved cases, one saved case |

`watch` takes `"path/to/file.ts:functionName"`, a bare function name, or a file
path for every function in it. An unresolvable watch fails before the command
runs, with candidates, because a watch that silently matches nothing would read
as "never called" and mislead.

The MCP server sends instructions at connect time describing this loop. That is
what gets agents to use it: Claude Code defers MCP tool schemas, so an agent sees
a bare tool name and never reads a description it has no reason to load. In
trials, adoption went from 0 of 1 runs without instructions to every debugging
run that needed more than one step with them.

## What a run reports

`run` executes the command through the user's shell (`$SHELL -c`, `cmd /C` on
Windows) in the project root, with the runtime adapters injected through the
environment. No code changes, no build step, no dependency on the project's
`node_modules`. It waits for the command to finish (default 60s, max 600s; the
whole process tree is stopped on timeout) and returns findings, most suspicious
first:

| Finding | Meaning | How it is seen |
|---|---|---|
| crash | An uncaught exception, pinned to the first stack frame in the user's code | Exception hooks |
| exception | A watched function threw, on how many calls | Per-call |
| drift | The same object is seen on two calls with different contents, so state is shared between calls. From a return value: code outside the function changed an object it handed out (a cache) | Objects reachable from arguments, the receiver and the return value are tracked by identity |
| mutation | A watched function changed an argument. Leads only when the same object comes back on a later call, since filling in what a caller handed over is often the point | Arguments flattened at entry and exit, diffed |
| repeat | Called again with the same arguments as the call before (a double subscription, a retry) | Identity comparison, every call |
| accumulate | A value passed in grows or shrinks on every call | Per-path numeric statistics |
| not called | A watched function never ran, or ran only from another file (built output without a source map) | Watch resolution against what executed |
| tests | Failing test names from node:test, TAP, pytest, jest, vitest, go and cargo output | Output parsing |

Then, per watched function: call count, a return summary, and sample calls with
arguments, return value or exception, and what changed. Samples cover the first
calls, one of each kind of outcome, and the last. After that comes which
functions ran across the codebase, and the tail of the program's output. The
report is bounded (under 8 KB) so a large run cannot flood the agent's context.

Two findings from the trials, verbatim:

```
! `findCustomer` returns the same `return.pricing` object on calls 6 and 62, and it changed
  in between: `tier` "growth" → "partner", `netDays` 30 → 45 - code outside `findCustomer`
  is modifying an object it hands out (a shared or cached object?)

! `options.tokenizer.rules.inline` is the same object on calls 1 and 2 of `lex`, and it
  changed in between: `br` /^( {2,}|\\)\n(?!\s*$)[ \t]*/ → /^( *|\\)\n(?!\s*$)[ \t]*/
  - state is shared between calls
```

## How it works

```
agent ─ MCP investigation run ─▶ archd /api/investigation/run
                                   │ resolve watches against the index
                                   │ $SHELL -c "<command>"  with NODE_OPTIONS / PYTHONPATH
                                   ▼
                       user's program + adapter recorder (in-process)
                                   │ one evidence file per process, at exit
                                   ▼
                       archd merges, maps paths to map nodes, ranks findings
                     ┌─────────────┴──────────────┐
                report to agent           investigation:run event
                                          ├─ recorded in the case timeline
                                          └─ canvas: case panel + execution trace
```

**Node** (`adapters/node`). Every function in workspace files is rewritten at
load time to call the recorder on entry, return, throw and exit. That covers
CommonJS through `Module._compile` and ESM through a loader hook. TypeScript is
stripped with Node's position-preserving stripper first, so line numbers
survive. Built output that carries a source map is recorded under its original
file, line and name, including minified function and parameter names, so a
watch on `src/Tokenizer.ts:codespan` fires when the tests run
`lib/marked.esm.js`. Every instrumented file is re-parsed before it runs; a
rewrite that does not parse leaves the file untouched rather than breaking the
program. The parser and source rewriter are bundled into the adapter at build
time.

**Python** (`adapters/python`). `sys.settrace`, available on every supported
CPython, with line events switched off, so only calls, returns and exceptions
reach it. It writes the same evidence format as Node.

Both recorders aggregate in-process. Streaming each call over a socket failed
real runs: a repro that calls a function 48 times in 10ms tripped the rate
limiter, and watches that arrived after connect missed short scripts entirely.

**Case file** (`archd-go/internal/runtime/case.go`). Hypotheses, runs, verdicts,
the conclusion and the human's messages live on the investigation alongside its
timeline, so a saved case opens to its conclusion and replays step by step.

## The person watching

- **Case panel**: live status, a one-line summary of what is established, the
  hypothesis board, each run's findings, verdicts, notes, the root cause and fix.
  Every file or function it names is a button that shows it on the map.
- **The map**: a finished run animates the calls that crossed files, and each
  watched file shows its call count and last real values.
- **Talking back**: a message typed in the panel reaches the agent on its next
  tool call, whichever tool that is, in every MCP client. It is marked
  delivered when it does, and optionally points at the selected file.
- **When the agent stops**: the case stays on screen with "Watch the replay".
- **Replay**: the same event handler as live, paced so each finding stays up
  long enough to read, with 1×/2×/4× speed.

## Performance

marked's CommonMark and GFM spec suite (1,600 cases, about 12.5 million
function calls), on a 2017 iMac Pro:

| | Time |
|---|---|
| Uninstrumented | 10.0s |
| Instrumented, nothing watched | 12.8s (1.28×) |
| Watching `codespan`, called 730,478 times | 13.1s (1.31×) |

Unwatched functions allocate nothing per call. A watched function is recorded in
full for its first 100 calls, then sampled on a doubling stride (about 100
samples per doubling of the call count). Its counts, exceptions, repeats and
shared-object checks stay exact on every call. Before this design, the same
watched run took 333s.

## Security model

`run` executes a shell command with the user's permissions, the same power as
the agent's own shell tool. What is and is not bounded:

- The working directory is confined to the workspace; `cwd` cannot escape it.
- There are at most two concurrent runs per workspace. Each has a timeout, and
  the whole process group or tree is stopped when it expires.
- Output kept is bounded (head and tail, 60 KB).
- Commands are shown to the person watching as they run, and recorded.
- **Not sandboxed**: no filesystem or network isolation beyond the user's own.
  Authorization is the MCP client's tool permission. An agent allowed to call
  `investigation` can run commands, as with shell access. Treat granting it the
  way you treat granting shell access.

Evidence contains argument and return values from the user's program, bounded
and truncated. It stays on the local machine in archd's data directory.

## Limits

- **Languages**: Node, Python, Ruby, Go, the JVM (Java, Kotlin, Scala,
  Groovy), C#, PHP and Rust record function-level evidence, each through the user's own toolchain with
  nothing to install. Others run with exit code and output; see `docs/INVESTIGATION_RUNTIMES.md`
  for the plan. The DAP-based live debuggers under `debug_runtime` are
  separate.
- **Long-running servers**: `run` with `server` (and `port`) starts the server
  under the same recorders, waits until the port takes connections (2 s when
  no port is given), runs `command` against it, waits 1.2 s so every recorder
  flushes, then stops the server's process group. Evidence from both merges;
  the server's output is reported separately. A port already in use is
  refused, since the command would reach the wrong process. A server that
  dies while starting is the result, and the command does not run.
- **Reach**: drift and mutation see objects reachable from arguments, the
  receiver and the return value (depth 5, 60 objects per call). Module-level
  state no watched function touches is invisible; watch a function that does.
- **Sampling**: past 100 calls, value statistics and samples come from sampled
  calls. The report says how many were sampled.
- **TypeScript** is stripped with Node's own `stripTypeScriptTypes`, keeping
  every line where it was. Files that need real transformation (enums,
  namespaces, parameter properties) are transformed by the same API with a
  source map, so they record under their `.ts` lines too. Running such a file
  still needs the user's own `--experimental-transform-types` (or tsx), as
  Node requires.
- **Derived-class constructors** are observed from after a top-level `super()`.
  A conditional `super()` leaves the constructor unobserved.
- **Python**: how a call ended is read from the instruction its frame stopped
  at, so a function that handles an exception and returns `None` is not
  mistaken for one that raised. A generator or coroutine is one call however
  often it resumes; its result reads "yielded 3 values: ...", and `close()` is
  not a failure.
- **Go**: the module's files are rewritten for the run and applied with
  `go -overlay` (nothing on disk changes; line numbers are the user's own).
  Functions and methods are recorded, function literals are not. A non-nil
  error returned last counts as the call failing. Panics are read from the
  output and pinned to the first frame in the user's code. `go test` runs
  with `-vet=off` during a run (vet reads package folders from disk, where
  the run's recorder package does not exist). Files with `import "C"` and
  generated files run uninstrumented.
- **Java, Kotlin, Scala**: an agent loaded through `JAVA_TOOL_OPTIONS` into
  every JVM the command starts (java, Maven Surefire forks, Gradle test
  workers) rewrites classes compiled from workspace sources as they load;
  dependencies are untouched. Java 8 and newer. Parameter names need debug
  info (`-g`, the Maven and Gradle default); without it they read `arg0`.
  Lambdas and closures, getters and setters, and the methods the compiler
  writes for records, data classes and case classes are not recorded. Scala's
  strict collections are shown by their contents; a lazy one (`LazyList`, a
  view, an iterator) is named and never read, since reading it would run the
  program. A Kotlin suspend function is one
  call across its suspensions; one that suspends and is never resumed is
  counted without a result. Values are read field by field; the recorder
  never calls the program's `toString`, getters or `hashCode`, and iterates
  only the JDK's and Kotlin's own collections. A Gradle daemon already
  running keeps its own environment: stop it (`gradle --stop`) or run with
  `--no-daemon` if a run shows no JVM evidence.
- **C#**: recorded through the build. Every project the command builds
  (`dotnet run`, `dotnet test`, `dotnet build`) imports a targets file, which
  compiles instrumented copies of the project's `.cs` files kept under
  `obj/.../axiom`; the project's own files are never written. Code is added
  only on existing lines and a `#line` directive keeps the original path, so
  stack traces, line numbers and the debugger see the user's source. The
  rewriter uses the SDK's own compiler (.NET SDK 6 or newer, C# 6 or newer)
  and keeps a file only if its rewrite adds no error and no warning; anything
  else compiles as written. It runs the project's source generators too: a
  generator that copies a method's body into the code it writes would copy
  the added code with it, so a file whose rewrite makes generated code worse
  is compiled as written. Analyzer and generator projects in the workspace
  are build tooling and are not recorded. Methods, constructors, local functions and
  property accessors that do more than read or write a field are recorded;
  lambdas, operators, indexers and top-level statements are not. An `async`
  method's result is what it returned, not the `Task`. An iterator's items, a
  `ref` return, and `Span`, pointer or `out` values are not captured. A
  command that does not build (`dotnet test --no-build`, running a prebuilt
  DLL) records nothing. The first ordinary build after a run recompiles, so
  no instrumented output stays behind; until then the build output carries a
  recorder that does nothing outside a run. Style analyzers are off for the
  instrumented compile. F# and Visual Basic run with output only.
- **Rust**: recorded through Cargo. archd is the compiler wrapper for the
  workspace's own crates (`RUSTC_WORKSPACE_WRAPPER`; dependencies are not
  wrapped) and compiles instrumented copies of each crate's sources kept under
  `target/.../axiom-src`, with a recorder module that exists only there. The
  project's files are never written, paths are remapped so panic locations
  and debug info name the user's files, and Cargo caches wrapped builds apart
  from ordinary ones. Values are shown with their `Debug` implementation (a
  type without one is named, `<Ledger>`), so a custom `Debug` runs. A function
  that returns `Err` counts as failing, like Go's returned errors; one that
  leaves through `?` is recorded as "propagated with `?`" without the value.
  A panic on the main thread is the crash; a panicking test is the harness's
  to report. Mutation is reported for reference arguments and `self`. "The
  same object" means the same heap or static address: a local on the stack
  has an address the next call's local reuses, so it is not followed. A
  function whose instrumented form does not compile is recorded less (no
  after-values, then no return value, then not at all) until the crate
  compiles. `const fn`, closures, code inside macros, `no_std` crates, the
  2015 edition and proc-macro crates are not recorded; `impl Trait` and `!`
  results are not captured. Each crate carries its own recorder, so call
  edges stop at crate boundaries. A function nobody watches is timed and
  placed in the call graph for its first 20,000 calls and only counted after
  that (a tiny function in a loop runs a billion times); a watched one is
  recorded in full for 100 calls and then sampled. Instrumented crates are
  tied to the recorder's version, so an Axiom update rebuilds them.
- **PHP**: an ini file of the run's own (`PHP_INI_SCAN_DIR`) prepends the
  recorder to every PHP the command starts: `php script.php`, PHPUnit, `php
  -S` (one evidence document per request). PHP has no tracing hook for
  scripts, so the recorder stands in for the `file://` stream wrapper and
  serves an instrumented copy of each workspace `.php` file as PHP includes
  it; nothing on disk changes and lines do not move. Each rewrite is checked
  with PHP's own parser and dropped if it does not parse. Named functions and
  methods are recorded; closures, arrow functions and property hooks are not.
  Arrays are values in PHP, so mutation and drift are reported for objects (an
  array an object holds counts as that object's state). A by-reference return
  is not captured. Code under `vendor/` is not recorded. The program can see
  three differences: `get_included_files()` lists the recorder's files, a
  failed file open adds PHP's "stream_open call failed" warning to the native
  one, and `get_defined_vars()` inside a recorded function includes `__ax`. An
  `auto_prepend_file` of the user's own is replaced for the run. Tested on
  PHP 8.0 through 8.5; written to run on 7.4.
- **Ruby**: methods are recorded, blocks are not. An exception counts against
  every method it unwinds. Before Ruby 3.3 (which added the `:rescue` trace
  event), a method that rescues and then returns `nil` without calling anything
  looks like one that raised. `StopIteration` ending a loop is not a failure.
  Ruby 2.6 and newer.
- **Paths**: symlinked project paths are resolved on both sides. Windows paths
  are normalized for Node's option parser.

## Evaluation

Method: headless Claude Code (Opus 5.5) given a support-style ticket that never
mentions Axiom, in a lab repository with a planted bug, against the real app and
daemon. Each ticket ran with Axiom connected and with no MCP servers at all.
Otherwise identical: same model, prompt and permissions, and the lab reset to
the buggy state between runs. The canvas was screenshotted every 3 seconds.

| Ticket | Bug | With Axiom | Without | Used investigation |
|---|---|---|---|---|
| shopfront: shipping overcharges* | shared mutable rate table | 52s · $0.32 | 72s · $0.43 | yes (notes only) |
| marked: `<br>` after a breaks render | module-level rule table mutated across calls | 181s · $0.50 | 188s · $0.40 | yes: start, 2 runs, verdict, conclude |
| marked: truncated code spans | `&&` → `\|\|` | 70s · $0.19 | 86s · $0.17 | no (one grep found it) |
| ledgerly: partner discount in batch | cached object mutated by a far-away merge | 69s · $0.39 | 72s · $0.31 | yes: start, 3 runs, verdict, conclude |

\* An earlier version with notes but no `run`, and a different comparison:
Axiom connected with server instructions versus without them (the agent then
made no Axiom calls at all).

Every run fixed its bug. Both agents on the three harder tickets added a
regression test; on the code-span ticket neither did, because tests for that
case already existed.

What this shows:

- **Adoption works.** With server instructions the agent used the loop on every
  bug that took more than a single step, unprompted. It skipped it for a
  one-grep fix, which is the right call.
- **Speed is at parity; cost is about 25% higher** on codebases the agent can
  read whole. A frontier model reads 20 to 40 files in one step and reasons to
  the cause. Runs then confirmed the hypothesis (and in two cases verified the
  fix) rather than discovering it.
- **The watcher's experience is the difference today.** With Axiom, the person
  watching saw the hypothesis, the evidence run with its findings, the verdict
  and the root cause as they happened, and can replay them. Without it, they
  saw the final chat message.
- **The evidence is sufficient on its own.** On every lab bug, one run watching
  the right function states the root cause (see the findings above). Whether
  that beats reading depends on the codebase being too large to read whole,
  which these labs are not.

Next: the same comparison on a codebase of several hundred files, where bulk
reading stops working, and on bugs that depend on production-like data.

### Reproducing

Labs live outside the repository: `~/dev/axiom-lab/{shopfront,marked,ledgerly}`.
marked is upstream 18.0.14 with two planted changes folded into the release
commit. Reset a lab with `git reset --hard && git clean -fd`. For marked, also
rebuild the bundle its tests use: `npm run build:esbuild`.

## Tests

- `adapters/node/transform.test.mjs`: minified and nested shapes, async and
  generators, TypeScript line numbers, source maps with minified names,
  constructors.
- `adapters/node/recorder.test.mjs`: real child processes. Shared mutation,
  repeats, exceptions, exit codes, sampling with exact counts, call edges,
  receivers, TypeScript, drift through arguments and return values.
- `archd-go/internal/api/evidence_test.go`: attribution to the innermost
  function, collection roll-up, receivers, repeats, the built-code hint, six
  test runners, report bounds, cwd confinement.
- `archd-go/internal/runtime/launch_env_test.go`: `NODE_OPTIONS` with Windows
  and non-ASCII paths.
- `src/renderer/store/caseFile.test.mjs`: the case reducer, live and replayed.
- `mcp/e2e/investigationRun.e2e.mjs`: the full loop through the MCP server,
  archd and both adapters, including a human message delivered exactly once.
