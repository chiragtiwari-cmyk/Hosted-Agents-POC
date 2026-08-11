# Foundry Multi-Agent Orchestration Runtime — Slice One Design

Date: 2026-08-04
Status: Approved
Project: `foundry-orchestration-lab`

## Purpose

An R&D runtime for LLM multi-agent orchestration, built to be deployed as a Microsoft
Foundry hosted agent. The immediate goal is a workshop: understand Foundry hosted agents
by building and deploying a real multi-agent system on them.

This document specifies **slice one** only. Slice one is deliberately the smallest thing
that is genuinely multi-agent and genuinely deployed. Later slices are listed at the end
so that slice one does not accidentally design for them.

## Decisions and Constraints

These were settled during design and are not open questions during implementation.

| Decision | Choice | Consequence |
| --- | --- | --- |
| Orchestration pattern | Supervisor / hierarchical delegation | LLM is the scheduler; not a DAG |
| Deployment topology | One hosted agent, four agents in-process | No A2A, one Entra identity in slice one |
| Language | TypeScript, Node 22 | Rules out Foundry code-based zip deploy |
| Deployment mode | Image-based (container → ACR) | We hand-write the Responses protocol surface |
| Model provider | **OpenAI API primary (amended 2026-08-04)**, Azure/Foundry fallback | `OPENAI_API_KEY` wins when set; on that path the per-agent Entra identity for model calls is not exercised |
| Domain | Simulated retail banking | Fixture ledger; no real financial data, no third-party APIs (Foundry model endpoints excepted) |
| Streaming | **In scope (amended 2026-08-04)** | SSE on `/responses` + WebSocket |
| Realtime / voice | **In scope (amended 2026-08-04)** | `/invocations_ws` + browser Web Speech API |
| UI | Local Express-served static page | Not routed through the Foundry gateway |

### Amendment 2026-08-04 — streaming, WebSocket, and voice

Slice one originally deferred streaming and never covered voice. Both were subsequently
requested and are now in scope. They are built as a **layer on top of the core loop**, not
woven through it, so the supervisor and agents remain as specified:

- `POST /responses` gains optional SSE (`stream: true`) emitting
  `response.output_text.delta` events, plus custom `delegation.*` events so the UI trace
  pane fills in live.
- `GET /invocations_ws` implements a WebSocket protocol for bidirectional realtime,
  matching Foundry's `/invocations_ws` shape. **Correction (later, 2026-08-04):** this
  section originally said WebSocket was preview-limited by region. That was stale —
  Responses, Invocations, and Invocations WebSocket are GA in all hosted-agent
  regions; only A2A is preview.
- **Voice runs in the browser**, not the server: Web Speech API `SpeechRecognition` for
  mic input and `speechSynthesis` for playback, with transcripts sent over the WebSocket.
  Rationale: no extra credential, no per-minute cost, works with no Azure access. It
  degrades to text-only where the browser lacks support. Server-side Azure Speech is a
  documented later option, not slice one.

### Deliberate non-goals for slice one

- No A2A, no per-agent Entra identity (single deployment ⇒ single identity).
- No nested delegation (agent calling agent).
- ~~No persistence: the ledger is in-memory, reseeded on container start.~~
  **Superseded — the ledger now persists per session.**
- ~~No Foundry session filesystem use (`$HOME`, `/files`).~~ **Superseded — see the
  session-management amendment below.**
- No real financial data, credentials, or third-party banking APIs.
- No server-side speech service (voice is browser-side; see the amendment above).

## Architecture

One Foundry hosted agent, deployed as a `linux/amd64` container image. Express server on
port 8088.

```
POST /responses          Responses protocol — used by Foundry gateway AND the local UI
GET  /health             readiness gate for the gateway
GET  /api/trace/:id      delegation trace, for the UI's right pane
GET  /                   static UI (local demo surface only)
      │
      ▼
┌──────────────────────────────────────────┐
│  supervisor                              │
│   - reads turn + prior messages          │
│   - tool-calls one or more specialists   │
│   - merges results into a reply          │
└───────┬──────────┬───────────┬───────────┘
        ▼          ▼           ▼
    balance    payments     loans          plain TS classes
        │          │           │
        └──────────┴───────────┘
                   ▼
             Ledger (in-memory, seeded from bank.json)
```

