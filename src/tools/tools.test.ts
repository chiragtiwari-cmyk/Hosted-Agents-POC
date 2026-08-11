import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { balanceAgent } from "../agents/balance.js";
import { loansAgent } from "../agents/loans.js";
import { Ledger } from "../bank/ledger.js";
import { FakeLlm, RecordingTrace } from "../testing/fakes.js";
import { HttpToolClient, McpToolClient } from "./clients.js";
import { computeCreditScore, createMcpRouter, MCP_PROTOCOL_VERSION, RPC } from "./mcp-server.js";
import { convertFx, createHttpToolRouter } from "./http-tool.js";

const CLOCK = Date.parse("2026-07-31T09:00:00Z");

/** A real server on a real port, so the clients cross a genuine boundary. */
interface Harness {
  baseUrl: string;
  setFxMode: (mode: "none" | "error" | "hang") => Promise<void>;
  setMcpMode: (mode: "none" | "error") => Promise<void>;
  close: () => Promise<void>;
}

const servers: Harness[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(options: { latencyMs?: number } = {}): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const { router: fxRouter, config } = createHttpToolRouter({
    latencyMs: options.latencyMs ?? 0,
    now: () => CLOCK,
  });
  app.use(fxRouter);

  const { router: mcpRouter, setFailureMode } = createMcpRouter({
    latencyMs: options.latencyMs ?? 0,
    now: () => CLOCK,
    resolveInputs: () => ({
      monthlyIncomeMinor: 285_000,
      balanceMinor: 974_000,
      overdraftUsed: false,
      missedPayments: 0,
    }),
  });
  app.use(mcpRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    setFxMode: async (mode) => {
      config.failureMode = mode;
    },
    setMcpMode: async (mode) => setFailureMode(mode),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(harness);
  return harness;
}

/** App-less router for pure request/response assertions. */
function fxApp() {
  const app = express();
  app.use(express.json());
  app.use(createHttpToolRouter({ latencyMs: 0, now: () => CLOCK }).router);
  return app;
}

function mcpApp(overrides: Partial<Parameters<typeof createMcpRouter>[0]> = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    createMcpRouter({
      latencyMs: 0,
      now: () => CLOCK,
      resolveInputs: () => ({
        monthlyIncomeMinor: 285_000,
        balanceMinor: 974_000,
        overdraftUsed: false,
        missedPayments: 0,
      }),
      ...overrides,
    }).router,
  );
  return app;
}

describe("convertFx", () => {
  it("converts at the published rate, rounding to whole minor units", () => {
    const result = convertFx(124_000, "GBP", "EUR", CLOCK);
    expect(result.rate).toBe(1.17);
    expect(result.convertedMinor).toBe(145_080);
  });

  it("treats a same-currency conversion as identity", () => {
    expect(convertFx(100, "GBP", "GBP", CLOCK).convertedMinor).toBe(100);
  });

  it("throws when no rate exists", () => {
    expect(() => convertFx(100, "EUR", "USD", CLOCK)).toThrow(/No rate/);
  });
});

describe("POST /tools/fx/convert", () => {
  it("returns a conversion", async () => {
    const res = await request(fxApp())
      .post("/tools/fx/convert")
      .send({ amountMinor: 124_000, from: "GBP", to: "EUR" })
      .expect(200);
    expect(res.body.convertedMinor).toBe(145_080);
    expect(res.body.rate).toBe(1.17);
    expect(res.body.asOf).toBe(new Date(CLOCK).toISOString());
  });

  it("accepts lower-case currency codes", async () => {
    await request(fxApp())
      .post("/tools/fx/convert")
      .send({ amountMinor: 1000, from: "gbp", to: "usd" })
      .expect(200);
  });

  it.each([
    ["a fractional amount", { amountMinor: 12.5, from: "GBP", to: "EUR" }],
    ["a negative amount", { amountMinor: -1, from: "GBP", to: "EUR" }],
    ["a missing amount", { from: "GBP", to: "EUR" }],
  ])("rejects %s", async (_label, body) => {
    const res = await request(fxApp()).post("/tools/fx/convert").send(body).expect(400);
    expect(res.body.error.code).toBe("invalid_amount");
  });

  it("rejects an unsupported currency", async () => {
    const res = await request(fxApp())
      .post("/tools/fx/convert")
      .send({ amountMinor: 100, from: "GBP", to: "JPY" })
      .expect(400);
    expect(res.body.error.code).toBe("unsupported_currency");
  });
});

