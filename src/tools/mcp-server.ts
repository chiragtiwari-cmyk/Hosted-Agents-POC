/**
 * A minimal MCP server, hand-written.
 *
 * Why this matters for the workshop: Foundry hosted agents do NOT get tools
 * injected into their definition. The platform is explicit that adding tools
 * directly to a hosted agent's definition is unsupported — agents reach
 * Foundry-managed tools (Code Interpreter, Web Search, Azure AI Search, custom
 * connections) by connecting to a **Toolbox MCP endpoint** as an MCP *client*.
 *
 * So the transferable lesson is the client side. This server is a stand-in for
 * Toolbox, hosted in the same Express app to keep the demo to one process. A real
 * deployment would point the client at the project's Toolbox endpoint instead.
 *
 * Written out rather than pulled from the SDK for the same reason the Responses
 * protocol is hand-written: the wire format should be visible.
 *
 *   POST /mcp
 *     {"jsonrpc":"2.0","id":1,"method":"initialize"}
 *     {"jsonrpc":"2.0","id":2,"method":"tools/list"}
 *     {"jsonrpc":"2.0","id":3,"method":"tools/call",
 *      "params":{"name":"credit.score","arguments":{"customerId":"cust-001"}}}
 */
import express, { type Request, type Response, type Router } from "express";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC 2.0 reserved codes, plus MCP's application-level range. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface CreditReport {
  customerId: string;
  score: number;
  tier: "excellent" | "good" | "fair" | "poor";
  factors: string[];
  checkedAt: string;
}

/**
 * The credit score is derived from ledger facts rather than randomised, so the
 * same session always scores the same and a workshop demo is reproducible.
 */
export interface CreditInputs {
  monthlyIncomeMinor: number;
  balanceMinor: number;
  overdraftUsed: boolean;
  missedPayments: number;
}

export function computeCreditScore(inputs: CreditInputs): CreditReport {
  const factors: string[] = [];
  let score = 560;

  if (inputs.monthlyIncomeMinor >= 250_000) {
    score += 90;
    factors.push("income above £2,500/month");
  } else if (inputs.monthlyIncomeMinor >= 150_000) {
    score += 55;
    factors.push("income above £1,500/month");
  } else {
    score -= 40;
    factors.push("low or unverified income");
  }

  if (inputs.balanceMinor >= 500_000) {
    score += 80;
    factors.push("strong savings position");
  } else if (inputs.balanceMinor >= 100_000) {
    score += 40;
    factors.push("positive balance");
  } else if (inputs.balanceMinor < 0) {
    score -= 70;
    factors.push("account overdrawn");
  }

  if (inputs.overdraftUsed) {
    score -= 30;
    factors.push("overdraft in use");
  }
  if (inputs.missedPayments > 0) {
    score -= inputs.missedPayments * 45;
    factors.push(`${inputs.missedPayments} missed payment(s)`);
  }

  score = Math.max(300, Math.min(999, score));
  const tier = score >= 800 ? "excellent" : score >= 700 ? "good" : score >= 600 ? "fair" : "poor";

  return { customerId: "", score, tier, factors, checkedAt: "" };
}

/**
 * Supplies ledger facts per session, so the score reflects real state.
 *
 * Returns undefined when the session is unknown or not live. That is NOT the same
 * as a customer with no income: scoring someone "poor" because the caller omitted
 * an argument is a plausible-but-wrong answer, which is worse than an error.
 */
export type CreditInputResolver = (sessionId: string | undefined) => CreditInputs | undefined;

export interface McpServerOptions {
  resolveInputs: CreditInputResolver;
  latencyMs?: number;
  failureMode?: "none" | "error";
  now?: () => number;
}

const TOOL_DEFINITIONS = [
  {
    name: "credit.score",
    description:
      "Return an indicative credit score and tier for the current customer, " +
      "derived from income, balance and repayment history.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Customer identifier." },
        agentSessionId: {
          type: "string",
          description: "Session whose ledger the score should be based on.",
        },
      },
      required: ["customerId"],
      additionalProperties: false,
    },
  },
];