Delegation is implemented as an LLM tool-call. The supervisor exposes one tool per
specialist; each specialist is its own narrowly-instructed LLM call with typed access to
the ledger. This is the same shape as A2A delegation, so the slice-two split to multiple
deployments becomes a transport change rather than a rewrite.

### Why supervisor rather than a graph

The supervisor pattern is what Foundry's multi-agent story (A2A) is built around, and it
is the smallest thing that is meaningfully multi-agent — a DAG of one-shot calls barely
is. The routing decision lives in the model, which is the behaviour under study.

### File layout

```
src/
  server.ts            Express app, Responses protocol mapping, routes
  supervisor.ts        routing loop, tool dispatch, confirmation handling
  agents/
    types.ts           Agent interface — the seam for slice two
    registry.ts        the list; tool schemas are generated from it
    balance.ts
    payments.ts
    loans.ts
  bank/
    ledger.ts          typed ledger operations
    bank.json          fixtures
  llm.ts               Foundry model client + Entra auth
  trace.ts             OpenTelemetry setup → Application Insights
public/
  index.html           two-pane demo UI
  app.js
  style.css
Dockerfile
```

## The Agent Contract

One interface, three implementations. This is the seam the rest of the system hangs on.

```ts
export interface Agent {
  readonly name: string;            // "balance"
  readonly description: string;     // becomes the supervisor's tool description
  readonly inputSchema: JSONSchema; // becomes the tool's parameter schema
  handle(input: unknown, ctx: AgentContext): Promise<AgentResult>;
}

export interface AgentContext {
  ledger: Ledger;
  llm: LlmClient;
  sessionId: string;
  trace: Tracer;
}

export interface AgentResult {
  summary: string;                   // what the supervisor sees
  data?: unknown;                    // structured detail, for the trace
  needsConfirmation?: PendingAction;  // payments only
}
```

Two notes:

- **Tool schemas are generated from the registry**, not hardcoded:
  `agents.map(toToolSchema)`. Adding a specialist is one file plus one registry line.
- **`needsConfirmation` lives on the shared result type** even though only `payments`
  sets it. The alternative — a distinct confirming-agent type — would force the
  supervisor to branch on agent kind. One optional field keeps dispatch uniform.

Specialists read the ledger directly and use the LLM only to phrase the answer. This is
intentional: the interesting behaviour stays in the orchestration, not inside an agent.
Each specialist is roughly 30 lines.

## The Agents

| Agent | Role | Ledger access |
| --- | --- | --- |
| supervisor | Owns the conversation, routes, merges | **None** — sees only `summary` strings |
| balance | Accounts, balances, recent transactions | Read-only |
| payments | Transfers between accounts and to payees | Read/write, behind a confirmation gate |
| loans | Eligibility and indicative quotes | Read-only |

The supervisor is not passed a `Ledger` handle at all. The capability boundary is
structural, not a convention.

## Supervisor Loop

```
1. Build messages: [system prompt, ...history, user turn]
2. LLM call with tools = registry.map(toToolSchema)
3. No tool calls → that text is the reply. Done.
4. For each tool call → dispatch to agent, append result as a tool message
5. Go to 2, up to MAX_TURNS
```

- **Parallel tool calls are allowed.** "What's my balance and can I get a loan?" yields
  two tool calls in one round, dispatched with `Promise.all`. Multi-intent needs no
  special-casing.
- **`MAX_TURNS = 4`**, then a plain "I couldn't complete that" reply. An unbounded LLM
  loop holding a money-moving tool is not acceptable even in a sandbox. `MAX_TURNS`
  counts **iterations of the loop above** (i.e. supervisor LLM calls), not individual
  tool calls — one round dispatching three specialists in parallel is one turn.