describe("MCP JSON-RPC contract", () => {
  it("responds to initialize with a protocol version and capabilities", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" })
      .expect(200);

    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.id).toBe(1);
    expect(res.body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(res.body.result.capabilities.tools).toBeDefined();
    expect(res.body.result.serverInfo.name).toBeTruthy();
  });

  it("lists tools with schemas", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      .expect(200);

    const tools = res.body.result.tools as { name: string; inputSchema: unknown }[];
    expect(tools.map((t) => t.name)).toContain("credit.score");
    expect(tools[0]!.inputSchema).toBeDefined();
  });

  it("calls credit.score and returns both content and structuredContent", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "credit.score", arguments: { customerId: "cust-001" } },
      })
      .expect(200);

    expect(res.body.result.isError).toBe(false);
    expect(res.body.result.content[0].type).toBe("text");
    expect(res.body.result.structuredContent.score).toBeGreaterThan(300);
    expect(res.body.result.structuredContent.customerId).toBe("cust-001");
  });

  it("answers ping", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 4, method: "ping" })
      .expect(200);
    expect(res.body.result).toEqual({});
  });

  it("accepts a notification with no response body", async () => {
    await request(mcpApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", method: "notifications/initialized" })
      .expect(204);
  });

  /* --- error objects: the part a hand-rolled server most often gets wrong --- */

  it("returns METHOD_NOT_FOUND for an unknown method", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 5, method: "tools/teleport" })
      .expect(200);
    expect(res.body.error.code).toBe(RPC.METHOD_NOT_FOUND);
  });

  it("returns METHOD_NOT_FOUND for an unknown tool", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "nope", arguments: {} },
      })
      .expect(200);
    expect(res.body.error.code).toBe(RPC.METHOD_NOT_FOUND);
  });

  it("returns INVALID_PARAMS when required arguments are missing", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "credit.score", arguments: {} },
      })
      .expect(200);
    expect(res.body.error.code).toBe(RPC.INVALID_PARAMS);
  });

  it("rejects a wrong jsonrpc version", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({ jsonrpc: "1.0", id: 8, method: "ping" })
      .expect(400);
    expect(res.body.error.code).toBe(RPC.INVALID_REQUEST);
  });

  it("rejects a non-object body", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .set("Content-Type", "application/json")
      .send("[]")
      .expect(400);
    expect(res.body.error.code).toBe(RPC.INVALID_REQUEST);
  });

  it("echoes the request id, including a string id", async () => {
    const res = await request(mcpApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: "abc-1", method: "ping" })
      .expect(200);
    expect(res.body.id).toBe("abc-1");
  });
});

describe("credit.score with no session facts", () => {
  /**
   * Regression: an unknown session used to fall through to all-zero inputs and
   * return 520 "poor / low or unverified income" for a customer earning
   * £2,850/month. A confident wrong score is worse than an error.
   */
  it("returns INVALID_PARAMS rather than scoring on nothing", async () => {
    const app = mcpApp({ resolveInputs: () => undefined });
    const res = await request(app)
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "credit.score", arguments: { customerId: "cust-001" } },
      })
      .expect(200);

    expect(res.body.error.code).toBe(RPC.INVALID_PARAMS);
    expect(res.body.error.message).toContain("agentSessionId");
    expect(res.body.result).toBeUndefined();
  });

  it("names the session when one was supplied but is not live", async () => {
    const app = mcpApp({ resolveInputs: () => undefined });
    const res = await request(app)
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "credit.score",
          arguments: { customerId: "cust-001", agentSessionId: "sess-gone" },
        },
      })
      .expect(200);

    expect(res.body.error.message).toContain("sess-gone");
  });

  it("surfaces the refusal through the client as a tool error", async () => {
    const app = express();
    app.use(express.json());
    app.use(createMcpRouter({ latencyMs: 0, now: () => CLOCK, resolveInputs: () => undefined }).router);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    servers.push({
      baseUrl: "",
      setFxMode: async () => {},
      setMcpMode: async () => {},
      close: () => new Promise<void>((r) => server.close(() => r())),
    });

    const client = new McpToolClient({ baseUrl: `http://127.0.0.1:${port}`, attempts: 1 });
    const result = await client.creditScore({ customerId: "cust-001" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("tool_error");
  });
});

