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

- **Languages**: Node and Python only. Go, .NET and others run with exit code
  and output. The DAP-based live debuggers under `debug_runtime` are separate.
- **Long-running servers**: `run` waits for the command to exit. For a server,
  use a repro script that exercises it, or `debug_runtime` to attach.
- **Reach**: drift and mutation see objects reachable from arguments, the
  receiver and the return value (depth 5, 60 objects per call). Module-level
  state no watched function touches is invisible; watch a function that does.
- **Sampling**: past 100 calls, value statistics and samples come from sampled
  calls. The report says how many were sampled.
- **TypeScript** that needs real transformation (enums, namespaces, parameter
  properties) is run uninstrumented, as Node's own stripper requires.
- **Derived-class constructors** are observed from after a top-level `super()`.
  A conditional `super()` leaves the constructor unobserved.
- **Python**: a function that catches an exception and then returns `None` is
  indistinguishable from one that raised. Generators count each resume as a
  call.
- **Paths**: symlinked project paths are resolved on both sides. Windows paths
  are normalized for Node's option parser.

## Evaluation

Method: headless Claude Code (Opus 5.5) given a support-style ticket that never
mentions Ambio, in a lab repository with a planted bug, against the real app and
daemon. Each ticket ran with Ambio connected and with no MCP servers at all.
Otherwise identical: same model, prompt and permissions, and the lab reset to
the buggy state between runs. The canvas was screenshotted every 3 seconds.

| Ticket | Bug | With Ambio | Without | Used investigation |
|---|---|---|---|---|
| shopfront: shipping overcharges* | shared mutable rate table | 52s · $0.32 | 72s · $0.43 | yes (notes only) |
| marked: `<br>` after a breaks render | module-level rule table mutated across calls | 181s · $0.50 | 188s · $0.40 | yes: start, 2 runs, verdict, conclude |
| marked: truncated code spans | `&&` → `\|\|` | 70s · $0.19 | 86s · $0.17 | no (one grep found it) |
| ledgerly: partner discount in batch | cached object mutated by a far-away merge | 69s · $0.39 | 72s · $0.31 | yes: start, 3 runs, verdict, conclude |

\* An earlier version with notes but no `run`, and a different comparison:
Ambio connected with server instructions versus without them (the agent then
made no Ambio calls at all).

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
- **The watcher's experience is the difference today.** With Ambio, the person
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

Labs live outside the repository: `~/dev/ambio-lab/{shopfront,marked,ledgerly}`.
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