## Confirmation Flow

The only piece of real state in slice one.

```
Turn 1  user:       "send £200 to Alice"
        supervisor: → make_payment { to: "Alice", amount: 200 }
        payments:   validates (payee exists? sufficient funds?)
                    returns needsConfirmation { to, amount, from, token }
        supervisor: sees needsConfirmation, stops delegating, asks the user
                    to confirm. Nothing has moved.

Turn 2  user:       "yes"
        supervisor: → make_payment { confirm: token }
        payments:   RE-VALIDATES, debits/credits, returns receipt
```

- `token` is a short opaque id for the pending action, held in conversation state.
- **Re-validation on confirm is mandatory.** Balances can change between turns, so the
  token references an intent and is never a pre-authorization.
- A bare `"yes"` with no pending token is rejected, not guessed at.

## Error Handling

All three kinds are returned as normal `AgentResult`s rather than thrown, so the
supervisor can explain them to the user:

| Kind | Handling |
| --- | --- |
| Validation failure (unknown payee, insufficient funds) | Returned as a `summary` explaining the problem |
| LLM / transport failure | Retried once, then a degraded summary |
| Unknown intent (no tool matches) | Supervisor answers directly or asks a clarifying question |

## Foundry Integration

### Responses protocol

`POST /responses` accepts an OpenAI Responses-shaped request and returns the same shape:

```
in:  { input, conversation?, stream? }
out: { id, object: "response",
       output: [{ type: "message", role: "assistant",
                  content: [{ type: "output_text", text }] }],
       usage }
```

Foundry manages conversation history for this protocol, so the server reads prior
messages off the request rather than storing them. `stream: true` returns an SSE stream
(see the amendment above).

`GET /health` returns 200 once the ledger is seeded and the model client holds a token.

### Model access

The container calls Foundry models through the injected `FOUNDRY_PROJECT_ENDPOINT`,
using the OpenAI Node SDK with an Entra token from `@azure/identity`
(`DefaultAzureCredential`: managed identity when deployed, `az login` locally). The
deployment name comes from `MODEL_DEPLOYMENT_NAME`.

### Container

Multi-stage build; `linux/amd64` pinned in the build script, not merely documented —
ARM images are not supported by Foundry hosted agents and this is a live trap on an
Apple Silicon Mac.

```dockerfile
FROM node:22-slim AS build     # npm ci, tsc
FROM node:22-slim              # prod deps + dist only
EXPOSE 8088
CMD ["node", "dist/server.js"]
```

Deploy path: `docker build --platform linux/amd64` → `az acr login` → `docker push` →
`agents.createVersion` with `containerConfiguration.image`.

Two prerequisites that block deployment if missed:

- The agent identity needs `AcrPull` (or Container Registry Repository Reader) on the registry.
- The deployer needs Foundry Project Manager at project scope to create agent versions.

### Tracing

OpenTelemetry Node SDK exporting to `APPLICATIONINSIGHTS_CONNECTION_STRING` (injected by
the platform). One span per delegation, carrying `gen_ai.*` attributes
(`gen_ai.agent.id`, `gen_ai.operation.name`, `gen_ai.request.model`).

The result is a single trace showing `supervisor → payments → confirm → commit` as a
nested waterfall in Application Insights. This deliberately mirrors the UI's trace pane,
so the local view and the cloud view teach the same shape.

**The UI's trace pane does not query Application Insights.** `GET /api/trace/:id` reads
from a small in-process ring buffer (last 20 conversations) that the supervisor writes
delegation records into as it runs. Two reasons: the UI must work locally with no App
Insights resource configured, and App Insights ingestion lag (tens of seconds) would make
a live demo feel broken. The ring buffer and the OTel spans are written from the same
call sites, so the two views cannot drift.

## The UI

`public/` — plain HTML, one JS file, one CSS file. No framework, no build step, no
dependencies.

**Scope note.** The Foundry gateway routes to protocol endpoints (`/responses`,
`/invocations`); a browser UI served from the container is not reachable through the
public agent URL. This is accepted rather than worked around:

- **Locally** (`docker run -p 8088:8088`) the UI is served at `/` and calls `/responses`
  same-origin. This is where the workshop demo happens.
- **Deployed** the same image runs and `/responses` works through the gateway; `/` is
  simply not publicly routed. The deployment lesson is unaffected.

Two panes plus a ledger strip:

```
┌─────────────────────────┬───────────────────────────┐
│  chat                   │  delegation trace         │
│                         │                           │
│  you: send £200 to      │  ▸ supervisor  (1.2s)     │
│       Alice             │    ▸ payments  (0.4s)     │
│  bot: Confirm £200 to   │      validated, pending   │
│       Alice from        │                           │
│       Current?          │  ── turn 2 ──             │
│  you: yes               │  ▸ supervisor  (0.9s)     │
│  bot: Sent. Receipt…    │    ▸ payments  (0.3s)     │
│                         │      committed £200       │
├─────────────────────────┴───────────────────────────┤
│  Current £1,240.00   Savings £8,500.00              │
└─────────────────────────────────────────────────────┘
```

The right pane is the point: it makes delegation legible in a way logs do not. The ledger
strip updates after each turn, which makes the confirmation gate visceral — balances
visibly do not move until confirmation.

## Fixtures

One `bank/bank.json`, loaded at startup into memory:

- Two accounts (Current, Savings) with opening balances.
- A short payee list (Alice, Bob, a credit card).
- A dozen recent transactions, for the balance agent to summarise.
- Three loan products with rates and eligibility rules.

## Testing

| Level | Coverage |
| --- | --- |
| Unit | Ledger operations: debit, credit, insufficient funds, unknown payee, re-validation |
| Unit | `toToolSchema` generation from the registry |
| Integration (mocked LLM) | Supervisor loop: single intent, multi-intent parallel dispatch, `MAX_TURNS` cap, unknown intent |
| Integration (mocked LLM) | Full confirmation flow, including the balance-changed-between-turns case and bare-`"yes"` rejection |
| Contract | `POST /responses` request/response shape; `stream: true` rejection; `GET /health` |
| Manual | Local UI end-to-end; deployed agent invoked through the Foundry gateway; trace visible in App Insights |

The LLM is mocked in all automated tests — tool-call sequences are fixtures. No test
requires Azure access or spends tokens. Deployment and tracing are verified manually,
once, as part of the workshop itself.

## Success Criteria

Slice one is done when:

1. ✅ `npm test` passes with no provider access required. **131 tests.**
2. ✅ `docker run -p 8088:8088` serves the UI; a full banking conversation works
   locally, including a payment that is confirmed and one that is refused.
3. ⬜ The image is deployed as a Foundry hosted agent version reaching `active`.
4. ⬜ The deployed agent answers correctly through its Responses endpoint.
5. ⬜ A delegation trace for a deployed conversation is visible in Application
   Insights, showing supervisor and specialist spans nested.
6. ✅ `README.md` documents the deploy path and the two prerequisite RBAC grants.

Items 3–5 require running `./scripts/deploy.sh` against a live Foundry project;
everything they depend on is built and locally verified.

## Amendment 2026-08-04 (later) — session management and state

