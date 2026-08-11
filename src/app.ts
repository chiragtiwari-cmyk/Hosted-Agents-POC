/**
 * The Express application.
 *
 * Protocol routes (what Foundry's gateway calls):
 *   POST /responses                              Responses protocol, optional SSE
 *   POST /invocations                            Invocations protocol
 *   GET  /invocations_ws                         WebSocket (wired in server.ts)
 *   GET  /health                                 gateway readiness
 *
 * Session and conversation management (see session/routes.ts):
 *   /endpoint/sessions...            create, list, get, stop, delete, files
 *   /endpoint/protocols/openai/conversations...
 *
 * Local UI support (not routed by the Foundry gateway):
 *   GET  /api/state, /api/trace/:id, /api/sessions/...
 *   POST /api/demo/debit, /api/demo/reset, /api/demo/deprovision
 *   GET  /                                       static UI
 *
 * SESSION vs CONVERSATION — the distinction this whole file turns on:
 *   agent_session_id  the sandbox and its persisted filesystem. Per-session
 *                     ledger lives here. Reusing it does NOT replay messages.
 *   conversation      message history. Threading by conversation id also binds a
 *                     stable session, so callers get both without tracking two ids.
 *   previous_response_id  the stateless alternative: chain each turn to the last.
 *
 * Kept as a factory so tests inject a fake LLM, a fixed clock, and a temp state
 * directory rather than booting a real server against a provider.
 */
import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { formatMoney } from "./bank/ledger.js";
import type { LlmClient } from "./llm.js";
import {
  buildErrorResponse,
  buildResponse,
  estimateTokens,
  parseRequest,
  ProtocolError,
  sseEvent,
  streamCompleted,
  streamCreated,
  streamError,
  streamTextDelta,
} from "./protocol/responses.js";
import { ConversationStore } from "./session/conversations.js";
import { SessionManager } from "./session/manager.js";
import { createSessionRouter, isolationKeyOf } from "./session/routes.js";
import { SessionStorage } from "./session/storage.js";
import { runSupervisor, type PriorMessage } from "./supervisor.js";
import { HttpToolClient, McpToolClient } from "./tools/clients.js";
import { createHttpToolRouter } from "./tools/http-tool.js";
import { createMcpRouter } from "./tools/mcp-server.js";
import { type SpanExporter, TraceStore, TurnTracer } from "./trace.js";
import { persistTurn } from "./mongo.js";

export interface AppDeps {
  llm: LlmClient;
  sessions?: SessionManager;
  storage?: SessionStorage;
  traces?: TraceStore;
  exporter?: SpanExporter;
  modelName?: string;
  now?: () => number;
  /** Directory holding the static UI. Omit to skip static serving. */
  publicDir?: string;
  /** Artificial tool latency, so trace bars are visible. Tests set 0. */
  toolLatencyMs?: number;
  /**
   * Where agents reach the tools. Defaults to this server over loopback, which is
   * a genuine network boundary. On Foundry, point the MCP client at the project's
   * Toolbox endpoint instead.
   */
  toolBaseUrl?: string;
}

export interface AppContext {
  app: Express;
  sessions: SessionManager;
  conversations: ConversationStore;
  traces: TraceStore;
  runTurn: RunTurn;
}

export interface RunTurnResult {
  text: string;
  delegations: { agent: string; ok: boolean }[];
  truncated: boolean;
  agentSessionId: string;
  conversationId?: string;
  responseId: string;
}

export type RunTurn = (params: {
  userMessage: string;
  agentSessionId?: string;
  conversationId?: string;
  previousResponseId?: string;
  isolationKey?: string;
  /** History supplied inline by the caller; wins over stored history. */
  inlineHistory?: PriorMessage[];
  responseId?: string;
  onStep?: (step: unknown) => void;
  /** W3C traceparent header from the incoming request for trace context propagation. */
  traceparent?: string;
}) => Promise<RunTurnResult>;