export function createMcpRouter(options: McpServerOptions): {
  router: Router;
  setFailureMode: (mode: "none" | "error") => void;
} {
  const now = options.now ?? (() => Date.now());
  let failureMode = options.failureMode ?? "none";
  const latencyMs = options.latencyMs ?? 150;
  const router = express.Router();

  router.post("/mcp", async (req: Request, res: Response) => {
    const body = req.body as unknown;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json(rpcError(null, RPC.INVALID_REQUEST, "Request must be a JSON-RPC object."));
      return;
    }

    const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = (request.id ?? null) as string | number | null;

    if (request.jsonrpc !== "2.0") {
      res.status(400).json(rpcError(id, RPC.INVALID_REQUEST, "`jsonrpc` must be \"2.0\"."));
      return;
    }
    if (typeof request.method !== "string") {
      res.status(400).json(rpcError(id, RPC.INVALID_REQUEST, "`method` is required."));
      return;
    }

    switch (request.method) {
      case "initialize":
        res.json(
          rpcResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "kore-orchestration-lab-toolbox", version: "0.1.0" },
          }),
        );
        return;

      // Notifications carry no id and expect no result.
      case "notifications/initialized":
        res.status(204).end();
        return;

      case "ping":
        res.json(rpcResult(id, {}));
        return;

      case "tools/list":
        res.json(rpcResult(id, { tools: TOOL_DEFINITIONS }));
        return;

      case "tools/call": {
        const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string") {
          res.json(rpcError(id, RPC.INVALID_PARAMS, "`params.name` is required."));
          return;
        }
        if (params.name !== "credit.score") {
          res.json(rpcError(id, RPC.METHOD_NOT_FOUND, `Unknown tool: ${params.name}`));
          return;
        }

        const args = (params.arguments ?? {}) as {
          customerId?: unknown;
          agentSessionId?: unknown;
        };
        if (typeof args.customerId !== "string" || !args.customerId.trim()) {
          res.json(rpcError(id, RPC.INVALID_PARAMS, "`customerId` is required."));
          return;
        }

        if (failureMode === "error") {
          res.json(rpcError(id, RPC.INTERNAL_ERROR, "Credit bureau is unavailable."));
          return;
        }

        if (latencyMs > 0) await sleep(latencyMs);

        const sessionId =
          typeof args.agentSessionId === "string" ? args.agentSessionId : undefined;
        const inputs = options.resolveInputs(sessionId);

        /*
         * No session facts means we cannot score, and must say so. Previously an
         * unknown session fell through to all-zero inputs and produced 520
         * "poor / low or unverified income" for a customer earning £2,850/month —
         * a plausible-looking figure that was simply wrong. Refusing is better.
         */
        if (!inputs) {
          res.json(
            rpcError(
              id,
              RPC.INVALID_PARAMS,
              sessionId
                ? `No live session ${sessionId}; cannot read the facts needed to score.`
                : "`agentSessionId` is required: the score is derived from that session's ledger.",
            ),
          );
          return;
        }

        const report: CreditReport = {
          ...computeCreditScore(inputs),
          customerId: args.customerId,
          checkedAt: new Date(now()).toISOString(),
        };

        /*
         * MCP returns tool output as content blocks. `structuredContent` carries
         * the machine-readable form; the text block is what a naive client would
         * show. Both are sent so the workshop can see the difference.
         */
        res.json(
          rpcResult(id, {
            content: [
              {
                type: "text",
                text: `Score ${report.score} (${report.tier}). ${report.factors.join("; ")}.`,
              },
            ],
            structuredContent: report,
            isError: false,
          }),
        );
        return;
      }

      default:
        res.json(rpcError(id, RPC.METHOD_NOT_FOUND, `Unknown method: ${request.method}`));
        return;
    }
  });

  /** Lets the UI and tests break the MCP server on demand. */
  router.post("/mcp/_mode", (req: Request, res: Response) => {
    const mode = (req.body ?? {}).mode;
    if (mode !== "none" && mode !== "error") {
      res.status(400).json({ error: { code: "invalid_mode", message: "mode must be none or error." } });
      return;
    }
    failureMode = mode;
    res.json({ ok: true, mode });
  });

  return { router, setFailureMode: (mode) => (failureMode = mode) };
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