Slice one originally listed "no persistence" and "no Foundry session filesystem"
as non-goals. Both were subsequently requested in full ("session management and
session states, everything Foundry offers") and are now implemented.

The Foundry docs were re-read at this point, which corrected two facts carried
from a month-old note: **Responses, Invocations, and Invocations WebSocket are GA
in all 31 hosted-agent regions** (only A2A is preview), and the earlier claim that
WebSocket was preview-limited was wrong.

### What was built

| Concern | Implementation |
| --- | --- |
| Session lifecycle | `active` / `idle` / `stopped` / resumed, 15-min idle timeout, 30-day max lifetime |
| State persistence | Per-session ledger, staged payments, pending confirmations and files under `$HOME`; atomic temp+rename writes |
| Session API | create (with concrete version pin), list, get, `:stop`, delete |
| File API | upload (50 MB cap), list, download, delete, with traversal rejection |
| Conversations | create/get/delete, `previous_response_id` chaining, conversation→session auto-binding |
| Isolation keys | Header scheme, caller scoped to own sessions, `all=true` cross-user view |

### The correction that mattered most

The original design **conflated session and conversation** — it used a single
`conversation` id for both the sandbox and the message history. Foundry treats
them as independent:

- `agent_session_id` is the sandbox and its filesystem. Reusing it does **not**
  replay messages.
- `conversation` is message history, and binds a stable session as a convenience.
- `previous_response_id` chains turns for stateless clients.

They are also read from different places — body for Responses, **query string** for
Invocations, where body fields and headers are passed through but must not affect
routing. Getting this wrong is the most common failure against this API, so the
separation is now enforced by types and covered by tests that assert a shared
session does *not* leak history.

### Decision recorded: the ledger persists per session

The user did not specify whether the bank state or only conversation state should
persist. Chosen: **the ledger persists**, because a bank whose balances reset on
restart undercuts the stateful-agent lesson, and `/api/demo/reset` already exists
as the escape hatch. Consequence: two sessions have genuinely separate money, which
is also the more realistic model.

### Verified live

Against the real model (`gpt-4o-mini`), and separately in Chromium:

- Staged a payment, **deprovisioned the sandbox mid-payment**, then confirmed —
  committed correctly with the fund reservation intact and `resumes` incremented.
- **Killed the server process entirely** and restarted: balance, uploaded file,
  conversation history, and the conversation→session binding all survived.
- A second session's balances were unaffected throughout.

## Implementation Notes (added 2026-08-04)

Defects found during implementation and testing, recorded because each changed the
design rather than just the code:

**Funds were not reserved at stage time.** Two payments staged back to back each
validated against the full balance and could jointly overdraw the account — it
reached −£160 in the demo path. `stagePayment` now reserves against
`availableMinor` (leaving `balanceMinor` untouched); commit releases the
reservation before re-validating so it is not double-counted; cancel and expiry
release it so funds are never stranded.

**`applyExternalDebit` was added.** With reservations in place, the common
overlapping-payments scenario can no longer reach the commit-time check — so
demonstrating why re-validation matters needed a way to move a balance the
assistant did not cause. This is also the workshop's hook for showing a refused
confirmation.

**Specialist spans rendered at the wrong depth.** Agents received the same tracer
as their delegation wrapper, so `payments.stage` appeared as a sibling of
`delegate.payments` rather than nested inside it. Agents now get a child tracer.

**Confirmation tokens leaked into customer-facing replies.** The specialist's
`summary` names the token so the supervising model can replay it, and a model that
echoes its tool output verbatim put `confirm="pend-1-..."` in front of the user.
Fixed at three levels: `AgentResult.customerSafe` carries wording safe to display,
the system prompt forbids echoing tokens, and `redactTokens()` is a hard guard at
the supervisor's exit. The guard is not redundant — prompt rules are advisory.

**Streaming is chunk-level, not token-level.** The reply is produced whole then
split into SSE deltas. Real token streaming requires streaming the supervisor's
final model call, which is deferred and noted in the README.

## Later Slices — Not Now

Recorded so slice one does not design for them speculatively:

1. **Split to four deployments.** Introduce `AgentTransport` with `InProcess` and
   `Remote` (A2A) implementations. Same agent code, four Entra identities. The punchline
   is that only configuration changes.
2. **Nested delegation.** Add an `advisor` agent that delegates to `balance` and `loans`.
   Cut from slice one because two levels of trace and failure is a materially harder
   mental model.
3. **SSE streaming** on `/responses`.
4. **Session persistence** using Foundry's `$HOME` / `/files`, so the ledger survives
   compute deprovisioning.
5. **A second orchestration strategy** (graph/DAG) over a shared kernel — the point at
   which the "generalistic" runtime abstraction can be designed honestly, from two
   working implementations rather than one hypothesis.