describe("computeCreditScore", () => {
  it("scores a strong profile highly and explains why", () => {
    const report = computeCreditScore({
      monthlyIncomeMinor: 285_000,
      balanceMinor: 974_000,
      overdraftUsed: false,
      missedPayments: 0,
    });
    expect(report.score).toBeGreaterThanOrEqual(700);
    expect(report.tier).toMatch(/good|excellent/);
    expect(report.factors.length).toBeGreaterThan(0);
  });

  it("penalises an overdrawn account", () => {
    const strong = computeCreditScore({
      monthlyIncomeMinor: 285_000,
      balanceMinor: 500_000,
      overdraftUsed: false,
      missedPayments: 0,
    });
    const weak = computeCreditScore({
      monthlyIncomeMinor: 285_000,
      balanceMinor: -46_000,
      overdraftUsed: true,
      missedPayments: 0,
    });
    expect(weak.score).toBeLessThan(strong.score);
    expect(weak.factors.join(" ")).toContain("overdrawn");
  });

  it("clamps to the published range", () => {
    const floor = computeCreditScore({
      monthlyIncomeMinor: 0,
      balanceMinor: -1_000_000,
      overdraftUsed: true,
      missedPayments: 10,
    });
    expect(floor.score).toBeGreaterThanOrEqual(300);
  });

  it("is deterministic, so a workshop demo reproduces", () => {
    const inputs = {
      monthlyIncomeMinor: 285_000,
      balanceMinor: 974_000,
      overdraftUsed: false,
      missedPayments: 0,
    };
    expect(computeCreditScore(inputs)).toEqual(computeCreditScore(inputs));
  });
});

