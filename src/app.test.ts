import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText, createApp } from "./app.js";
import { SessionManager } from "./session/manager.js";
import { SessionStorage } from "./session/storage.js";
import { FakeLlm, type ScriptedTurn } from "./testing/fakes.js";

const CLOCK = Date.parse("2026-07-31T09:00:00Z");
/** Most tests address one fixed session. */
const SID = "sess-test";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "folab-app-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function app(script: ScriptedTurn[], phraseReply = "Phrased reply.") {
  const llm = new FakeLlm(script, phraseReply);
  const storage = new SessionStorage(tempRoot);
  const sessions = new SessionManager(storage, () => CLOCK);
  const ctx = createApp({ llm, storage, sessions, modelName: "gpt-4o-mini", now: () => CLOCK });
  return { ...ctx, llm, storage };
}

function failingApp() {
  const storage = new SessionStorage(tempRoot);
  return createApp({
    llm: {
      complete: async () => {
        throw new Error("model unavailable");
      },
      phrase: async () => "",
    },
    storage,
    sessions: new SessionManager(storage, () => CLOCK),
    now: () => CLOCK,
  });
}

const DIRECT = (text: string): ScriptedTurn[] => [{ text }];

describe("GET /readiness", () => {
  /**
   * Foundry's platform health check. The Python/.NET protocol libraries provide
   * this automatically; because the protocols here are hand-written, we must too —
   * without it the platform may never mark the container ready.
   */
  it("returns 200 with no upstream dependencies", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a).get("/readiness").expect(200);
    expect(res.body.status).toBe("ready");
  });

  it("stays ready even when the model provider is broken", async () => {
    // Readiness must not depend on an upstream call, or a provider outage would
    // make the platform tear the container down.
    await request(failingApp().app).get("/readiness").expect(200);
  });
});

describe("GET /health", () => {
  it("reports ok and names the state directory", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.stateDir).toBe(tempRoot);
  });
});

