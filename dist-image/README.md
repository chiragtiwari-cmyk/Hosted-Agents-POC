# Kore.ai Multi-Agent Orchestration Lab — container image

A runnable multi-agent orchestration runtime, built to be deployed as a Microsoft
Foundry hosted agent. Simulated retail bank: balances, payments, loans.

## Run it (2 commands, no account, no API key)

```bash
gunzip -c folab-image.tar.gz | docker load
docker run --rm -p 8088:8088 foundry-orchestration-lab:latest
```

Open <http://localhost:8088>

It starts in **offline mode** — a deterministic stub stands in for the model, so
nothing is sent anywhere and no key is needed. Everything else is real: the
supervisor loop, all three agents, the ledger, sessions, tools and tracing.
Only the model's routing decision is keyword-matched rather than reasoned.

## With a real model

```bash
docker run --rm -p 8088:8088 -e OPENAI_API_KEY=sk-... foundry-orchestration-lab:latest
```

Now the routing decisions are genuinely reasoned. Costs a few cents in tokens.

## Keep state across restarts

Session state lives under `$HOME`, which is what Foundry persists across its
15-minute idle deprovisioning. Locally, mount a volume to get the same behaviour:

```bash
docker run --rm -p 8088:8088 \
  -v folab-home:/home/node/.agent-state \
  foundry-orchestration-lab:latest
```

Without the volume, state dies with the container — which is itself worth seeing.

## What to try

Five messages that cover the whole workshop:

1. `What's my balance?` — one specialist called
2. `What's my balance and can I borrow £5,000 over 3 years?` — **two specialists in
   parallel**; the trace pane shows their bars overlapping
3. `What is my total balance in euros?` — calls the **FX tool over HTTP**
4. `Send £200 to Alice` — staged, not sent. The balance holds at £1,240 while
   *available* drops to £1,040: the funds are reserved
5. `yes` — committed, with a receipt reference

Then the two that teach the most:

**Stateful resume.** After step 4, click **deprovision (idle)**, then say `yes`.
The sandbox was torn down and rebuilt, yet the pending payment survived and
commits. `RESUMES` ticks to 1.

**Graceful degradation.** Break a tool and ask again — the agent says it can't
convert rather than inventing a rate:

```bash
curl -X POST localhost:8088/tools/fx/_mode \
  -H 'Content-Type: application/json' -d '{"mode":"error"}'
```

## What the UI shows

| Region | Purpose |
| --- | --- |
| **Session bar** | `agent_session_id` and `conversation` side by side — two different things |
| **Sessions panel** | Every session: status, isolation key, resumes, disk. Stop, delete, switch |
| **Delegation trace** | Waterfall of supervisor → specialist → tool. Bars offset by start time, so parallel work visibly overlaps. Click a step for its attributes |
| **Ledger strip** | Balances, updating per turn. Shows *available* separately when funds are reserved |

## Endpoints

| Endpoint | Notes |
| --- | --- |
| `POST /responses` | Foundry's Responses protocol. `stream: true` for SSE |
| `POST /invocations` | Session id goes in the **query string**, not the body |
| `GET /invocations_ws` | WebSocket, used by voice |
| `GET /readiness` | Foundry's platform health probe |
| `POST /tools/fx/convert` | HTTP tool |
| `POST /mcp` | MCP server (JSON-RPC): `initialize`, `tools/list`, `tools/call` |

## Notes

- **Simulated bank.** No real financial data, no third-party banking APIs. Fixtures only.
- **`linux/amd64`.** Runs on Apple Silicon via emulation, with a platform warning
  that is safe to ignore. The architecture is mandatory for Foundry.
- **No credentials in the image.** Verified — nothing is baked in.
- **Never deployed to Foundry.** This implements Foundry's contracts and reproduces
  its session semantics locally; it has not been run on the platform itself.
