# Investigations benchmark

Status: **future plan**, 2026-11-10. There is no budget for scored runs yet,
so nothing here has been run and the benchmark is parked
(`investigation-benchmark` in [WORK.md](../WORK.md), the investigations slice of
`mcp-eval-harness`). Until then, work goes into making investigations
stronger, checked the low-cost way described in
[Before there is a budget](#before-there-is-a-budget). This document is the
plan to pick up when there is money for API runs.

## The claim under test

Ambio's investigations let an agent debug by running and entering the code
(call any function with inputs it chooses, watch the functions it suspects,
later step through them) instead of reasoning about the code in its head. The
claim we want to be able to make in public is that this is:

1. **more accurate**: more bugs fixed at the true root cause;
2. **cheaper**: fewer tokens and less money per fixed bug;
3. **faster**: less wall-clock time per fixed bug;
4. **less wasteful**: fewer wrong fixes tried before the right one;

and that the gap is largest on the hardest bugs, where agents otherwise loop.

The claim only counts if it is measured on bugs we did not choose, against a
baseline other people already trust, with the same model and the same budget on
both sides. That is what this document designs.

## Why third-party benchmarks

A benchmark we wrote ourselves would be dismissed: we would be picking bugs our
tool is good at. Public benchmarks give us real bugs from real repositories,
official graders (the repository's own tests decide whether a fix works),
published scores for the same models, and a community that already knows how
to read the numbers. Precedent exists, so a debugging-tool result is a question
reviewers already ask:

- **debug-gym** (Microsoft Research, 2025) gave agents Python's `pdb`. On
  SWE-bench Lite, Claude 3.7 Sonnet reportedly went from 37.2% (edit and rerun
  only) to 48.4% with the debugger, and 52.1% when the debugger unlocked after
  five failed edits. Microsoft's own summary is that agents with debugging
  tools "rarely solve more than half" of the issues.
- **Debug2Fix** (Microsoft, 2026) puts `jdb`/`pdb` behind a debugging subagent
  the main agent asks questions of, and reports more than 20% improvement for
  some models on GitBug-Java and SWE-Bench-Live, with weaker models matching
  stronger ones once they have the debugger.

Neither reports token cost as a headline, and neither records calls across a
whole run the way Ambio's recorder does. That is the gap our result would fill:
**the same comparison, plus cost, plus a recorder-first design.**

## The benchmarks

Numbers below come from each project's paper or site as found on 2026-11-10;
the ones marked *secondary* were only seen in third-party write-ups. Check each
against the primary source before quoting it publicly.

| Benchmark | What it is | Size and languages | Use here | Caveats |
|---|---|---|---|---|
| [SWE-bench-Live](https://arxiv.org/abs/2505.23419) (Microsoft) | Real GitHub issues created since 2024, refreshed over time, graded by the repo's tests | 1,319 tasks, 93 repos at release; Python. A MultiLang/Windows split is *secondary* | **Core set.** Fresh issues resist training contamination; Debug2Fix already reports on it | The original paper found the same setup scored 43.2% on Verified but under half that here |
| [SWE-bench Pro](https://arxiv.org/abs/2509.16941) (Scale AI) | Long-horizon, enterprise-style tasks, often multi-file | Public set 731 tasks from 11 GPL repos; mixed languages | **Hard set.** OpenAI recommends it in place of Verified | Scale says public-set results are not on its public leaderboard; check before comparing |
| [SWE-PolyBench](https://arxiv.org/abs/2504.08703) (Amazon) | Repository-level tasks in four languages, with a 500-task stratified subset | 2,110 tasks: JavaScript 1,017, TypeScript 729, Python 199, Java 165 | **JS/TS set**, Ambio's largest recorder audience | Includes features and refactors; filter to bug fixes |
| [Multi-SWE-bench](https://arxiv.org/abs/2504.02605) (ByteDance, NeurIPS 2025) | Issue resolution across eight languages | 2,132 tasks: Python, Java, TypeScript, JavaScript, Go, Rust, C, C++ | **Language set**: the only one with Go, Rust, C and C++ | Per-language sizes are uneven |
| [SWE-bench Multilingual](https://www.swebench.com/multilingual) | 300 tasks, 42 repos, nine languages | 300 | Cross-check for the language set | Small per language |
| [SWE-bench Verified](https://www.swebench.com) | 500 human-validated Python tasks | 500 | **Continuity only**: most published agent numbers use it | OpenAI [stopped reporting it](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) (2026-02-23): contaminated, and flawed tests in at least 59.4% of an audited hard subset |
| [debug-gym](https://github.com/microsoft/debug-gym) mini_nightmare | Ten hand-made minimal bugs that edit-only agents struggle with | 10, Python | **Pipeline smoke test** and a direct debugger comparison | Tiny; its `pdb` tool runs on Linux only |
| Defects4J, BugsInPy, BugsJS | Classic program-repair sets | Java, Python, JavaScript | Optional: fault-localization accuracy only | A 2026 ICST paper argues they are now in training data |

Two pieces of measurement infrastructure are as important as the tasks:

- **[mini-SWE-agent](https://www.swebench.com/bash-only.html)**: the ~100-line,
  bash-only agent the official SWE-bench "Bash Only" leaderboard uses so that
  scores compare models, not scaffolds. It is our controlled scaffold.
- **[HAL](https://hal.cs.princeton.edu/)** (Princeton, ICLR 2026): reports
  accuracy against total cost and reruns tasks to measure variance. Its finding
  that "the most costly models are rarely on the Pareto frontier" is the
  framing we want: Ambio should move an agent toward the frontier. We report
  the way HAL does.

## Design

### The arms

Every comparison holds the model, scaffold, budget and tasks fixed. Only the
tools change.

| Arm | Tools | Answers |
|---|---|---|
| **A1 Baseline** | The scaffold as published (bash: read, edit, run tests) | What the model does alone |
| **A2 Ambio** | A1 plus Ambio's `investigation` tool | The headline comparison |
| **A3 Plain debugger** | A1 plus a raw debugger (`pdb`, as in debug-gym) | Does Ambio beat simply having a debugger? |
| **A4 Method only** | A1 plus Ambio's investigation instructions ("state a suspicion, test it, conclude"), no tool | Is the gain the tool, or the prompt? |
| **A5 Ambio + stepping** | A2 plus the stepping operations (`investigation-stepping`) | Added when stepping exists; must beat A2 |

A3 and A4 are what make the result hard to argue with: without them a reviewer
can say the gain came from any debugger, or from telling the agent to be
methodical.

Published leaderboard numbers (call it A0) are shown for context only. They use
other scaffolds and budgets, so we never subtract our numbers from theirs; we
rerun A1 ourselves and show that our A1 lands near the published number for
the same model, which shows our harness is not handicapping the baseline.

### Two tracks

- **Track S (controlled).** mini-SWE-agent, so the result is about Ambio and not
  about a scaffold. Ambio reaches a bash-only agent through a small command
  (`ambio investigate run ...`) that calls the same daemon operations as the MCP
  tool and prints the same report. Building that command is part of
  `investigation-bench-runtime`.
- **Track P (product).** The hosts people actually use, run headless with and
  without the Ambio MCP server: Claude Code (`claude -p`) and Codex CLI first.
  Less controlled (each host has its own prompts), but it is the number users
  care about. Run on a subset once Track S works.

### Tasks

Debugging is the claim, so only bug fixes count. From each source, keep tasks
whose issue describes wrong behaviour and whose official grader has at least
one test that fails before the fix (`FAIL_TO_PASS`); drop feature and refactor
tasks. Then sample with a fixed, published seed:

| Set | From | Size | Purpose |
|---|---|---|---|
| Smoke | mini_nightmare | 10 | Prove the pipeline; direct `pdb` comparison |
| Core | SWE-bench-Live bug fixes, issues after the model's training cutoff | 150 | Headline numbers, contamination-resistant |
| Hard | SWE-bench Pro public, bug fixes | 75 | Long-horizon, multi-file |
| Languages | SWE-PolyBench500 (JS/TS) and Multi-SWE-bench (Go, Rust, Java, C, C++) | 25 per language, ~175 | One per recorder; C/C++ exercise the gdb/lldb path |
| Continuity | SWE-bench Verified bug fixes | 50 | Comparable to the most published numbers; reported separately, never as the headline |

The **hard subset** used for the "largest gap on the hardest bugs" claim is
defined by a rule written down before any Ambio run: tasks A1 fails in at least
two of its three runs. Nobody picks hard tasks by hand.

### Measures

Per run, from the API's own usage fields and the official grader:

- **Resolved**: the official grader passes (`FAIL_TO_PASS` now pass,
  `PASS_TO_PASS` still pass).
- **Tokens**: input, cached input and output, kept separate, totalled per run.
  Ambio's instructions and every tool report count as input tokens like
  anything else.
- **Cost**: at list prices on the run date, with prompt caching as the
  provider bills it.
- **Wall time**: from task start to final patch, including Ambio's indexing
  (it is real waiting time even though it costs no tokens).
- **Turns** and **tool calls**, by tool.
- **Wrong fixes**: edits followed by a failing test run before the final patch.
- **Localization**: whether the first edit lands in a file the reference patch
  changes.
- **Tool adoption** (A2, A3, A5): whether and how often the agent used the tool.

Reported per arm and set: resolve rate, **tokens per resolved task**, **cost
per resolved task**, median wall time, wrong fixes per task, and an
accuracy-against-cost plot in HAL's style.

### Runs and statistics

- **Three runs per task per arm.** Agents are noisy; one run per task can swing
  a comparison by several points.
- **Paired by task**, since every arm sees the same tasks. Resolve rate:
  McNemar's test on per-task majority outcome, plus a bootstrap 95% interval on
  the difference. Tokens and time: Wilcoxon signed-rank on tasks both arms
  resolve, and the medians.
- **Fixed budgets** for every arm: a turn cap, a token cap and a 45-minute
  wall-clock cap per task. A run that hits a cap is unresolved, and its tokens
  still count.
- **Intent to treat**: A2 is scored on every task, including those where the
  agent never touched the tool. A second view restricted to runs that used it
  shows what the tool does when used, but the first is the claim.
- **Pre-registered**: this document's hypotheses, task rules, seeds, budgets
  and analysis are committed before the first scored run. Changes afterwards
  are logged with the reason.

### Fairness and threats

| Threat | Handling |
|---|---|
| Ambio's instructions cost tokens | Counted. A4 measures the instructions alone |
| The gain is only "having a debugger" | A3 |
| The gain is only the prompt | A4 |
| Our harness weakens the baseline | A1 is checked against the published score for the same model and scaffold |
| Training contamination | Core set is post-cutoff SWE-bench-Live; Verified reported apart |
| Picking tasks Ambio is good at | Bug filter and sampling seed fixed in advance; every task reported |
| Ambio's indexing is unpaid work | Counted in wall time; daemon CPU time reported |
| Variance | Three runs, paired tests, intervals |
| Agents ignore new tools | Measured (adoption); Debug2Fix needed a dedicated subagent for the same reason, so a subagent variant of A2 is a fallback, not a different claim |
| Flawed upstream tests | Use each benchmark's official grader unchanged; note known-flawed tasks rather than dropping them silently |

### Environment

The SWE-bench family runs each task in a Linux Docker image built by the
benchmark's own harness. Ambio must therefore run headless inside that image:
archd, the bundled recorders and the MCP server, with no Electron. The MCP
end-to-end harness (`mcp/e2e/mcpHarness.mjs`) already starts archd headless,
indexes a project and drives the MCP server; it is the starting point. Per task:

1. Build or pull the benchmark's image for the task.
2. Copy in a pinned Ambio build (archd binary, `adapters/`, MCP server).
3. Start archd, register and index the repository, and wait for the index.
4. Run the agent with the arm's tools and budgets; record the full transcript
   and API usage.
5. Take the final diff and grade it with the benchmark's official harness.
6. Write one JSON line per run: task, arm, run number, model, Ambio version,
   every measure above, and the transcript path.

Ambio needs no network inside the container; the agent's model calls go
through the runner.

### Cost and compute

A full scored round is roughly 460 tasks × 3 runs × 4 arms ≈ 5,500 agent runs.
Third-party trackers put a SWE-bench task at somewhere between $0.10 and $2
per run depending on model and scaffold (Vals.ai, HAL), so one round is in the
low thousands of dollars for a frontier model, and much less for the pilot.
Docker storage for SWE-bench images runs to hundreds of gigabytes; a cloud
machine is more practical than a laptop. Model choice and budget are Max's
(`investigation-benchmark-budget` in WORK.md).

## Phases

1. **Pilot.** mini_nightmare plus 20 core tasks, one model, A1 and A2, one run
   each. Done when the pipeline produces graded JSON lines and transcripts end
   to end, and A1 is within a few points of the published score.
2. **Core.** The full core and hard sets, A1 to A4, three runs. The first
   result worth reading.
3. **Languages.** The language set; tells us which recorders hold up on real
   projects and which need work.
4. **Product track.** Claude Code and Codex CLI, with and without Ambio, on the
   core set.
5. **Stepping.** A5, once `investigation-stepping` tier 1 exists. A stepping
   operation stays only if it improves resolve rate or tokens per resolved task
   over A2.
6. **Publish.** Methodology, task lists, seeds, every transcript and the
   per-task results, so anyone can check them; and submit to leaderboards that
   accept tool-augmented agents (SWE-bench-Live has a leaderboard).

## Before there is a budget

The scored benchmark needs API money; learning what helps does not. Until it
is funded:

- **Unscored runs on a subscription.** Headless Claude Code (`claude -p`, JSON
  output includes token usage) and Codex CLI run on the user's plan, not on API
  billing. A handful of tasks (mini_nightmare and a few SWE-bench-Live bug
  fixes, cloned and run locally without the Docker harness) with and without
  Ambio, one run each, gives transcripts to read: where the agent guessed,
  where an investigation would have settled it, where it ignored the tool, and
  where a report was too long. These are anecdotes, never a published number.
- **Ambio's own fixtures.** Every new investigation capability gets a small
  local bug it must help with (a shared object changed between calls, a double
  subscription, a race), added next to the existing investigation fixtures, so
  regressions show without any agent at all.
- **Token budgets per report.** The run report is already capped at 8 KB;
  every new op gets its own cap and a test that holds it, since the token claim
  depends on it.
- **Build the parts that cost nothing to keep.** The headless runtime
  (`investigation-bench-runtime`) also makes investigations work in Linux
  containers and CI, which users need regardless.

When money is available, phase 1 below starts from these transcripts and
fixtures rather than from zero.

## What we would be able to say

Only what the numbers support, worded to the result. If A2 beats A1, A3 and A4
on the core set with intervals that exclude zero:

> On N fresh SWE-bench-Live bugs, the same model with Ambio investigations fixed
> X% more bugs and used Y% fewer tokens per fixed bug than without it, and beat
> giving it a plain debugger. On bugs the model alone usually fails, the gap was Z.

If tokens rise while accuracy rises, the claim becomes cost per fixed bug, not
tokens. If A4 matches A2, the lesson is that the method matters more than the
tool, and that is still worth knowing before we build stepping.

## Open questions for Max

1. Which model or models: one frontier and one cheaper model would also test
   Debug2Fix's "weaker model catches up" finding.
2. Budget for the pilot and the core round.
3. Publish every result, including unfavourable ones? (Recommended: yes; it is
   what makes the favourable ones believable.)
4. Track P hosts first: Claude Code and Codex CLI?

## Sources

- debug-gym: [Microsoft Research blog](https://www.microsoft.com/en-us/research/blog/debug-gym-an-environment-for-ai-coding-tools-to-learn-how-to-debug-code-like-programmers),
  [repository](https://github.com/microsoft/debug-gym),
  [Simon Willison's summary of the results](https://simonwillison.net/2025/Mar/31/debug-gym/)
- Debug2Fix: [arXiv 2602.18571](https://arxiv.org/abs/2602.18571)
- SWE-bench-Live: [arXiv 2505.23419](https://arxiv.org/abs/2505.23419)
- SWE-bench Pro: [arXiv 2509.16941](https://arxiv.org/abs/2509.16941),
  [Scale leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public)
- SWE-PolyBench: [arXiv 2504.08703](https://arxiv.org/abs/2504.08703),
  [AWS announcement](https://aws.amazon.com/blogs/devops/amazon-introduces-swe-polybench-a-multi-lingual-benchmark-for-ai-coding-agents)
- Multi-SWE-bench: [arXiv 2504.02605](https://arxiv.org/abs/2504.02605),
  [NeurIPS 2025](https://papers.neurips.cc/paper_files/paper/2025/hash/5afa9cb1e917b898ad418216dc726fbd-Abstract-Datasets_and_Benchmarks_Track.html)
- SWE-bench Multilingual: [swebench.com/multilingual](https://www.swebench.com/multilingual)
- SWE-bench Bash Only / mini-SWE-agent: [swebench.com/bash-only](https://www.swebench.com/bash-only.html)
- OpenAI on SWE-bench Verified: [Why we no longer evaluate SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- HAL: [hal.cs.princeton.edu](https://hal.cs.princeton.edu/), [arXiv 2510.11977](https://arxiv.org/abs/2510.11977)
- Per-task cost figures: [Vals.ai SWE-bench](https://www.vals.ai/benchmarks/swebench)
- Contamination of classic repair sets: [arXiv 2504.04372](https://arxiv.org/abs/2504.04372)