describe("POST /responses — envelope", () => {
  it("returns a well-formed Responses envelope", async () => {
    const { app: a } = app(DIRECT("You have £1,240.00 in Current."));

    const res = await request(a)
      .post("/responses")
      .send({ input: "what's my balance?", agent_session_id: SID })
      .expect(200);

    expect(res.body.object).toBe("response");
    expect(res.body.status).toBe("completed");
    expect(res.body.model).toBe("gpt-4o-mini");
    expect(res.body.id).toMatch(/^resp_/);

    const message = res.body.output[0];
    expect(message.type).toBe("message");
    expect(message.role).toBe("assistant");
    expect(message.content[0].type).toBe("output_text");
    expect(res.body.output_text).toContain("£1,240.00");
    expect(res.body.usage.total_tokens).toBe(
      res.body.usage.input_tokens + res.body.usage.output_tokens,
    );
  });

  /** Clients learn their sandbox from the response — Foundry echoes it. */
  it("echoes agent_session_id", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a)
      .post("/responses")
      .send({ input: "hello", agent_session_id: SID })
      .expect(200);
    expect(res.body.agent_session_id).toBe(SID);
  });

  it("allocates a session when the caller supplies none", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a).post("/responses").send({ input: "hello" }).expect(200);
    expect(res.body.agent_session_id).toMatch(/^sess_/);
  });

  it("accepts an input array and treats the last user item as the turn", async () => {
    const { app: a, llm } = app(DIRECT("Anything else?"));

    await request(a)
      .post("/responses")
      .send({
        agent_session_id: SID,
        input: [
          { role: "user", content: "what's my balance?" },
          { role: "assistant", content: "£1,240.00." },
          { role: "user", content: "thanks" },
        ],
      })
      .expect(200);

    const sent = llm.requests[0]!.messages;
    expect(sent.at(-1)!.content).toBe("thanks");
    expect(sent.some((m) => m.content === "£1,240.00.")).toBe(true);
  });

  it("accepts the content-parts form of input items", async () => {
    const { app: a, llm } = app(DIRECT("ok"));
    await request(a)
      .post("/responses")
      .send({ input: [{ role: "user", content: [{ type: "input_text", text: "hello there" }] }] })
      .expect(200);
    expect(llm.requests[0]!.messages.at(-1)!.content).toBe("hello there");
  });

  it.each([
    ["a missing input", {}],
    ["an empty string input", { input: "   " }],
    ["a numeric input", { input: 42 }],
    ["an empty array input", { input: [] }],
  ])("rejects %s with a 400", async (_label, body) => {
    const { app: a } = app(DIRECT("unused"));
    const res = await request(a).post("/responses").send(body).expect(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("rejects an input array ending with an assistant message", async () => {
    const { app: a } = app(DIRECT("unused"));
    const res = await request(a)
      .post("/responses")
      .send({ input: [{ role: "assistant", content: "hi" }] })
      .expect(400);
    expect(res.body.error.message).toContain("final `input` item");
  });

  it("returns a 500 envelope when the model fails", async () => {
    const res = await request(failingApp().app).post("/responses").send({ input: "hi" }).expect(500);
    expect(res.body.error.type).toBe("server_error");
    expect(res.body.error.message).toContain("model unavailable");
  });
});

describe("session versus conversation semantics", () => {
  /**
   * The distinction the whole API turns on: a session is a sandbox, a
   * conversation is history. Reusing a session must NOT replay messages.
   */
  it("reusing a session alone does not replay history", async () => {
    const { app: a, llm } = app([...DIRECT("First."), ...DIRECT("Second.")]);

    await request(a).post("/responses").send({ input: "one", agent_session_id: SID }).expect(200);
    await request(a).post("/responses").send({ input: "two", agent_session_id: SID }).expect(200);

    const second = llm.requests[1]!.messages.map((m) => m.content);
    expect(second).toContain("two");
    // No prior turn leaked in just because the sandbox was shared.
    expect(second).not.toContain("one");
    expect(second).not.toContain("First.");
  });

  it("threading by conversation id does replay history", async () => {
    const { app: a, llm } = app([...DIRECT("First."), ...DIRECT("Second.")]);

    await request(a).post("/responses").send({ input: "one", conversation: "conv-a" }).expect(200);
    await request(a).post("/responses").send({ input: "two", conversation: "conv-a" }).expect(200);

    const second = llm.requests[1]!.messages.map((m) => m.content);
    expect(second).toContain("one");
    expect(second).toContain("First.");
  });

  it("a conversation binds a stable session across turns", async () => {
    const { app: a } = app([...DIRECT("one"), ...DIRECT("two")]);

    const first = await request(a).post("/responses").send({ input: "a", conversation: "conv-b" });
    const second = await request(a).post("/responses").send({ input: "b", conversation: "conv-b" });

    expect(first.body.agent_session_id).toBe(second.body.agent_session_id);
    expect(second.body.conversation).toBe("conv-b");
  });

  it("chains history via previous_response_id without a conversation", async () => {
    const { app: a, llm } = app([...DIRECT("First."), ...DIRECT("Second.")]);

    const first = await request(a).post("/responses").send({ input: "one" }).expect(200);
    await request(a)
      .post("/responses")
      .send({ input: "two", previous_response_id: first.body.id })
      .expect(200);

    const second = llm.requests[1]!.messages.map((m) => m.content);
    expect(second).toContain("one");
    expect(second).toContain("First.");
  });

  it("keeps two sessions' money separate", async () => {
    const { app: a } = app([
      { toolCalls: [{ name: "payments", arguments: { toPayee: "alice", amountMinor: 20_000 } }] },
      { text: "Staged." },
      { toolCalls: [{ name: "payments", arguments: { confirm: "__ignored__" } }] },
      { text: "Done." },
    ]);

    // Stage and commit in session A.
    const staged = await request(a)
      .post("/responses")
      .send({ input: "send £200 to alice", agent_session_id: "sess-a" })
      .expect(200);
    void staged;

    const a1 = await request(a).get("/api/state").query({ agent_session_id: "sess-a" });
    const b1 = await request(a).get("/api/state").query({ agent_session_id: "sess-b" });

    // A has a reservation; B is untouched.
    expect(a1.body.accounts[0].availableMinor).toBe(104_000);
    expect(b1.body.accounts[0].availableMinor).toBe(124_000);
    expect(b1.body.pending_token).toBeNull();
  });
});

describe("POST /invocations", () => {
  it("returns a reply, session id and invocation id", async () => {
    const { app: a } = app([
      { toolCalls: [{ name: "balance", arguments: { question: "b" } }] },
      { text: "£1,240.00 in Current." },
    ]);

    const res = await request(a)
      .post("/invocations")
      .query({ agent_session_id: SID })
      .send({ message: "balance?" })
      .expect(200);

    expect(res.body.reply).toContain("£1,240.00");
    expect(res.body.agent_session_id).toBe(SID);
    expect(res.body.session_id).toBe(SID);
    expect(res.body.invocation_id).toMatch(/^resp_/);
    expect(res.body.delegations).toEqual([{ agent: "balance", ok: true }]);
  });

  /**
   * Foundry reads the session from the QUERY STRING only. A body field must be
   * passed through without changing which sandbox serves the call.
   */
  it("ignores agent_session_id in the body", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a)
      .post("/invocations")
      .send({ message: "hello", agent_session_id: "sess-from-body" })
      .expect(200);
    expect(res.body.agent_session_id).not.toBe("sess-from-body");
  });

  it("rejects a missing message", async () => {
    const { app: a } = app(DIRECT("unused"));
    const res = await request(a).post("/invocations").send({}).expect(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });
});