export function createApp(deps: AppDeps): AppContext {
  const now = deps.now ?? (() => Date.now());
  const storage = deps.storage ?? new SessionStorage();
  const sessions = deps.sessions ?? new SessionManager(storage, now);
  const conversations = new ConversationStore(sessions.store, now);
  const traces = deps.traces ?? new TraceStore();
  const modelName = deps.modelName ?? process.env.MODEL_DEPLOYMENT_NAME ?? "unknown";

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Agents call these over HTTP, not in-process, so failure modes are real.
  const toolBaseUrl = deps.toolBaseUrl ?? `http://127.0.0.1:${process.env.PORT ?? 8088}`;
  const agentTools = {
    fx: new HttpToolClient({ baseUrl: toolBaseUrl, timeoutMs: 2_000, now }),
    credit: new McpToolClient({ baseUrl: toolBaseUrl, timeoutMs: 2_000, now }),
  };

  /**
   * One conversational turn, shared by every transport.
   *
   * Resolution order for the sandbox:
   *   1. explicit agent_session_id
   *   2. the session bound to the conversation, if threading by conversation
   *   3. the platform-injected FOUNDRY_AGENT_SESSION_ID
   *   4. a fresh session
   */
  const runTurn: RunTurn = async (params) => {
    const responseId = params.responseId ?? `resp_${Math.random().toString(36).slice(2, 12)}`;

    let agentSessionId = params.agentSessionId;
    if (!agentSessionId && params.conversationId) {
      agentSessionId = await conversations.sessionFor(params.conversationId);
    }
    agentSessionId ??= process.env.FOUNDRY_AGENT_SESSION_ID;
    agentSessionId ??= `sess_${Math.random().toString(36).slice(2, 12)}`;

    const session = await sessions.acquire(agentSessionId, {
      ...(params.isolationKey ? { isolationKey: params.isolationKey } : {}),
    });

    // History: inline wins, then conversation, then a response chain, else none.
    let history: PriorMessage[] = [];
    if (params.inlineHistory?.length) {
      history = params.inlineHistory;
    } else if (params.conversationId) {
      history = (await conversations.get(params.conversationId))?.messages ?? [];
    } else if (params.previousResponseId) {
      history = conversations.historyFromResponseChain(params.previousResponseId);
    }

    if (params.traceparent && deps.exporter?.activateIncomingContext) {
      deps.exporter.activateIncomingContext(params.traceparent);
    }

    const turn = traces.beginTurn(params.conversationId ?? agentSessionId, params.userMessage, now());
    const tracer = new TurnTracer(turn, now, deps.exporter);
    const unsubscribe = params.onStep ? tracer.onStep(params.onStep) : undefined;

    try {
      const reply = await runSupervisor(params.userMessage, history, {
        llm: deps.llm,
        ledger: session.ledger,
        tracer,
        tools: agentTools,
        sessionId: agentSessionId,
        ...(session.pendingToken ? { pendingToken: session.pendingToken } : {}),
      });

      turn.reply = reply.text;
      turn.durationMs = now() - turn.startedAtMs;

      // Persist the pending confirmation and the mutated ledger to $HOME, so a
      // deprovisioned session resumes mid-payment rather than losing it.
      await sessions.setPendingToken(agentSessionId, reply.pendingToken);

      if (params.conversationId) {
        await conversations.appendTurn(params.conversationId, {
          responseId,
          agentSessionId,
          userMessage: params.userMessage,
          assistantReply: reply.text,
          ...(params.previousResponseId ? { previousResponseId: params.previousResponseId } : {}),
        });
      } else {
        // Register the response so previous_response_id chaining still resolves
        // without a conversation object.
        await conversations.appendTurn(`resp-chain-${agentSessionId}`, {
          responseId,
          agentSessionId,
          userMessage: params.userMessage,
          assistantReply: reply.text,
          ...(params.previousResponseId ? { previousResponseId: params.previousResponseId } : {}),
        });
      }

      persistTurn({
        agentSessionId,
        conversationId: params.conversationId,
        responseId,
        userMessage: params.userMessage,
        assistantReply: reply.text,
        delegations: reply.delegations,
        timestamp: new Date(),
      });

      return {
        text: reply.text,
        delegations: reply.delegations,
        truncated: reply.truncated,
        agentSessionId,
        ...(params.conversationId ? { conversationId: params.conversationId } : {}),
        responseId,
      };
    } finally {
      unsubscribe?.();
    }
  };

  /* ------------------------------------------------------------------ health */

  /*
   * Foundry's platform health check.
   *
   * The Python/.NET protocol libraries expose /readiness automatically. We
   * hand-wrote the protocols, so we must provide it ourselves — without it the
   * platform may never mark the container ready. Deliberately minimal: no
   * upstream calls, no model probe, just "the process is up and can serve".
   */
  app.get("/readiness", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ready" });
  });

  app.get("/health", (_req: Request, res: Response) => {
    // Report degraded durability rather than a bare "ok": an unwritable state
    // volume still serves traffic, but nothing survives compute recycling, and
    // that must not be silent.
    const failures = sessions.durabilityFailures;
    res.json({
      status: "ok",
      agent: process.env.FOUNDRY_AGENT_NAME ?? "banking-supervisor",
      version: process.env.FOUNDRY_AGENT_VERSION ?? "local",
      stateDir: sessions.store.rootDir,
      durability: failures.length === 0 ? "ok" : "degraded",
      ...(failures.length ? { durabilityFailures: failures.slice(0, 5) } : {}),
    });
  });

  /* --------------------------------------------------------------- responses */

  app.post("/responses", async (req: Request, res: Response) => {
    let parsed;
    try {
      parsed = parseRequest(req.body ?? {});
    } catch (error) {
      const { status, body } = buildErrorResponse(error);
      res.status(status).json(body);
      return;
    }

    const responseId = `resp_${Math.random().toString(36).slice(2, 12)}`;
    const tp = req.headers["traceparent"];
    const common = {
      userMessage: parsed.userMessage,
      isolationKey: isolationKeyOf(req),
      responseId,
      ...(parsed.agentSessionId ? { agentSessionId: parsed.agentSessionId } : {}),
      ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
      ...(parsed.previousResponseId ? { previousResponseId: parsed.previousResponseId } : {}),
      ...(parsed.history.length ? { inlineHistory: parsed.history } : {}),
      ...(typeof tp === "string" ? { traceparent: tp } : {}),
    };

    if (!parsed.stream) {
      try {
        const result = await runTurn(common);
        res.json(
          buildResponse({
            id: responseId,
            model: modelName,
            text: result.text,
            createdAtMs: now(),
            usage: {
              inputTokens: estimateTokens(parsed.userMessage),
              outputTokens: estimateTokens(result.text),
            },
            agentSessionId: result.agentSessionId,
            ...(result.conversationId ? { conversationId: result.conversationId } : {}),
            ...(parsed.previousResponseId ? { previousResponseId: parsed.previousResponseId } : {}),
          }),
        );
      } catch (error) {
        const { status, body } = buildErrorResponse(error);
        res.status(status).json(body);
      }
      return;
    }

    // SSE. Headers go out before any await so the client starts reading.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(streamCreated(responseId, modelName, now()));

    try {
      const result = await runTurn({
        ...common,
        onStep: (step) => res.write(sseEvent("delegation.step", step)),
      });

      for (const chunk of chunkText(result.text)) {
        res.write(streamTextDelta(responseId, chunk));
      }

      res.write(
        streamCompleted(
          buildResponse({
            id: responseId,
            model: modelName,
            text: result.text,
            createdAtMs: now(),
            usage: {
              inputTokens: estimateTokens(parsed.userMessage),
              outputTokens: estimateTokens(result.text),
            },
            agentSessionId: result.agentSessionId,
            ...(result.conversationId ? { conversationId: result.conversationId } : {}),
          }),
        ),
      );
    } catch (error) {
      res.write(streamError(error instanceof Error ? error.message : String(error)));
    } finally {
      res.end();
    }
  });

  /* ------------------------------------------------------------- invocations */

  /**
   * Invocations reads the session from the QUERY STRING. Body fields and the
   * x-agent-session-id header are passed through to the container untouched but
   * do not influence routing — matching Foundry exactly, because getting this
   * wrong is a common source of "why isn't my state persisting".
   */
  app.post("/invocations", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { message?: unknown; input?: unknown };
    const raw = typeof body.message === "string" ? body.message : body.input;
    const message = typeof raw === "string" ? raw.trim() : "";
    if (!message) {
      res.status(400).json({
        error: { type: "invalid_request_error", message: "`message` is required." },
      });
      return;
    }

    const queryParam = req.query.agent_session_id;
    const agentSessionId = typeof queryParam === "string" && queryParam.trim() ? queryParam.trim() : undefined;

    try {
      const result = await runTurn({
        userMessage: message,
        isolationKey: isolationKeyOf(req),
        ...(agentSessionId ? { agentSessionId } : {}),
      });
      res.json({
        session_id: result.agentSessionId,
        agent_session_id: result.agentSessionId,
        invocation_id: result.responseId,
        reply: result.text,
        delegations: result.delegations,
        truncated: result.truncated,
      });
    } catch (error) {
      const { status, body: errorBody } = buildErrorResponse(error);
      res.status(status).json(errorBody);
    }
  });

  /* -------------------------------------- session + conversation management */

  app.use(createSessionRouter({ sessions, conversations }));

  /* ------------------------------------------------------- tool endpoints */

  /*
   * The tools are hosted in this same app, but agents reach them over the
   * loopback network rather than by direct function call — so latency, timeouts
   * and failures behave the way they would against a separate service.
   *
   * Note on fidelity: Foundry does NOT let you attach tools to a hosted agent's
   * definition. Agents connect to a Toolbox MCP endpoint as a client. Our /mcp
   * route stands in for Toolbox; the client code is what transfers.
   */
  const { router: httpToolRouter } = createHttpToolRouter({
    ...(deps.toolLatencyMs !== undefined ? { latencyMs: deps.toolLatencyMs } : {}),
    now,
  });
  app.use(httpToolRouter);

  const { router: mcpRouter } = createMcpRouter({
    ...(deps.toolLatencyMs !== undefined ? { latencyMs: deps.toolLatencyMs } : {}),
    now,
    // Score from the addressed session's own ledger, so it reflects real state.
    resolveInputs: (sessionId) => {
      const live = sessionId ? sessions.peek(sessionId) : undefined;
      const ledger = live?.ledger;
      // undefined, not zeros: an unknown session must yield an error rather than
      // a confident "poor" score built from nothing.
      if (!ledger) return undefined;
      const accounts = ledger.listAccounts();
      const total = accounts.reduce((sum, a) => sum + a.balanceMinor, 0);
      return {
        monthlyIncomeMinor: ledger.estimatedMonthlyIncomeMinor(),
        balanceMinor: total,
        overdraftUsed: accounts.some((a) => a.balanceMinor < 0),
        missedPayments: 0,
      };
    },
  });
  app.use(mcpRouter);

  /* ------------------------------------------------------------- UI support */

  /** Ledger snapshot for a specific session. */
  app.get("/api/state", async (req: Request, res: Response) => {
    const requested = req.query.agent_session_id;
    const sessionId = typeof requested === "string" && requested.trim() ? requested.trim() : undefined;
    if (!sessionId) {
      res.status(400).json({
        error: { type: "invalid_request_error", message: "`agent_session_id` is required." },
      });
      return;
    }

    const session = await sessions.acquire(sessionId, { isolationKey: isolationKeyOf(req) });
    const view = await sessions.get(sessionId);
    const ledger = session.ledger;

    res.json({
      agent_session_id: sessionId,
      session: view
        ? {
            status: view.status,
            resume_count: view.resumeCount,
            idle_in_seconds: Math.floor(view.idleInMs / 1000),
            disk_used_bytes: view.diskUsedBytes,
          }
        : undefined,
      customer: ledger.customer,
      pending_token: session.pendingToken ?? null,
      accounts: ledger.listAccounts().map((account) => ({
        id: account.id,
        name: account.name,
        number: account.numberMasked,
        balance: formatMoney(account.balanceMinor, account.currency),
        available: formatMoney(account.availableMinor, account.currency),
        balanceMinor: account.balanceMinor,
        availableMinor: account.availableMinor,
      })),
      payees: ledger.listPayees().map((payee) => ({ id: payee.id, name: payee.name })),
      recentTransactions: ledger.recentTransactions(undefined, 8).map((txn) => ({
        date: txn.date,
        description: txn.description,
        amount: formatMoney(txn.amountMinor),
      })),
      applications: ledger.listApplications().map((application) => ({
        reference: application.reference,
        product: application.productName,
        amount: formatMoney(application.amountMinor),
        term_months: application.termMonths,
        apr: `${application.aprPercent}%`,
        monthly_payment: formatMoney(application.monthlyPaymentMinor),
        status: application.status,
      })),
    });
  });

  app.get("/api/trace/:id", (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const trace = id ? traces.get(id) : undefined;
    if (!trace) {
      res.status(404).json({ error: { type: "not_found", message: "No trace for that conversation." } });
      return;
    }
    res.json(trace);
  });

  app.get("/api/traces", (_req: Request, res: Response) => {
    res.json({ conversations: traces.list() });
  });

  /** Workshop hook: an external debit, to force a refused confirmation. */
  app.post("/api/demo/debit", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      accountId?: unknown;
      amountMinor?: unknown;
      agent_session_id?: unknown;
    };
    const sessionId = typeof body.agent_session_id === "string" ? body.agent_session_id : undefined;
    if (!sessionId) {
      res.status(400).json({
        error: { type: "invalid_request_error", message: "`agent_session_id` is required." },
      });
      return;
    }
    const accountId = typeof body.accountId === "string" ? body.accountId : "acc-current";
    const amountMinor = typeof body.amountMinor === "number" ? body.amountMinor : 0;

    try {
      const session = await sessions.acquire(sessionId);
      session.ledger.applyExternalDebit(accountId, amountMinor, "Direct debit (demo)");
      await sessions.persist(sessionId);
      res.json({ ok: true, account: session.ledger.getAccount(accountId) });
    } catch (error) {
      res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  /**
   * Simulates Foundry's 15-minute idle deprovision on demand: drops the in-memory
   * sandbox so the next turn must restore from $HOME. This is the control that
   * makes stateful resume visible in a workshop without waiting 15 minutes.
   */
  app.post("/api/demo/deprovision", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { agent_session_id?: unknown };
    const sessionId = typeof body.agent_session_id === "string" ? body.agent_session_id : undefined;
    if (!sessionId) {
      res.status(400).json({
        error: { type: "invalid_request_error", message: "`agent_session_id` is required." },
      });
      return;
    }
    const done = await sessions.forceDeprovision(sessionId);
    res.json({ ok: done, agent_session_id: sessionId, status: done ? "idle" : "not-live" });
  });

  /** Deletes the session entirely — fresh ledger on next use. */
  app.post("/api/demo/reset", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { agent_session_id?: unknown; conversation?: unknown };
    if (typeof body.agent_session_id === "string") {
      await sessions.delete(body.agent_session_id);
    }
    if (typeof body.conversation === "string") {
      await conversations.delete(body.conversation);
    }
    res.json({ ok: true });
  });

  app.get("/api/mongo-status", async (_req: Request, res: Response) => {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      res.status(503).json({ status: "error", message: "MONGO_URI not configured" });
      return;
    }
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    try {
      await client.connect();
      const result = await client.db("admin").command({ ping: 1 });
      res.json({ status: "ok", ping: result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ status: "error", message: msg });
    } finally {
      await client.close();
    }
  });

  if (deps.publicDir) {
    app.use(express.static(deps.publicDir));
    app.get("/", (_req: Request, res: Response) => {
      res.sendFile(path.join(deps.publicDir!, "index.html"));
    });
  }

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: { type: "not_found", message: `No route for ${req.method} ${req.path}` },
    });
  });

  return { app, sessions, conversations, traces, runTurn };
}

/** Splits a reply into word-boundary chunks for SSE deltas. */
export function chunkText(text: string, size = 18): string[] {
  if (!text) return [];
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    current += word;
    if (current.length >= size) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export { ProtocolError };
