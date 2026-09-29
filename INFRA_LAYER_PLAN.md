# Axiom - Infra Layer Plan

> Status: active plan, local development first
> Supersedes the 2026-07-09 draft. Its Phase I1 (registry, schema, CRUD, MCP
> `edit_infra`) is built and is the foundation below.
> Last updated: 2026-09-29

---

## Why this exists

Code is only half of what a program does. The other half is what it talks to:
the database it writes, the cache it trusts, the queue it hands work to, the
model it prompts, the API that charges a card. Most bugs worth an afternoon live
on that boundary - a stale cache entry, an event handled twice, a query in a
loop, a prompt that changed, a webhook nobody calls.

An infra node earns its place on the map only if it answers a question someone
actually has. A logo with a category does not. Every node therefore has to
carry four things:

1. **Role** - what part it plays (database, cache, queue, …).
2. **Contract** - what code depends on inside it: tables, topics, cache keys,
   endpoints, webhooks, prompts, models, flags, schedules.
3. **Relationships with evidence** - who reads, writes, publishes, consumes or
   calls it, down to the table or topic, each with the `file:line` that proves it.
4. **Behaviour** - is it reachable on this machine, what does it need to run,
   and what did it actually do during a run.

## State on 2026-09-29

Built (Phase I1): the service registry (72 services, layered embedded → user →
workspace), typed node schema, category-validated edges, CRUD API, MCP
`edit_infra` and the `infra` / `infra_for_files` / `infra_catalog` views, the
add-infra catalogue, category silhouettes, and platform nodes that can host
systems (`hosted_by`).

In practice: no project on the development machine has a single infra node.
Detection signatures exist for 54 services but nothing reads them. The Floor
draws no dependency edges and nothing replaced them for infra, so recorded
relationships are invisible; the inspector shows only type, subtype and status.
Agents are never told when to record infra. `DEPLOYS_TO` and `hosted_by` both
mean "deployed here" and do not know about each other.

---

## The local-development insight: infra is a role

In local development most roles are not played by the vendor. The ledgerly lab
project has no infrastructure dependencies at all, and is full of infra roles:

| Role | Played locally by |
|---|---|
| payments API | `payments/gateway.ts` - an in-memory array standing in for Stripe |
| queue / events | `events/bus.ts` - an in-process publish/subscribe bus |
| email | `notifications/email.ts` - pushes to an in-memory `OUTBOX` |
| cache | `util/lru.ts` - an in-process LRU in front of the customer store |

The two bugs agents debugged in the lab projects were infra bugs by role: a
cached object mutated by its reader (cache), and a handler subscribed twice
(queue). Neither involved a vendor.

So a node is **a role, and what fills it in each environment**. An
implementation is one of:

- `in-process` - code in this repository (the bus, the LRU, a fake gateway),
- `local-service` - a process on this machine (a compose container, `redis-server`),
- `emulator` - a local stand-in for a vendor (stripe-mock, LocalStack, the
  Firebase emulator, Mailpit),
- `vendor` - the real service through its SDK.

This makes infra meaningful in every project from the first index, including
ones that never leave a laptop, and ties it directly to debugging.

---

## Roles

Each role defines the relationship kinds that are legal for it, what its
contract holds, and what it means to the person and to the agent. All
relationships point from code to infra (file or system → infra); the renderer
flips direction visually where the data flows the other way.

`IMPLEMENTS` is legal for every role: the file that *is* the in-process
implementation.

| Role | Relationships | Contract (contents) | For the person | For the agent |
|---|---|---|---|---|
| `database` | READS, WRITES, MIGRATES | tables / collections and their columns, from migrations and ORM models | who writes `orders`; what a schema change touches; pending migrations | reads the schema instead of grepping migrations; runs show queries, N+1 loops, and tests that wrote rows |
| `cache` | READS, WRITES, INVALIDATES | key patterns, TTLs, cached value types | which code writes the source data vs which code refreshes the key | stale-data and mutated-cache bugs; hit and miss counts per key in a run |
| `queue` | PUBLISHES, CONSUMES | topics / event names with payload shapes | async flows made visible: publisher → topic → consumer; topics nobody consumes | follows calls across the async hop; payload drift between producer and consumer; duplicate handlers |
| `storage` | READS, WRITES | buckets and key prefixes | who writes and reads each prefix | files written during a run |
| `search` | QUERIES, INDEXES | indexes and document shape | index drift when a writer changes the document | queries vs indexing paths |
| `llm` | CALLS | models, prompt templates, exposed tools | where prompts live, which feature uses which model | the exact prompt and response of a run; token cost before running |
| `api` | CALLS, HANDLES_WEBHOOK | methods used, webhooks handled | the integration surface; webhook handlers as entry points | failure simulation ("card declined"); requests and statuses in a run |
| `auth` | AUTHENTICATES_VIA, PROTECTS | provider, protected routes, middleware | which handlers are not behind auth | follows the existing auth pattern when adding an endpoint |
| `platform` | DEPLOYS_TO, RUNS_ON | entry points, run and build commands, ports, env var set; CDN and static hosting are a subtype | what runs where, and how to start each piece locally | learns how to run the app or the tests for an investigation |
| `observability` | REPORTS_TO, CAPTURES | analytics event names, error-capture points | the event catalogue: who emits `checkout_completed` | knows an exception was captured and swallowed rather than thrown |
| `email` | SENDS_VIA | templates and their triggers | which flows send which mail | the would-be emails of a run ("this run sent 82") |
| `scheduler` | SCHEDULED_BY | schedules (cron expressions, repeat intervals) and their jobs | what runs with no caller, and when | explains entry points the call graph cannot reach |
| `flags` | EVALUATES | flag keys and their variants | where behaviour depends on a flag | a flag as a variable in a hypothesis: same code, different result |
| `realtime` | PUBLISHES, SUBSCRIBES | channels | push flows to clients | channel traffic in a run |