describe("POST /responses — SSE streaming", () => {
  it("emits created, deltas, and completed in order", async () => {
    const { app: a } = app([
      { toolCalls: [{ name: "balance", arguments: { question: "b" } }] },
      { text: "Your Current account holds one thousand two hundred and forty pounds." },
    ]);

    const res = await request(a)
      .post("/responses")
      .send({ input: "balance?", agent_session_id: SID, stream: true })
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);

    const events = parseSse(res.text);
    const names = events.map((e) => e.event);

    expect(names[0]).toBe("response.created");
    expect(names).toContain("response.output_text.delta");
    expect(names.at(-1)).toBe("response.completed");

    const assembled = events
      .filter((e) => e.event === "response.output_text.delta")
      .map((e) => e.data.delta as string)
      .join("");
    expect(assembled).toBe("Your Current account holds one thousand two hundred and forty pounds.");

    const completed = events.at(-1)!.data.response as Record<string, unknown>;
    expect(completed.object).toBe("response");
    expect(completed.output_text).toBe(assembled);
    expect(completed.agent_session_id).toBe(SID);
  });

  it("emits delegation.step events so the UI can draw the trace live", async () => {
    const { app: a } = app([
      {
        toolCalls: [
          { name: "balance", arguments: { question: "b" } },
          { name: "loans", arguments: { question: "l" } },
        ],
      },
      { text: "Both done." },
    ]);

    const res = await request(a)
      .post("/responses")
      .send({ input: "balance and loans?", agent_session_id: SID, stream: true })
      .expect(200);

    const steps = parseSse(res.text)
      .filter((e) => e.event === "delegation.step")
      .map((e) => e.data as { name: string; depth: number });

    expect(steps.some((s) => s.name === "supervisor.plan" && s.depth === 0)).toBe(true);
    expect(steps.some((s) => s.name === "delegate.balance" && s.depth === 1)).toBe(true);
    expect(steps.some((s) => s.name === "delegate.loans" && s.depth === 1)).toBe(true);
  });

  it("emits an error event rather than a broken stream when the model fails", async () => {
    const res = await request(failingApp().app)
      .post("/responses")
      .send({ input: "hi", stream: true })
      .expect(200);

    const events = parseSse(res.text);
    expect(events.at(-1)!.event).toBe("error");
    expect(events.at(-1)!.data.message).toContain("model unavailable");
  });
});

