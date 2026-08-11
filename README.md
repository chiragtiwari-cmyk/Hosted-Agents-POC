# Foundry Orchestration Lab

An R&D runtime for **LLM multi-agent orchestration**, built to be deployed as a
**Microsoft Foundry hosted agent**. Written as a workshop vehicle: the point is to
understand hosted agents by building and deploying a real multi-agent system on
them, not to read about them.

The domain is a **simulated retail bank** — balances, payments, loans. No real
financial data, no third-party banking APIs, fixtures only.

```
                        ┌─────────────────────────┐
   POST /responses ────►│      supervisor         │   decides who to ask,
   POST /invocations    │  (the LLM is scheduler) │   merges the answers
   WS  /invocations_ws  └────┬───────┬───────┬────┘
                             ▼       ▼       ▼
                        balance  payments  loans     ← plain TS classes
                             └───────┴───────┘
                                     ▼
                     per-session Ledger, persisted to $HOME
                   (survives idle deprovision and process restart)
```

Delegation is an LLM tool-call. Each specialist is its own narrowly-instructed
call with typed ledger access. The supervisor is **never given a ledger handle** —
it only ever sees the summary strings specialists return, so the capability
boundary is structural rather than a convention.

## Quick start

No cloud account and no API key needed for the offline path:

```bash
npm install
npm run dev:offline      # http://localhost:8088 — deterministic stub model
```

That runs the entire stack — Express, SSE, WebSocket, UI, ledger, all three
agents — against a keyword-routing stub instead of a real model. The delegation
traces are genuine; only the routing decision is scripted. Use it to explore the
system, and for workshop attendees with no provider access.

With a real model:

```bash
cp .env.example .env     # add OPENAI_API_KEY
npm run dev              # same UI, real reasoning
```

```bash
npm test                 # 215 tests, no provider access, no token spend
npm run typecheck
```

## What the UI shows

A session bar, two panes, and a ledger strip:

| Region | Purpose |
| --- | --- |
| **Session bar** | `agent_session_id` and `conversation` side by side — the distinction made visible — plus live status, resume count, a files drawer, and the idle-deprovision control |
| **Sessions panel** (`sessions…`) | Table of every session: status, isolation key, resume count, idle countdown, disk use, with stop / delete / switch. Below it, conversations with their **bound session** and a history viewer. `show all callers` is the cross-user admin view |
| **Acting as** (top right) | Switches the isolation key. Other callers' sessions disappear from the list — the isolation lesson, live |
| **Conversation** | Chat, with voice input and optional spoken replies |
| **Delegation trace** | Live **waterfall** of `supervisor → specialist → internal step`, colour-coded per agent. Bars are offset by start time, so parallel specialists visibly overlap — durations alone would imply sequence and sum to more than the turn took |
| **Ledger strip** | Balances, updating per turn. Shows *available* separately when funds are reserved |

The trace pane is the point. It makes orchestration legible in a way logs do not,
and it mirrors the same nesting you then go and find in Application Insights — the
local view and the cloud view teach the same shape.

**Try this sequence**, which is the whole workshop in four messages:

1. `What's my balance?` — one specialist.
2. `What's my balance and can I borrow £5,000 over 3 years?` — two specialists
   dispatched **in parallel in one round**, merged into one reply.
3. `Send £200 to Alice` — staged, not sent. Balance holds at £1,240 but *available*
   drops to £1,040: the funds are reserved.
4. `yes` — committed. £1,040, receipt reference, reservation released.
5. `proceed with the personal loan` then `yes` — the same two-step gate on a
   second agent: staged, then submitted with an `APP…` reference that appears in
   the ledger strip.

Then the interesting one: after step 3, click **simulate £1,000 direct debit**
before saying `yes`. The confirmation is **refused** — the token references an
intent, never a pre-authorization, and funds are re-validated at commit time.

## Voice

Browser-side: Web Speech API `SpeechRecognition` for the microphone,
`speechSynthesis` for playback, transcripts over the WebSocket. No server-side
speech service, no extra credential, no per-minute cost.

Works in Chrome and Edge. **Firefox has no `SpeechRecognition`** — the mic button
disables itself and the UI stays fully usable by typing. Money figures are
rewritten before synthesis (`£1,240.00` → "1240 pounds") because the raw string
reads badly aloud.

## Sessions and conversations

This is the part most worth understanding, and the part people most often get
wrong. Foundry has **two** independent identifiers:

| | `agent_session_id` | `conversation` |
| --- | --- | --- |
| What it is | The sandbox and its persisted filesystem (`$HOME`, `/files`) | The durable record of messages, tool calls, and responses |
| Holds | This customer's ledger, staged payments, uploaded files | Chat history |
| Lifecycle | Idle-deprovisioned after 15 min, restored on next use, deleted after 30 days | Persists independently of compute |
| Managed by | The platform, via the `/sessions` API | The platform (Responses); your code (Invocations) |

**Reusing a session id does not replay message history.** That is what a
conversation id is for. Threading by conversation also binds a stable session, so
one id gets you both. The third option is `previous_response_id`, which chains
turns without any server-side conversation object.

Where the session id goes differs per protocol, and this trips people up:

| Protocol | Session id location |
| --- | --- |
| Responses | request **body** field `agent_session_id` (or use `conversation`, which auto-binds) |
| Invocations | **query string** `?agent_session_id=…` |

For Invocations the platform reads the query parameter *only* — body fields and an
`x-agent-session-id` header reach your container untouched but do not affect which
sandbox serves the call. This runtime reproduces that exactly.

### What persists

Everything the customer would be upset to lose:

- The **ledger** — balances and transaction history, per session.
- **Staged payments and their fund reservations** — a session deprovisioned
  mid-payment resumes with the confirmation still outstanding and the money still
  held.
- **Uploaded files**, under `$HOME`.
- **Conversation history**.

Writes are atomic (temp file + rename) because a sandbox can be torn down
mid-request, and a half-written `state.json` would lose someone's ledger. A
corrupt or schema-mismatched state file fails loudly rather than silently
resetting to fixtures.

### Try it

The demo that makes this concrete, in four steps:

1. `Send £200 to Alice` — staged. Balance holds at £1,240; *available* drops to
   £1,040. The reservation is real.
2. Click **deprovision (idle)** — simulates the 15-minute timeout. Status goes
   `idle`; compute is gone, `$HOME` is kept.
3. `yes` — the sandbox is restored from disk and the payment commits. **RESUMES**
   ticks to 1.
4. Reload the browser, or restart the server entirely. Same balance, same files,
   same history.

Step 3 is the one worth pausing on: the confirmation token and its fund
reservation both survived a full sandbox teardown.

## Tools: HTTP and MCP

Every specialist so far has been in-process TypeScript, which hides what actually
bites in production — latency, timeouts, partial failure. Two tools now sit behind
a real network boundary:

| Tool | Transport | Called by | Endpoint |
| --- | --- | --- | --- |
| `fx.convert` | plain HTTP REST | `balance`, when asked for another currency | `POST /tools/fx/convert` |
| `credit.score` | **MCP** (JSON-RPC) | `loans`, during quoting | `POST /mcp` |

Both are hosted in this same Express app, but agents reach them over the loopback
network via `fetch` — so a timeout is a real timeout.

**Why MCP matters, and the caveat.** Foundry does **not** let you attach tools to a
hosted agent's definition; the docs are explicit that this is unsupported. Agents
reach Foundry-managed tools (Code Interpreter, Web Search, Azure AI Search, custom
connections) by connecting to a **Toolbox MCP endpoint** as an MCP *client*. So the
transferable lesson here is the **client** side — `src/tools/clients.ts`. Our `/mcp`
route is a stand-in for Toolbox; on Foundry you would point the client at the
project's Toolbox endpoint and delete the server.

The MCP server is hand-written (`initialize` / `tools/list` / `tools/call`, with
correct JSON-RPC error codes) for the same reason the Responses protocol is: the
wire format should be visible, not hidden behind an SDK.