`cdn` is retired as a role and becomes a `platform` subtype: it has almost no
meaning during local development and no distinct relationships.

**Configuration is not a role.** Environment variables are requirements
attached to the roles and files that read them (see Runnability), not nodes -
one node per variable would bury the map.

---

## Model

Changes on top of the Phase I1 schema:

- **Roles.** The category set above; `cdn` rows migrate to `platform` / `cdn`.
- **Implementations.** `infra_nodes.implementations` (JSON): a list of
  `{environment, kind, ref, evidence}` - `ref` is a file id (`in-process`), a
  compose service or command (`local-service`), an emulator name, or a host.
  In-process implementations are also `IMPLEMENTS` edges so they participate in
  the graph.
- **Contents.** New table `infra_contents(id, infra_id, kind, name, detail,
  evidence, source)` - kind is one of table, collection, topic, key_pattern,
  bucket, index, method, webhook, model, prompt, flag, schedule, channel, route,
  event. `detail` is JSON (columns, payload shape, TTL, cron expression, …).
- **Item-level relationships.** `dependencies.target_item` names the contents
  item an edge is about (`orders`, `invoice.issued`) so "who writes orders" is a
  query, not a grep.
- **Evidence and provenance on every edge.** `evidence` is `file:line`;
  `created_by` is `parser` | `agent` | `user` | `runtime`; edges gain a `status`
  (`proposed` | `confirmed` | `dismissed`) like nodes.
- **Requirements.** New table `infra_requirements(id, workspace_id, kind, name,
  infra_id, evidence, present)` - kind `env` for now. `present` records whether
  the variable is defined for local runs; values are never read.
- **Policies.** `infra_nodes.policies` (JSON flags): `costs_money`,
  `external_side_effects`, `never_in_tests`, `confirm_before_running`. The agent
  reads them before acting; investigations warn when a run would cross them.
- **One meaning for "deployed here".** `DEPLOYS_TO` and `hosted_by` are
  reconciled: hosting a system in a platform writes the edge, and an edge from a
  system to a platform offers to host it.

Secret safety carries over unchanged: env files are parsed for *names*;
connection strings go through a strict URI parser with userinfo discarded
before inspection; evidence stores names and hosts, never values.

---

## Where infra shows up

| Surface | What infra adds |
|---|---|
| **Floor** | legible role cards; each system carries the infra it touches along its rim (brand glyphs with counts); selecting a system or node reveals its relationships as transient lines; peripheral placement (stores and services below, platforms around what they host) |
| **Inspector** | who touches it, grouped by relationship and contents item, with `file:line` evidence; the contract; implementations per environment; requirements; policies |
| **Detection** | the map arrives populated: proposals from manifests, imports, env names and config files, confirmed by the person or the agent |
| **Agent reads** | `get_architecture` answers "which files write orders", "what does this system talk to", "what does this need to run" |
| **Agent writes** | recording infra it adds, confirming proposals with reasons, binding in-process implementations |
| **Investigations** | infra activity as run evidence; side-effect findings; failure simulation; a pre-flight "can this run" check |
| **Sheets and build plans** | planned infra becomes a build plan (client setup, env vars, local service), and comparing the sheet confirms the relationships exist |
| **Morning Delta** | infra changes as high-signal claims: a new vendor, a new table written, a new required env var |
| **Living canvas** | infra arrival, and relationship changes to infra, use the same activity choreography as files |

---

## Phases

Every phase ships its agent surface with it, and ends with a real-agent test on
the lab project: a task where the phase should help, run with and without Axiom,
judged on the agent's result and on what the person watching could see.

### L0 - Lab project and baseline