describe("GET /api/state", () => {
  it("returns formatted balances for a session", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a).get("/api/state").query({ agent_session_id: SID }).expect(200);

    expect(res.body.customer.name).toBe("Sam Rivera");
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.accounts[0].balance).toBe("£1,240.00");
    expect(res.body.session.status).toBe("active");
    expect(res.body.session.resume_count).toBe(0);
  });

  it("requires a session id", async () => {
    const { app: a } = app(DIRECT("hi"));
    await request(a).get("/api/state").expect(400);
  });
});

describe("GET /api/trace/:id", () => {
  it("returns the delegation trace for a conversation", async () => {
    const { app: a } = app([
      { toolCalls: [{ name: "balance", arguments: { question: "b" } }] },
      { text: "Done." },
    ]);

    await request(a).post("/responses").send({ input: "balance?", conversation: "conv-t" }).expect(200);

    const res = await request(a).get("/api/trace/conv-t").expect(200);
    expect(res.body.turns).toHaveLength(1);
    const turn = res.body.turns[0];
    expect(turn.userMessage).toBe("balance?");
    expect(turn.steps.map((s: { name: string }) => s.name)).toContain("delegate.balance");
    expect(turn.steps.every((s: { status: string }) => s.status === "ok")).toBe(true);
  });

  it("404s for an unknown conversation", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a).get("/api/trace/nope").expect(404);
    expect(res.body.error.type).toBe("not_found");
  });
});

describe("workshop demo hooks", () => {
  it("applies an external debit to a session", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a)
      .post("/api/demo/debit")
      .send({ agent_session_id: SID, accountId: "acc-current", amountMinor: 100_000 })
      .expect(200);
    expect(res.body.account.balanceMinor).toBe(24_000);
  });

  it("persists the debit across a deprovision", async () => {
    const { app: a } = app(DIRECT("hi"));
    await request(a)
      .post("/api/demo/debit")
      .send({ agent_session_id: SID, amountMinor: 100_000 })
      .expect(200);

    await request(a).post("/api/demo/deprovision").send({ agent_session_id: SID }).expect(200);

    const res = await request(a).get("/api/state").query({ agent_session_id: SID }).expect(200);
    expect(res.body.accounts[0].balanceMinor).toBe(24_000);
    expect(res.body.session.resume_count).toBe(1);
  });

  it("rejects a non-positive debit", async () => {
    const { app: a } = app(DIRECT("hi"));
    await request(a).post("/api/demo/debit").send({ agent_session_id: SID, amountMinor: 0 }).expect(400);
  });

  it("reset deletes the session so the ledger reseeds", async () => {
    const { app: a } = app(DIRECT("hi"));
    await request(a).post("/api/demo/debit").send({ agent_session_id: SID, amountMinor: 100_000 });
    await request(a).post("/api/demo/reset").send({ agent_session_id: SID }).expect(200);

    const res = await request(a).get("/api/state").query({ agent_session_id: SID }).expect(200);
    expect(res.body.accounts[0].balanceMinor).toBe(124_000);
  });
});

describe("routing", () => {
  it("returns JSON, not HTML, for an unknown route", async () => {
    const { app: a } = app(DIRECT("hi"));
    const res = await request(a).get("/does-not-exist").expect(404);
    expect(res.body.error.type).toBe("not_found");
  });
});

describe("chunkText", () => {
  it("splits on word boundaries and reassembles exactly", () => {
    const text = "Your Current account holds one thousand pounds exactly.";
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("returns nothing for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("keeps a short string as a single chunk", () => {
    expect(chunkText("Hi.")).toEqual(["Hi."]);
  });
});

/** Minimal SSE parser for assertions. */
function parseSse(raw: string): { event: string; data: Record<string, unknown> }[] {
  return raw
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      return {
        event: eventLine ? eventLine.slice(7).trim() : "",
        data: dataLine ? JSON.parse(dataLine.slice(6)) : {},
      };
    });
}
