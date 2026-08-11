# Deployment Guide — Foundry Hosted Agent POC

This document records every step, decision, gotcha, and fix encountered while
deploying this multi-agent TypeScript application as a **Microsoft Foundry
Hosted Agent**. Written so the next person can follow the path without hitting
the same walls.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Project Setup](#2-project-setup)
3. [Local Development](#3-local-development)
4. [Container Build & Push](#4-container-build--push)
5. [Deploying with azd](#5-deploying-with-azd)
6. [RBAC — Granting Model Access](#6-rbac--granting-model-access)
7. [MongoDB Integration](#7-mongodb-integration)
8. [Tracing & Observability](#8-tracing--observability)
9. [Invoking the Agent](#9-invoking-the-agent)
10. [Gotchas & Fixes](#10-gotchas--fixes)
11. [Architecture](#11-architecture)

---

## 1. Prerequisites

| Tool | Version | Purpose |
| --- | --- | --- |
| Node.js | ≥ 22 | Runtime |
| Docker | Any recent | Build `linux/amd64` images |
| Azure CLI (`az`) | Latest | Auth, role assignments |
| Azure Developer CLI (`azd`) | Latest | Deploy to Foundry |
| Docker Hub account | — | Public image hosting (bypasses ACR policy issues) |

You also need:
- A **Foundry project** with a model deployment (we used `gpt-5`)
- `az login` completed (for `DefaultAzureCredential` locally)

---

## 2. Project Setup

```bash
git clone https://github.com/chiragtiwari-cmyk/Hosted-Agents-POC.git
cd Hosted-Agents-POC
npm install
```

Create `.env` from the example:

```bash
cp .env.example .env
```

Edit `.env`:

```env
FOUNDRY_PROJECT_ENDPOINT=https://<your-resource>.services.ai.azure.com/api/projects/<your-project>
MODEL_DEPLOYMENT_NAME=gpt-5
AZURE_OPENAI_API_VERSION=v1
PORT=8088
MONGO_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=<app>
```

> **Finding your project endpoint:** In the Foundry portal, go to your project's
> settings page. The endpoint looks like
> `https://<resource>.services.ai.azure.com/api/projects/<project>`.

---

## 3. Local Development

```bash
npx tsx --env-file-if-exists=.env src/server.ts
```

> **Do not use `npm run dev`** — the `tsx watch` command can fail with
> `ERR_MODULE_NOT_FOUND` on some setups. The command above runs without watch
> mode.

Verify:

```bash
curl -s localhost:8088/health | python3 -m json.tool
curl -s localhost:8088/api/mongo-status | python3 -m json.tool
```

Kill a stuck process: `lsof -ti :8088 | xargs kill -9`

---

## 4. Container Build & Push

### Why Docker Hub instead of ACR

Our organization's Azure policy blocks public network access on Container
Registries:

> `(RequestDisallowedByPolicy) Resource was disallowed by policy. Reasons:
> 'Public network access should be disabled for Container registries'.`

Even a Premium SKU ACR with public access disabled breaks `az acr build`
because the build agents can't reach the registry. **Docker Hub** works as a
drop-in replacement — Foundry pulls from any public registry.

### Build & Push

```bash
docker build --platform linux/amd64 -t <your-dockerhub>/foundry-orchestration-lab:v7 .
docker push <your-dockerhub>/foundry-orchestration-lab:v7
```

> **`linux/amd64` is mandatory.** ARM images deploy but fail to start. The
> Dockerfile pins the platform, but always pass `--platform linux/amd64`
> explicitly when building on Apple Silicon or ARM machines.

---

## 5. Deploying with azd

### azure.yaml

Create an `azure.yaml` in a separate directory (not inside the source tree):

```yaml
name: banking-supervisor-v2
services:
    agentplatform_poc:
        host: azure.ai.project
        endpoint: https://<resource>.services.ai.azure.com/api/projects/<project>
    banking-supervisor-v2:
        project: src/banking-supervisor-v2
        host: azure.ai.agent
        language: docker
        image: docker.io/<your-dockerhub>/foundry-orchestration-lab:v7
        docker:
            remoteBuild: true
        uses:
            - agentplatform_poc
        env:
            MODEL_DEPLOYMENT_NAME: gpt-5
            SESSION_STATE_DIR: /tmp/agent-state
            MONGO_URI: ${MONGO_URI}
        container:
            resources:
                cpu: "1"
                memory: 2Gi
        description: Banking supervisor with full trace content
        kind: hosted
        name: banking-supervisor-v2
        protocols:
            - protocol: responses
              version: 2.0.0
infra:
    provider: microsoft.foundry
```

### Setting secrets

```bash
azd env set MONGO_URI "mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=<app>"
```

The `${MONGO_URI}` in `azure.yaml` resolves from the `azd` environment at
deploy time. The actual value is **never** baked into the image or committed.

### Deploy

```bash
azd deploy
```

This creates/updates the agent, pulls the Docker image, provisions compute, and
registers environment variables. Typical deploy time: 45–90 seconds.

### Key azure.yaml lessons learned

| Issue | Fix |
| --- | --- |
| `env` must be a sibling of `container`, not nested inside it | YAML indentation matters — `env` at the service level |
| `SESSION_STATE_DIR: /tmp/agent-state` is required | The default `$HOME/.agent-state` path is owned by root in the Foundry container; `/tmp` is writable |
| Changing `description` forces a new version | Useful when you need to redeploy without changing the image tag |
| Don't redeclare platform-injected vars | `FOUNDRY_PROJECT_ENDPOINT`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `FOUNDRY_AGENT_SESSION_ID` are injected automatically |

---

## 6. RBAC — Granting Model Access

After deploying, the agent gets a **managed identity**. It needs permission to
call models in your Foundry project.

### The error

```
401 Principal does not have access to API/Operation.
```

### The fix

1. Get the agent's principal ID:

   ```bash
   azd ai agent show banking-supervisor-v2
   # Look for: Instance Identity Principal ID
   ```

2. Go to **Azure Portal** → your Cognitive Services resource (e.g.
   `agentplatform-poc-resource`) → **Access control (IAM)** → **Add role
   assignment**

3. Assign the **"Foundry User"** role to the principal ID from step 1.

> **Why can't `az` do this?** Our organization has ABAC policies that block CLI
> role assignments. The portal works because it handles the conditions
> automatically.

> **Important:** Each `azd deploy` can create a new managed identity. Always
> verify the principal ID after deploying and re-assign the role if it changed.

---

## 7. MongoDB Integration

### What was done

- Added `mongodb` npm dependency
- Created `src/mongo.ts` — singleton client, lazy connection to `foundry_agent`
  database
- Added `persistTurn()` call in `app.ts` `runTurn` — fire-and-forget after
  every successful conversation turn
- Added `/api/mongo-status` health-check endpoint

### How secrets flow

```
.env (local dev) ──► process.env.MONGO_URI ──► MongoClient
azd env set      ──► ${MONGO_URI} in azure.yaml ──► container env var ──► process.env.MONGO_URI
```

The connection string is **never** in the source code, Docker image, or
`azure.yaml`.

### MongoDB Atlas setup notes

- **Network access:** Add `0.0.0.0/0` to the Atlas IP allowlist so the Foundry
  container (whose IP is dynamic) can connect.
- **Data stored:** Each turn saves `userMessage`, `assistantReply`,
  `delegations`, `agentSessionId`, `conversationId`, `responseId`, and
  `timestamp` to the `turns` collection.

### Verifying

```bash
# Locally
curl -s localhost:8088/api/mongo-status

# The /api/mongo-status endpoint is NOT reachable through the Foundry gateway.
# The gateway only proxies protocol routes (/responses, /invocations).
# To verify on the deployed agent, query MongoDB directly.
```

---

## 8. Tracing & Observability

### How Foundry tracing works

Foundry has two layers of tracing:

1. **Server-side (automatic):** Foundry emits an `invoke_agent` span for every
   request. This requires an **Application Insights** resource linked to your
   project. No code needed — it just works.

2. **Client-side (your code):** Your container emits OpenTelemetry spans for
   internal operations (supervisor loop, specialist delegations, LLM calls).
   These appear as **children** of the `invoke_agent` span.

### What Foundry injects

The platform auto-injects `APPLICATIONINSIGHTS_CONNECTION_STRING` as an
environment variable into your container. You do **not** need to set it in
`azure.yaml`.

### What we had to do for a custom TypeScript container

The official Python/Node SDKs (`azure-ai-agentserver-responses`) handle tracing
automatically. Since this is a custom Express server, we had to wire it up
manually:

1. **Install Azure Monitor OTel exporter:**

   ```bash
   npm install @azure/monitor-opentelemetry-exporter @opentelemetry/sdk-trace-node \
     @opentelemetry/resources @opentelemetry/semantic-conventions
   ```

2. **Update `src/trace.ts`** — `createOtelExporter()` now:
   - Creates a `NodeTracerProvider` with `AzureMonitorTraceExporter`
   - Uses `spanProcessors` array in the constructor (not the deprecated
     `addSpanProcessor` method)
   - Uses `resourceFromAttributes()` (not the deprecated `new Resource()`)
   - Implements `activateIncomingContext(traceparent)` to parse the W3C
     `traceparent` header and create child spans under the platform's parent

3. **Update `src/app.ts`** — The `/responses` route extracts the `traceparent`
   header from the incoming request and passes it through to `runTurn`, which
   calls `activateIncomingContext` before creating spans.

4. **Update `src/supervisor.ts`** — Added `gen_ai.prompt` and
   `gen_ai.completion` attributes to spans so the actual user message and AI
   response text appear in the trace metadata.

### Verifying traces

```bash
# Check startup logs — should say "OpenTelemetry → App Insights"
azd ai agent monitor banking-supervisor-v2

# Invoke the agent
azd ai agent invoke banking-supervisor-v2 "What is my balance?"

# Wait 2-3 minutes for App Insights ingestion, then check:
# Foundry portal → your agent → Operate → Traces
# You should see invoke_agent with child spans: supervisor.plan, delegate.balance, etc.
```

### Key tracing lessons

| Issue | Root cause | Fix |
| --- | --- | --- |
| `tracing: ring buffer only` | `APPLICATIONINSIGHTS_CONNECTION_STRING` not set | Link App Insights to your Foundry project; the platform injects it |
| `provider.addSpanProcessor is not a function` | Newer `@opentelemetry/sdk-trace-node` removed this method | Use `spanProcessors: [...]` in the `NodeTracerProvider` constructor |
| `new Resource()` doesn't exist | Newer `@opentelemetry/resources` API | Use `resourceFromAttributes()` |
| Child spans appear as separate traces | No trace context propagation | Extract `traceparent` header from request, use `trace.setSpanContext()` |
| Spans have metadata but no text | Attributes added via `note()` weren't reaching OTel spans | Added `setAttributes()` to the span wrapper, called from `note()` |

---

## 9. Invoking the Agent

### Via azd CLI

```bash
azd ai agent invoke banking-supervisor-v2 "What is my balance?"
```

### Via curl

```bash
TOKEN=$(az account get-access-token --resource "https://cognitiveservices.azure.com" --query accessToken -o tsv)

curl -X POST \
  "https://<resource>.services.ai.azure.com/api/projects/<project>/agents/banking-supervisor-v2/endpoint/protocols/openai/responses?api-version=v1" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"What is my balance?"}'
```

### Via Foundry Playground

The `azd deploy` output includes a playground URL. Open it in a browser to chat
with the agent directly.

---

## 10. Gotchas & Fixes

A chronological log of every issue encountered during this POC.

### API compatibility (GPT-5)

| Error | Fix |
| --- | --- |
| `400 api-version=v1 is not allowed. Use /v1 path instead.` | The new API uses `/openai/v1` in the URL path, not `api-version` as a query param. Switched from `AzureOpenAI` to standard `OpenAI` client with custom `fetch` and `baseURL` |
| `400 Unsupported parameter: 'max_tokens'` | GPT-5 requires `max_completion_tokens` instead of `max_tokens` |
| `400 Unsupported value: 'temperature' does not support 0.2` | GPT-5 only supports the default temperature (1). Removed the parameter |

### Container issues

| Error | Fix |
| --- | --- |
| ACR `RequestDisallowedByPolicy` | Organization policy blocks public ACR. Used Docker Hub instead |
| `EACCES: permission denied, mkdir '/home/session/.agent-state'` | Foundry container runs with a different user. Set `SESSION_STATE_DIR=/tmp/agent-state` |
| `listen EADDRINUSE: address already in use :::8088` | Kill previous process: `lsof -ti :8088 \| xargs kill -9` |

### Auth & RBAC

| Error | Fix |
| --- | --- |
| `401 Principal does not have access to API/Operation.` | Agent's managed identity needs "Foundry User" role on the Cognitive Services resource. Assign via Azure Portal |
| `403` when calling agent endpoint via curl | Caller's identity also needs appropriate permissions. Use `azd ai agent invoke` instead |
| Role assignment via CLI fails | Organization ABAC policies block it. Use the Azure Portal UI |

### Deployment

| Issue | Fix |
| --- | --- |
| `azd deploy` doesn't pick up new role assignment | Change `description` in `azure.yaml` to force a new agent version with a fresh container instance |
| `MODEL_DEPLOYMENT_NAME` not set in container | Must be in the `env` section of `azure.yaml`, not in `.env` |
| `Connection mongo-atlas can't be found` | Foundry Connections REST API didn't work. Used `${MONGO_URI}` with `azd env set` instead |

---

## 11. Architecture

```
┌─ Foundry Platform ──────────────────────────────────────────────┐
│                                                                 │
│  APPLICATIONINSIGHTS_CONNECTION_STRING (auto-injected)          │
│  FOUNDRY_PROJECT_ENDPOINT (auto-injected)                       │
│  FOUNDRY_AGENT_SESSION_ID (auto-injected per request)           │
│                                                                 │
│  ┌─ Container (linux/amd64) ─────────────────────────────────┐  │
│  │                                                           │  │
│  │  Express server (:8088)                                   │  │
│  │    ├── POST /responses    ← Foundry gateway routes here   │  │
│  │    ├── POST /invocations                                  │  │
│  │    ├── GET  /readiness    ← Platform health check         │  │
│  │    └── GET  /api/mongo-status (internal only)             │  │
│  │                                                           │  │
│  │  Supervisor (LLM-as-scheduler)                            │  │
│  │    ├── delegate.balance                                   │  │
│  │    ├── delegate.payments                                  │  │
│  │    └── delegate.loans                                     │  │
│  │                                                           │  │
│  │  Integrations:                                            │  │
│  │    ├── GPT-5 via OpenAI client + Entra auth               │  │
│  │    ├── MongoDB Atlas (conversation persistence)           │  │
│  │    └── App Insights (OTel trace export)                   │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Secrets flow:
  azd env set MONGO_URI → ${MONGO_URI} in azure.yaml → container env var
  (never in source code, Docker image, or git)
```

---

## Version History

| Version | Image Tag | Changes |
| --- | --- | --- |
| v1 | `foundry-orchestration-lab:v1` | Initial deployment, GPT-5, custom OpenAI client with Entra auth |
| v2 | `foundry-orchestration-lab:v2` | Added MongoDB driver and `/api/mongo-status` endpoint |
| v3 | `foundry-orchestration-lab:v3` | Added `persistTurn()` — conversation turns saved to MongoDB |
| v4 | `foundry-orchestration-lab:v4` | Added Azure Monitor OTel exporter (had `addSpanProcessor` bug) |
| v5 | `foundry-orchestration-lab:v5` | Fixed OTel — use `spanProcessors` in constructor |
| v6 | `foundry-orchestration-lab:v6` | Added trace context propagation (`traceparent` header) |
| v7 | `foundry-orchestration-lab:v7` | Added `gen_ai.prompt` / `gen_ai.completion` to trace spans |