An infra-heavy local-development project, `harbor`, under `~/dev/axiom-lab/`:
Postgres through `pg` with SQL migrations, a Redis cache with an in-process LRU
fallback, a job queue and an in-process event bus, Stripe with a local fake,
OpenAI with prompt templates, S3-compatible storage, Resend email, Sentry and
PostHog, an auth middleware, scheduled jobs, feature flags, `.env.example`,
`docker-compose.yml`, `vercel.json`. Seeded with infra bugs of each kind (stale
cache, duplicate consumer, N+1 query, swallowed exception, wrong model).
Runs locally with no accounts. Baseline: how agents and the map do today.

### L1 - Model refresh

Roles (add `scheduler`, `flags`, `realtime`; fold `cdn` into `platform`),
`IMPLEMENTS`, implementations, contents, item-level and evidence-carrying
relationships with status, requirements, policies, the `DEPLOYS_TO` /
`hosted_by` reconciliation. Fix the Phase I1 gaps: agent updates drop
`subtype`; the inspector shows the deprecated `infra_type`; handles have no ids.

### L2 - Detection: propose, then confirm

Channels, cheapest first, all at index time and incremental on change:

1. **Manifests** (`package.json`, `go.mod`, `requirements.txt`,
   `pyproject.toml`, `Cargo.toml`) - workspace-level proposals, low confidence.
2. **Imports** (already parsed) - file → infra edges with `file:line`.
3. **Env names** (`.env.example`, `.env*` names only, `process.env.X` /
   `os.environ` reads) - requirements, and proposals upgraded by name.
4. **Config files** (`docker-compose.yml`, `vercel.json`, `fly.toml`,
   `Procfile`, package scripts, CI workflows) - local services, platforms,
   schedules, run commands.
5. **In-process roles** - the agent binds these (`IMPLEMENTS`); detection only
   hints at common shapes (a map of handler lists behind `publish`/`subscribe`).

Proposals render ghosted in a tray; the person or the agent confirms or
dismisses each (dismissals stick by service id). Re-indexing reconciles.
MCP: proposals in `get_architecture`, confirm/dismiss through `edit_infra`, and
server instructions that tell the agent when infra matters.

### L3 - Visibility

Legible role cards counter-scaled like activity badges; the system rim;
selection-revealed relationships through the existing overlay; the inspector's
"who touches it"; placement bands. The Floor still draws no permanent
dependency wiring.

### L4 - Contracts

Contents extraction: SQL migrations and ORM schemas → tables and columns;
literal event names at publish/subscribe call sites → topics; literal key
prefixes at cache calls → key patterns; `stripe.x.y` / SDK method calls →
methods; webhook routes; model names and prompt files; flag keys; cron
expressions. Item-level relationships from the same call sites. The agent reads
contracts through `get_architecture` and adds what extraction misses.

### L5 - Runnability

Requirements per node and per system ("to run Billing locally: DATABASE_URL,
STRIPE_SECRET_KEY, Postgres reachable"); reachability checks for local services
(a TCP connect to the host and port from compose or the env name's URL shape,
never credentials); start commands from platform nodes. A pre-flight in
`investigation run` reports what is missing before the command fails, and the
person gets the same list as a setup checklist.

### L6 - Runtime

The run recorder observes infra activity in-process: `pg` queries, Redis
commands, `fetch` / `http` requests matched to services by host, SDK calls
(OpenAI, Stripe, Resend), queue publishes and handler invocations, in-process
implementations through `IMPLEMENTS`. Runs report it as evidence and findings:
queries per call and N+1 loops, writes during tests, cache hit rate and
mutated cached values, messages published but never handled, emails a run
would send, exact LLM prompts, responses and tokens. Failure simulation per
node (down, slow, error response) through the existing injection machinery,
honouring policies. Relationships seen at runtime are marked as proven.

### L7 - Review, planning and guardrails

Morning Delta claims for infra changes; sheets with planned infra produce build
plans and verify relationships on compare; policies enforced in investigations
and surfaced to the agent.

---

## Principles

- **Propose, never assert.** No node or edge becomes confirmed without a person
  or agent deciding. Confidence never exceeds evidence.
- **Evidence or nothing.** Every relationship names the line that justifies it
  or the run that observed it.
- **Local first.** Everything works on one machine with no accounts. Vendors
  and deployed environments are later layers on the same model.
- **The agent is a first-class reader and writer.** Every phase ships its MCP
  surface and its instructions, measured with a real agent on the lab project.
- **No spaghetti.** The Floor shows infra through rims, cards and
  selection-revealed lines, never permanent all-graph wiring.
- **Secrets never enter the database.** Names and hosts only.

## Open questions

- Environments beyond local: how dev, staging and production implementations
  sit on one node, and how the person switches between them.
- Infrastructure as code (Terraform, CDK, Kubernetes manifests) as a detection
  channel and as the source of cross-service edges (a function triggered by a
  queue with no code in between).
- Services the team runs themselves (another repository's API) as `api` nodes
  backed by a second Axiom workspace.