```bash
curl -X POST localhost:8088/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Two rules the tool clients enforce

1. **A tool failure never throws into the agent.** It returns `{ok: false}` with a
   reason, so the agent explains what it could not do instead of losing the turn.
2. **A failed tool never yields a figure.** Degrading means saying less, not
   guessing — an invented exchange rate reads as authoritative.

Try it: ask `what is my total balance in euros?`, then break the tool and ask again.

```bash
curl -X POST localhost:8088/tools/fx/_mode -d '{"mode":"error"}' -H 'Content-Type: application/json'
curl -X POST localhost:8088/mcp/_mode     -d '{"mode":"error"}' -H 'Content-Type: application/json'
```

The reply drops to sterling and says the conversion is unavailable. The trace shows
the failed call with its reason, and `[http]` / `[mcp]` tags distinguish transports.

## API surface

Protocol endpoints (what the Foundry gateway calls):

| Endpoint | Protocol | Notes |
| --- | --- | --- |
| `POST /responses` | Responses | `stream: true` gives SSE. Accepts `agent_session_id`, `conversation`, `previous_response_id`; echoes the session back |
| `POST /invocations` | Invocations | Session from the query string. Returns `session_id` and `invocation_id` |
| `GET /invocations_ws` | WebSocket | Bidirectional realtime; used by voice. Sticky session per connection |
| `GET /health` | — | Readiness gate for the Foundry gateway |

Session and conversation management:

| Endpoint | Notes |
| --- | --- |
| `POST /endpoint/sessions` | Create. Optional `version_indicator` pins a concrete agent version |
| `GET /endpoint/sessions` | List, scoped to the caller's isolation key. `?all=true` for the cross-user view |
| `GET /endpoint/sessions/:id` | Status, resume count, disk usage, idle countdown |
| `POST /endpoint/sessions/:id:stop` | Stop compute, keep the volume. Idempotent |
| `DELETE /endpoint/sessions/:id` | Delete session and volume |
| `PUT /endpoint/sessions/:id/files/content?path=` | Upload (50 MB cap) |
| `GET /endpoint/sessions/:id/files?path=` | List |
| `GET /endpoint/sessions/:id/files/content?path=` | Download |
| `DELETE /endpoint/sessions/:id/files?path=` | Delete |
| `POST /endpoint/protocols/openai/conversations` | Create a conversation, binding a stable session |
| `GET`/`DELETE .../conversations/:id` | Fetch with messages, or delete |

**Isolation keys.** Foundry offers two schemes: `Entra` (default) derives the key
from the caller's token; `Header` reads `x-ms-user-isolation-key`. This runtime
implements Header, defaulting to a shared partition when absent. The key is a
*partitioning* value, not authorization — real access control belongs above the
agent endpoint.

Local UI support (not gateway-routed):

| Endpoint | Notes |
| --- | --- |
| `GET /api/state?agent_session_id=` | Ledger snapshot. Note: acquires the session, so it reactivates it |
| `GET /api/trace/:id` | Delegation trace from the in-process ring buffer |
| `POST /api/demo/debit` | External debit, to force a refused confirmation |
| `POST /api/demo/deprovision` | Simulate the 15-minute idle timeout on demand |
| `POST /api/demo/reset` | Delete the session so the ledger reseeds |

The Responses protocol surface is **hand-written** (`src/protocol/responses.ts`).
Foundry's Python libraries hide it; writing it out is deliberate so the workshop
can see exactly what the platform expects.

SSE emits the standard `response.created` / `response.output_text.delta` /
`response.completed` events, plus a custom **`delegation.step`** event carrying
trace steps so the UI draws the tree live instead of polling afterwards.

```bash
curl -N -X POST localhost:8088/responses -H 'Content-Type: application/json' \
  -d '{"input":"what is my balance?","stream":true}'