describe("HttpToolClient", () => {
  it("converts over a real network boundary", async () => {
    const { baseUrl } = await serve();
    const client = new HttpToolClient({ baseUrl, now: () => CLOCK });

    const result = await client.convert({ amountMinor: 124_000, from: "GBP", to: "EUR" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.convertedMinor).toBe(145_080);
      expect(result.transport).toBe("http");
    }
  });

  /** A tool failure must degrade, never throw into the agent. */
  it("returns a failure rather than throwing when the tool is down", async () => {
    const harness = await serve();
    await harness.setFxMode("error");
    const client = new HttpToolClient({ baseUrl: harness.baseUrl, attempts: 1 });

    const result = await client.convert({ amountMinor: 100, from: "GBP", to: "EUR" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unavailable");
  });

  it("times out rather than hanging", async () => {
    const harness = await serve();
    await harness.setFxMode("hang");
    const client = new HttpToolClient({ baseUrl: harness.baseUrl, timeoutMs: 150, attempts: 1 });

    const result = await client.convert({ amountMinor: 100, from: "GBP", to: "EUR" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
      expect(result.reason).toContain("150 ms");
    }
  });

  /** A 4xx is our own bad request; retrying it just wastes time. */
  it("does not retry a client error", async () => {
    const { baseUrl } = await serve();
    const client = new HttpToolClient({ baseUrl, attempts: 3 });

    const result = await client.convert({ amountMinor: 100, from: "GBP", to: "JPY" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("tool_error");
  });

  it("reports a transport failure when nothing is listening", async () => {
    const client = new HttpToolClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 500,
      attempts: 1,
    });
    const result = await client.convert({ amountMinor: 100, from: "GBP", to: "EUR" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("transport");
  });
});

describe("McpToolClient", () => {
  it("initialises, lists and calls", async () => {
    const { baseUrl } = await serve();
    const client = new McpToolClient({ baseUrl, now: () => CLOCK });

    const tools = await client.listTools();
    expect(tools.ok).toBe(true);
    if (tools.ok) expect(tools.value.map((t) => t.name)).toContain("credit.score");

    const score = await client.creditScore({ customerId: "cust-001" });
    expect(score.ok).toBe(true);
    if (score.ok) {
      expect(score.value.score).toBeGreaterThan(300);
      expect(score.transport).toBe("mcp");
    }
  });

  it("maps a JSON-RPC error onto a tool failure", async () => {
    const harness = await serve();
    await harness.setMcpMode("error");
    const client = new McpToolClient({ baseUrl: harness.baseUrl, attempts: 1 });

    const result = await client.creditScore({ customerId: "cust-001" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("tool_error");
      expect(result.reason).toContain("JSON-RPC");
    }
  });

  it("reports a transport failure when nothing is listening", async () => {
    const client = new McpToolClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 500,
      attempts: 1,
    });
    const result = await client.creditScore({ customerId: "cust-001" });
    expect(result.ok).toBe(false);
  });
});

describe("agent degradation when a tool fails", () => {
  function ctx(tools: Record<string, unknown>) {
    return {
      ledger: new Ledger(undefined, () => CLOCK),
      llm: new FakeLlm([], "Phrased."),
      trace: new RecordingTrace(),
      sessionId: "sess-tool",
      tools,
    } as never;
  }

  it("balance converts when the FX tool works", async () => {
    const { baseUrl } = await serve();
    const c = ctx({ fx: new HttpToolClient({ baseUrl, now: () => CLOCK }) });

    const result = await balanceAgent.handle(
      { question: "balance in euros?", currency: "EUR" },
      c,
    );

    const data = result.data as { convertedTotal?: { currency: string; total: string } };
    expect(data.convertedTotal?.currency).toBe("EUR");
    expect(data.convertedTotal?.total).toMatch(/^€/);
  });

  /**
   * The important one: a broken tool must not produce an invented rate. The agent
   * is told to state sterling only.
   */
  it("balance degrades to sterling and forbids estimating a rate", async () => {
    const harness = await serve();
    await harness.setFxMode("error");
    const c = ctx({ fx: new HttpToolClient({ baseUrl: harness.baseUrl, attempts: 1 }) });

    const result = await balanceAgent.handle(
      { question: "balance in euros?", currency: "EUR" },
      c,
    );

    const data = result.data as { convertedTotal?: unknown; conversionUnavailable?: string };
    expect(data.convertedTotal).toBeUndefined();
    expect(data.conversionUnavailable).toContain("Do NOT estimate");
    // The turn still succeeded — a tool outage is not a failed answer.
    expect(result.failed).toBeUndefined();
  });

  /**
   * Regression: the model repeatedly called balance WITHOUT the currency argument
   * even when the customer asked for euros, then apologised for a conversion it
   * never attempted. The agent now reads the intent from the question too.
   */
  it("converts when the question names a currency but the argument is missing", async () => {
    const { baseUrl } = await serve();
    const c = ctx({ fx: new HttpToolClient({ baseUrl, now: () => CLOCK }) });

    const result = await balanceAgent.handle(
      { question: "what is my total balance in euros?" },
      c,
    );

    const data = result.data as { convertedTotal?: { currency: string } };
    expect(data.convertedTotal?.currency).toBe("EUR");
  });

  it.each([
    ["dollars", "how much do I have in dollars?", "USD"],
    ["USD", "balance in USD please", "USD"],
    ["euro singular", "what's that in euro?", "EUR"],
    ["€ symbol", "balance in €?", "EUR"],
  ])("detects %s from the question", async (_label, question, expected) => {
    const { baseUrl } = await serve();
    const c = ctx({ fx: new HttpToolClient({ baseUrl, now: () => CLOCK }) });
    const result = await balanceAgent.handle({ question }, c);
    expect((result.data as { convertedTotal?: { currency: string } }).convertedTotal?.currency).toBe(
      expected,
    );
  });

  /** An ordinary balance question must not trigger a needless FX round trip. */
  it("does not convert for a plain balance question", async () => {
    const { baseUrl } = await serve();
    const c = ctx({ fx: new HttpToolClient({ baseUrl, now: () => CLOCK }) });

    const result = await balanceAgent.handle({ question: "what is my balance?" }, c);

    const data = result.data as { convertedTotal?: unknown; conversionUnavailable?: unknown };
    expect(data.convertedTotal).toBeUndefined();
    expect(data.conversionUnavailable).toBeUndefined();
  });

  it("balance works with no FX tool configured at all", async () => {
    const result = await balanceAgent.handle({ question: "balance?" }, ctx({}));
    expect(result.failed).toBeUndefined();
    expect((result.data as { accounts: unknown[] }).accounts).toHaveLength(2);
  });

  it("loans includes a credit check when MCP works", async () => {
    const { baseUrl } = await serve();
    const c = ctx({ credit: new McpToolClient({ baseUrl, now: () => CLOCK }) });

    const result = await loansAgent.handle({ question: "loan options?", amountMinor: 500_000 }, c);

    const data = result.data as { creditCheck?: { score: number; tier: string } };
    expect(data.creditCheck?.score).toBeGreaterThan(300);
    expect(data.creditCheck?.tier).toBeTruthy();
  });

  it("loans still quotes when the credit bureau is down", async () => {
    const harness = await serve();
    await harness.setMcpMode("error");
    const c = ctx({ credit: new McpToolClient({ baseUrl: harness.baseUrl, attempts: 1 }) });

    const result = await loansAgent.handle({ question: "loan options?", amountMinor: 500_000 }, c);

    const data = result.data as {
      creditCheck?: unknown;
      creditCheckUnavailable?: string;
      quotes: unknown[];
    };
    expect(data.creditCheck).toBeUndefined();
    expect(data.creditCheckUnavailable).toContain("Do NOT invent a score");
    // Quotes are unaffected: a tool outage must not make a customer ineligible.
    expect(data.quotes.length).toBeGreaterThan(0);
    expect(result.failed).toBeUndefined();
  });

  it("records the tool call as a nested trace span", async () => {
    const { baseUrl } = await serve();
    const c = ctx({ credit: new McpToolClient({ baseUrl, now: () => CLOCK }) });
    await loansAgent.handle({ question: "loan options?", amountMinor: 500_000 }, c);

    const trace = (c as unknown as { trace: RecordingTrace }).trace;
    expect(trace.names()).toContain("loans.creditCheck");
    const span = trace.spans.find((s) => s.name === "loans.creditCheck")!;
    expect(span.attributes.transport).toBe("mcp");
    expect(trace.notes.some((n) => n.message.includes("credit.score ok via mcp"))).toBe(true);
  });
});
