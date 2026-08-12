# Runbook — running with a real LLM

Every command below was executed and verified. Where behaviour is
non-deterministic, that is stated rather than glossed over.

---

## 0. Prerequisites

- Docker Desktop running
- An `OPENAI_API_KEY` in `.env` at the repo root

```bash
cd /Users/SaiKumar.Shetty/Documents/abl/foundry-orchestration-lab
cat .env          # should contain OPENAI_API_KEY=sk-... and OPENAI_MODEL=gpt-4o-mini
```

Costs pennies per session on `gpt-4o-mini`. Each turn is 2–4 model calls.

---

## 1. Start it

### Option A — Docker (recommended for a demo)

```bash
# clear anything already on the port
docker rm -f folab 2>/dev/null
lsof -ti:8088 | xargs kill -9 2>/dev/null

docker volume create folab-home            # once; persists session state
docker run -d --name folab -p 8088:8088 \
  --env-file .env \
  -v folab-home:/home/node/.agent-state \
  foundry-orchestration-lab:latest

docker logs folab                          # confirm the provider line
```

Expect:

```
banking supervisor listening on :8088
  provider   OpenAI API (gpt-4o-mini)     <-- NOT "OFFLINE MODE"
```

If it says **OFFLINE MODE**, the key was not passed — check `--env-file .env`.

### Option B — from source (better for editing prompts live)

```bash
npm install        # first time only
npm run dev        # tsx, watches for changes, loads .env automatically
```

Open <http://localhost:8088>

---

## 2. Confirm it is healthy before demoing

```bash
curl -s localhost:8088/health | python3 -m json.tool
```

Want to see: `"status": "ok"` and `"durability": "ok"`.

`durability: degraded` means the state volume is not writable — the agent still
answers, but nothing survives a restart. Check the `-v` flag.

---

## 3. The demo sequence

Type these in the UI. **Reliable** ones are safe to demo cold; **variable** ones
depend on how the model phrases things.

| # | Say | Shows | Reliable? |
| --- | --- | --- | --- |
| 1 | `What's my balance?` | one specialist called | ✅ |
| 2 | `What's my balance and can I borrow £5,000 over 3 years?` | **two specialists in parallel** — the trace bars overlap | ✅ |
| 3 | `Send £200 to Alice` | staged, not sent. Balance holds £1,240, *available* drops to £1,040 | ✅ |
| 4 | `yes` | committed, with a receipt reference | ✅ |
| 5 | `proceed with the personal loan` then `yes` | the same confirmation gate on a **second** agent, ending in an `APP…` reference | ✅ |
| 6 | `What is my total balance in euros?` | the **FX tool over HTTP** | ⚠️ see below |

**⚠️ On the FX demo.** The tool always converts correctly (£9,740 → €11,395.80 at
1.17) and the trace proves it fired. But the *model* sometimes reports only the
sterling total and omits the euro figure — roughly 1 run in 3. The numbers are
never wrong, occasionally incomplete. If you want a guaranteed FX demo, call the
tool directly instead:

```bash
curl -s -X POST localhost:8088/tools/fx/convert \
  -H 'Content-Type: application/json' \
  -d '{"amountMinor":974000,"from":"GBP","to":"EUR"}'
```

---

## 4. The two demos worth building the session around

### Stateful resume — survives the sandbox being destroyed

1. `Send £200 to Alice` — note *available* drops to £1,040 while the balance holds
2. Click **deprovision (idle)** — status goes `idle`; compute is gone, `$HOME` kept
3. `yes` — it commits. **RESUMES** ticks to 1

The pending confirmation and its fund reservation survived a full teardown. This is
exactly what Foundry does at its 15-minute idle timeout.

Harder version, if you want to prove it properly:

```bash
docker rm -f folab                          # destroy the container outright
docker run -d --name folab -p 8088:8088 --env-file .env \
  -v folab-home:/home/node/.agent-state foundry-orchestration-lab:latest
```

Same balance, same pending payment. Omit the `-v` and it is all gone — which is
itself the lesson.

### Graceful degradation — a broken tool must not invent a figure

```bash
curl -X POST localhost:8088/tools/fx/_mode \
  -H 'Content-Type: application/json' -d '{"mode":"error"}'
```

Ask for euros. It says it cannot convert; it does **not** guess a rate. Restore:

```bash
curl -X POST localhost:8088/tools/fx/_mode \
  -H 'Content-Type: application/json' -d '{"mode":"none"}'
```

Also available: `{"mode":"hang"}` on the FX tool (triggers the 2s client timeout),
and `POST /mcp/_mode` with `error` for the credit tool.

---

## 5. What to point at in the UI

- **Session bar** — `agent_session_id` and `conversation` side by side. Two
  different things: session = sandbox + files, conversation = message history.
  Reusing a session does **not** replay the chat.
- **sessions…** — every session with status, isolation key, resumes, disk use.
  The conversations table shows each one's **bound session**.
- **acting as** (top right) — switch caller; the other user's sessions vanish.
- **Delegation trace** — bars offset by start time, so parallel work visibly
  overlaps. Durations alone would imply sequence. **Click a step** for its
  `gen_ai.*` attributes.
- **Ledger strip** — shows *available* separately when funds are reserved.

---

## 6. Reset between runs

```bash
# fresh ledger, same container
curl -X POST localhost:8088/api/demo/reset \
  -H 'Content-Type: application/json' -d '{}'

# or wipe all persisted state
docker rm -f folab && docker volume rm folab-home && docker volume create folab-home
```

In the UI: **Reset** deletes the session and conversation; **new session** starts a
fresh pair leaving the old on disk.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Logs say **OFFLINE MODE** | Key not passed. Check `--env-file .env` |
| `durability: degraded` | State volume unwritable. Check the `-v` mount |
| `EADDRINUSE` / port busy | `lsof -ti:8088 \| xargs kill -9` |
| UI shows stale behaviour | Hard reload — **Cmd+Shift+R**. Browsers cache `app.js` |
| Old session ids after a restart | Expected. The UI probes the server and starts fresh if the session is gone |
| `platform mismatch` warning | Expected on Apple Silicon. `linux/amd64` is mandatory for Foundry; emulation is fine |
| Agent asks the same thing twice | Model variance. Rephrase, or use the quick buttons |

---

## 8. Stop it

```bash
docker rm -f folab                 # container
docker volume rm folab-home        # and its state, if you want it gone
```

---

## Deployment

This project has been **deployed and verified on Microsoft Foundry** as a hosted
agent. See `DEPLOYMENT.md` for the full walkthrough — container build, `azd`
deployment, RBAC, MongoDB integration, and OTel tracing.

Note that roughly half of what runs locally (session APIs, protocol surfaces,
the MCP server) is scaffolding the platform replaces. What transfers to
production is the supervisor loop, the agent contract, the MCP **client**, and
the guard patterns.