```

## Model providers

Chosen by environment; `OPENAI_API_KEY` wins when present.

| Set | Provider | Auth |
| --- | --- | --- |
| `OPENAI_API_KEY` (+ `OPENAI_MODEL`) | OpenAI API | API key |
| `FOUNDRY_PROJECT_ENDPOINT` + `MODEL_DEPLOYMENT_NAME` | Azure / Foundry models | `DefaultAzureCredential` — managed identity when deployed, `az login` locally |

**Worth knowing:** on the OpenAI path the container calls out to `api.openai.com`
with a secret, so the *dedicated Entra identity for model calls* property of
Foundry hosted agents is not exercised. If the workshop's goal includes that
property, use the Azure path.

## Deploying to Foundry

```bash
export ACR_NAME=myregistry
export FOUNDRY_PROJECT_ENDPOINT=https://<account>.services.ai.azure.com/api/projects/<project>
export OPENAI_API_KEY=sk-...        # or omit for the Azure model path
./scripts/deploy.sh
```

Two prerequisites block deployment if missed:

- **You** need **Foundry Project Manager** at project scope, to create agent versions.
- **The agent identity** needs **AcrPull** (or Container Registry Repository Reader)
  on the registry, or Foundry cannot pull the image.

`linux/amd64` is mandatory — ARM images are not supported and will deploy, then
fail to start. The platform flag is pinned in the build script and the Dockerfile
comment, not merely documented, because the default build on an Apple Silicon Mac
produces the wrong architecture.

### The UI is not reachable through the gateway

The Foundry gateway routes to protocol endpoints (`/responses`, `/invocations`).
A browser UI served from the container is **not** exposed on the public agent URL.
This is by design, not a limitation to work around:

- **Locally** (`docker run -p 8088:8088`) the UI is at `/` and calls `/responses`
  same-origin. This is where the workshop demo happens.
- **Deployed**, the same image runs and `/responses` works through the gateway;
  `/` simply is not routed. The deployment lesson is unaffected.

Protocol availability (checked against Microsoft Learn, 2026-08-04): **Responses,
Invocations, and Invocations WebSocket are available in every region that supports
hosted agents** — 31 regions at time of writing. Only **A2A** is still preview.
Earlier drafts of this README said WebSocket was preview-limited; that was stale.

## Tracing

Two sinks, written from the same call sites so they cannot drift:

1. An **in-process ring buffer** (last 20 conversations) that the UI reads. It must
   work with no App Insights resource configured, and App Insights ingestion lag
   (tens of seconds) would make a live demo look broken.
2. **OpenTelemetry spans** when `APPLICATIONINSIGHTS_CONNECTION_STRING` is present
   — Foundry injects it. Attributes follow the `gen_ai.*` convention so the Foundry
   portal's Traces tab renders them.

OTel initialisation is best-effort: a tracing problem must never take down the agent.

## Design notes worth knowing

**The confirmation gate.** Payments are two calls. The first validates and stages,
returning an opaque token; nothing moves. The second re-validates and commits.
Re-validation is the entire point — balances change between turns, so the token
references an intent and is never a pre-authorization.

**Funds are reserved at stage time.** Without this, two payments staged back to
back each validate against the full balance and can jointly overdraw the account.
`balanceMinor` is untouched while pending; `availableMinor` drops. Cancel and
expiry release the reservation, so funds are never stranded.

**Tokens never reach the customer.** The specialist's `summary` is written for the
supervisor and names the token so the model can replay it. `AgentResult.customerSafe`
carries wording safe to show, the system prompt forbids echoing tokens, and
`redactTokens()` is a hard guard at the supervisor's exit — prompt rules are
advisory, so the guard is not optional.

**`MAX_TURNS = 4` bounds loop iterations, not tool calls.** One round dispatching
three specialists in parallel is one turn. An unbounded LLM loop holding a
money-moving tool is not acceptable even in a sandbox.

**Money is integer minor units.** Never floats. Float arithmetic on currency
drifts.

**Adding a specialist** is one file plus one line in `src/agents/registry.ts`. Tool
schemas are generated from the registry, so the supervisor needs no change.

## What this slice deliberately does not do

Recorded so nobody assumes they are missing:

- **No A2A, no per-agent Entra identity.** One deployment means one identity. The
  four agents run in one process. A2A is also still preview on the platform.
- **No nested delegation** (agent calling agent). Two levels of trace and failure
  is a materially harder mental model; it is the natural next exercise.
- **No token-level streaming.** The reply is produced whole, then chunked into SSE
  deltas. Real token streaming needs the supervisor's final call streamed too.
- **No Foundry Toolbox integration.** Hosted agents reach Foundry-managed tools
  (Code Interpreter, Web Search, Azure AI Search, MCP connections) through a
  Toolbox MCP endpoint. Adding tools to an agent definition directly is not
  supported by the platform; our specialists are in-process instead.
- **Sessions are not garbage-collected on a timer.** `purgeExpired()` exists and is
  tested, but nothing schedules it — the platform does this for you when deployed.

### Next slices

1. **Split to four deployments.** Introduce `AgentTransport` with `InProcess` and
   `Remote` (A2A) implementations. Same agent code, four Entra identities. The
   punchline is that only configuration changes.
2. **Nested delegation** — add an `advisor` that delegates to `balance` and `loans`.
3. **Token-level streaming** on `/responses`.
4. **Toolbox MCP client**, so a specialist can call a Foundry-managed tool.
5. **A second orchestration strategy** (graph/DAG) over a shared kernel — the point
   at which a "generalistic" runtime abstraction can be designed honestly, from two
   working implementations rather than one hypothesis.

## Layout

```
src/
  server.ts              entrypoint (real providers)
  dev-server.ts          offline entrypoint (stub model)
  app.ts                 Express app, protocol routes, shared runTurn
  supervisor.ts          the loop, dispatch, redaction
  llm.ts                 provider clients + retry
  trace.ts               ring buffer + OTel
  session/
    manager.ts           session lifecycle: acquire, stop, delete, idle/resume
    storage.ts           $HOME-backed persistence, atomic writes, file API
    conversations.ts     message history, previous_response_id chaining
    routes.ts            /endpoint/sessions + /files + /conversations
  agents/
    types.ts             the Agent contract — the seam
    registry.ts          the list; tool schemas derive from it
    balance.ts payments.ts loans.ts
  bank/
    ledger.ts bank.json
  protocol/
    responses.ts         hand-written Responses protocol + SSE framing
    websocket.ts         /invocations_ws
public/                  UI: index.html, app.js, style.css
docs/superpowers/specs/  design document
scripts/deploy.sh
```

The design document in `docs/superpowers/specs/` records the decisions and the
reasoning behind them, including what was cut and why.
