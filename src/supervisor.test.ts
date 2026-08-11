import { describe, expect, it } from "vitest";
import { Ledger } from "./bank/ledger.js";
import {
  MAX_TURNS,
  type PriorMessage,
  claimsPaymentAction,
  redactTokens,
  runSupervisor,
} from "./supervisor.js";
import { FakeLlm, type ScriptedTurn } from "./testing/fakes.js";
import { TraceStore, TurnTracer } from "./trace.js";

const CLOCK = Date.parse("2026-07-31T09:00:00Z");

function harness(script: ScriptedTurn[], phraseReply = "Phrased.") {
  const ledger = new Ledger(undefined, () => CLOCK);
  const llm = new FakeLlm(script, phraseReply);
  const store = new TraceStore();
  let tick = CLOCK;
  const turn = store.beginTurn("conv-1", "test", tick);
  const tracer = new TurnTracer(turn, () => (tick += 10));
  return { ledger, llm, tracer, turn, store };
}

async function run(
  script: ScriptedTurn[],
  userMessage: string,
  options: { history?: PriorMessage[]; pendingToken?: string; phraseReply?: string } = {},
) {
  const h = harness(script, options.phraseReply);
  const reply = await runSupervisor(userMessage, options.history ?? [], {
    llm: h.llm,
    ledger: h.ledger,
    tracer: h.tracer,
    sessionId: "sess-1",
    pendingToken: options.pendingToken,
  });
  return { ...h, reply };
}

describe("direct replies", () => {
  it("returns the model's text when no tools are called", async () => {
    const { reply, llm } = await run([{ text: "I can help with balances, payments and loans." }], "hi");

    expect(reply.text).toContain("balances");
    expect(reply.delegations).toEqual([]);
    expect(reply.truncated).toBe(false);
    expect(llm.turnsUsed).toBe(1);
  });

  it("substitutes a default when the model returns empty text", async () => {
    const { reply } = await run([{ text: "   " }], "???");
    expect(reply.text).toContain("balances, payments, and loans");
  });

  it("passes prior history to the model", async () => {
    const history: PriorMessage[] = [
      { role: "user", content: "what's my balance?" },
      { role: "assistant", content: "£1,240.00 in Current." },
    ];
    const { llm } = await run([{ text: "Anything else?" }], "thanks", { history });

    const sent = llm.requests[0]!.messages;
    expect(sent[0]!.role).toBe("system");
    expect(sent[1]!.content).toBe("what's my balance?");
    expect(sent[2]!.content).toBe("£1,240.00 in Current.");
    expect(sent[3]!.content).toBe("thanks");
  });

  it("offers every registered agent as a tool", async () => {
    const { llm } = await run([{ text: "hello" }], "hi");
    const tools = llm.requests[0]!.tools as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(["balance", "payments", "loans"]);
  });
});

describe("single delegation", () => {
  it("calls one specialist and replies from its summary", async () => {
    const { reply, tracer, turn } = await run(
      [
        { toolCalls: [{ name: "balance", arguments: { question: "balance?" } }] },
        { text: "You have £1,240.00 in Current." },
      ],
      "what's my balance?",
    );

    expect(reply.delegations).toEqual([{ agent: "balance", ok: true }]);
    expect(reply.text).toContain("£1,240.00");
    expect(turn.steps.map((s) => s.name)).toContain("delegate.balance");
    void tracer;
  });

  it("nests the specialist span below the supervisor", async () => {
    const { turn } = await run(
      [
        { toolCalls: [{ name: "balance", arguments: { question: "balance?" } }] },
        { text: "Done." },
      ],
      "balance?",
    );

    const supervisorStep = turn.steps.find((s) => s.name === "supervisor.plan")!;
    const delegateStep = turn.steps.find((s) => s.name === "delegate.balance")!;
    expect(supervisorStep.depth).toBe(0);
    expect(delegateStep.depth).toBe(1);
  });

  it("reports an unknown tool without crashing", async () => {
    const { reply } = await run(
      [
        { toolCalls: [{ name: "mortgages", arguments: {} }] },
        { text: "I can't help with mortgages." },
      ],
      "mortgage?",
    );

    expect(reply.delegations).toEqual([{ agent: "mortgages", ok: false }]);
    expect(reply.text).toContain("mortgages");
  });
});

describe("multi-intent parallel dispatch", () => {
  it("dispatches two specialists in one round", async () => {
    const { reply, llm, turn } = await run(
      [
        {
          toolCalls: [
            { name: "balance", arguments: { question: "balance?" } },
            { name: "loans", arguments: { question: "loan?", amountMinor: 500_000 } },
          ],
        },
        { text: "You have £1,240.00, and a £5,000 loan is £154.16 a month." },
      ],
      "what's my balance and can I get a £5,000 loan?",
    );

    expect(reply.delegations).toEqual([
      { agent: "balance", ok: true },
      { agent: "loans", ok: true },
    ]);
    // Two specialists, but only two supervisor calls — one round each side.
    expect(llm.turnsUsed).toBe(2);
    // Exactly two delegation spans, both nested below the supervisor.
    const delegateSpans = turn.steps.filter((s) => s.name.startsWith("delegate."));
    expect(delegateSpans.map((s) => s.name)).toEqual(["delegate.balance", "delegate.loans"]);
    expect(delegateSpans.every((s) => s.depth === 1)).toBe(true);
  });

  it("feeds both tool results back with matching call ids", async () => {
    const { llm } = await run(
      [
        {
          toolCalls: [
            { name: "balance", arguments: { question: "b" } },
            { name: "loans", arguments: { question: "l" } },
          ],
        },
        { text: "Both done." },
      ],
      "both please",
    );

    const second = llm.requests[1]!.messages;
    const toolMessages = second.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    const assistant = second.find((m) => m.role === "assistant")!;
    expect(assistant.toolCalls).toHaveLength(2);
    for (const message of toolMessages) {
      expect(assistant.toolCalls!.some((c) => c.id === message.toolCallId)).toBe(true);
    }
  });
});

describe("MAX_TURNS bound", () => {
  it("stops after MAX_TURNS iterations and says so", async () => {
    // A model that always calls a tool and never settles.
    const script: ScriptedTurn[] = Array.from({ length: MAX_TURNS }, () => ({
      toolCalls: [{ name: "balance", arguments: { question: "again" } }],
    }));

    const { reply, llm } = await run(script, "loop forever");

    expect(reply.truncated).toBe(true);
    expect(reply.text).toContain("wasn't able to finish");
    expect(llm.turnsUsed).toBe(MAX_TURNS);
    expect(reply.delegations).toHaveLength(MAX_TURNS);
  });

  it("counts loop iterations, not tool calls", async () => {
    // Three tools per round for two rounds = 6 delegations in 2 turns.
    const script: ScriptedTurn[] = [
      {
        toolCalls: [
          { name: "balance", arguments: { question: "a" } },
          { name: "balance", arguments: { question: "b" } },
          { name: "loans", arguments: { question: "c" } },
        ],
      },
      { text: "All done." },
    ];

    const { reply, llm } = await run(script, "lots at once");

    expect(llm.turnsUsed).toBe(2);
    expect(reply.delegations).toHaveLength(3);
    expect(reply.truncated).toBe(false);
  });
});

describe("payment confirmation across turns", () => {
  it("stages on turn one without moving money and surfaces a token", async () => {
    const { reply, ledger } = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { toPayee: "alice", amountMinor: 20_000 } }] },
        { text: "Confirm £200.00 to Alice Chen from Current?" },
      ],
      "send £200 to Alice",
    );

    expect(reply.pendingToken).toMatch(/^pend-/);
    expect(reply.text).toContain("Confirm");
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("commits on turn two when the token is replayed", async () => {
    // Turn one: stage.
    const first = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { toPayee: "alice", amountMinor: 20_000 } }] },
        { text: "Confirm £200.00 to Alice?" },
      ],
      "send £200 to Alice",
    );
    const token = first.reply.pendingToken!;

    // Turn two: confirm, reusing the SAME ledger so the staged payment survives.
    const llm = new FakeLlm(
      [
        { toolCalls: [{ name: "payments", arguments: { confirm: token } }] },
        { text: "Sent. Reference REF1004." },
      ],
      "Phrased.",
    );
    const store = new TraceStore();
    let tick = CLOCK;
    const tracer = new TurnTracer(store.beginTurn("conv-1", "yes", tick), () => (tick += 10));

    const second = await runSupervisor(
      "yes",
      [
        { role: "user", content: "send £200 to Alice" },
        { role: "assistant", content: "Confirm £200.00 to Alice?" },
      ],
      { llm, ledger: first.ledger, tracer, sessionId: "sess-1", pendingToken: token },
    );

    expect(second.pendingToken).toBeUndefined();
    expect(second.text).toContain("Sent");
    expect(first.ledger.getAccount("acc-current").balanceMinor).toBe(104_000);
  });

  it("gives the model the outstanding token as context", async () => {
    const { llm } = await run([{ text: "Cancelled." }], "no thanks", {
      pendingToken: "pend-42",
    });

    const userTurn = llm.requests[0]!.messages.at(-1)!.content;
    expect(userTurn).toContain("no thanks");
    expect(userTurn).toContain("pend-42");
    expect(userTurn).toContain("only if");
  });

  /**
   * Regression: the injected context used to hardcode "payments". With an
   * application token a live model was told to confirm via the wrong tool, so it
   * re-staged instead — looping and never submitting.
   */
  it("names the payments tool for a payment token", async () => {
    const { llm } = await run([{ text: "ok" }], "yes", { pendingToken: "pend-7" });
    const turn = llm.requests[0]!.messages.at(-1)!.content;
    expect(turn).toContain("payment is already staged");
    expect(turn).toContain('call payments with confirm="pend-7"');
    expect(turn).not.toContain("call loans");
  });

  it("names the loans tool for an application token", async () => {
    const { llm } = await run([{ text: "ok" }], "yes", { pendingToken: "appl-7" });
    const turn = llm.requests[0]!.messages.at(-1)!.content;
    expect(turn).toContain("loan application is already staged");
    expect(turn).toContain('call loans with confirm="appl-7"');
    expect(turn).not.toContain("call payments");
  });

  it("tells the model not to stage again", async () => {
    const { llm } = await run([{ text: "ok" }], "yes", { pendingToken: "appl-7" });
    expect(llm.requests[0]!.messages.at(-1)!.content).toContain("do NOT stage it again");
  });

  /**
   * The model must not be able to invent a token. This is the guard that makes
   * "the customer said yes" unforgeable.
   */
  it("refuses a token the conversation never issued", async () => {
    const { reply, ledger } = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { confirm: "pend-forged" } }] },
        { text: "I couldn't confirm that." },
      ],
      "yes send it",
    );

    expect(reply.delegations).toEqual([{ agent: "payments", ok: false }]);
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("refuses a token that does not match the outstanding one", async () => {
    const { reply, ledger } = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { confirm: "pend-other" } }] },
        { text: "That didn't match." },
      ],
      "yes",
      { pendingToken: "pend-real" },
    );

    expect(reply.delegations).toEqual([{ agent: "payments", ok: false }]);
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("clears the pending token when the customer declines", async () => {
    const first = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { toPayee: "alice", amountMinor: 20_000 } }] },
        { text: "Confirm?" },
      ],
      "pay alice £200",
    );
    const token = first.reply.pendingToken!;

    const llm = new FakeLlm(
      [
        { toolCalls: [{ name: "payments", arguments: { cancel: token } }] },
        { text: "Cancelled — nothing was sent." },
      ],
      "Phrased.",
    );
    const store = new TraceStore();
    let tick = CLOCK;
    const tracer = new TurnTracer(store.beginTurn("conv-1", "no", tick), () => (tick += 10));

    const second = await runSupervisor("no, cancel it", [], {
      llm,
      ledger: first.ledger,
      tracer,
      sessionId: "sess-1",
      pendingToken: token,
    });

    expect(second.pendingToken).toBeUndefined();
    expect(second.text).toContain("Cancelled");
    expect(first.ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("clears the token after a refused commit so it cannot be retried", async () => {
    const first = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { toPayee: "alice", amountMinor: 20_000 } }] },
        { text: "Confirm?" },
      ],
      "pay alice £200",
    );
    const token = first.reply.pendingToken!;

    // A large direct debit clears behind the supervisor's back, between turns,
    // exhausting the balance and the overdraft headroom.
    first.ledger.applyExternalDebit("acc-current", 170_000);

    const llm = new FakeLlm(
      [
        { toolCalls: [{ name: "payments", arguments: { confirm: token } }] },
        { text: "There isn't enough left in Current." },
      ],
      "Phrased.",
    );
    const store = new TraceStore();
    let tick = CLOCK;
    const tracer = new TurnTracer(store.beginTurn("conv-1", "yes", tick), () => (tick += 10));

    const second = await runSupervisor("yes", [], {
      llm,
      ledger: first.ledger,
      tracer,
      sessionId: "sess-1",
      pendingToken: token,
    });

    expect(second.delegations).toEqual([{ agent: "payments", ok: false }]);
    expect(second.pendingToken).toBeUndefined();
    // Only the external debit moved money: £1,240 − £1,700 = −£460.
    expect(first.ledger.getAccount("acc-current").balanceMinor).toBe(-46_000);
  });
});

describe("loan application across turns", () => {
  it("stages on turn one without submitting", async () => {
    const { reply, ledger } = await run(
      [
        {
          toolCalls: [
            { name: "loans", arguments: { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 } },
          ],
        },
        { text: "Please confirm the personal loan application?" },
      ],
      "apply for a £5,000 personal loan over 3 years",
    );

    expect(reply.pendingToken).toMatch(/^appl-/);
    expect(ledger.listApplications()).toEqual([]);
  });

  it("submits on turn two when the token is replayed", async () => {
    const first = await run(
      [
        {
          toolCalls: [
            { name: "loans", arguments: { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 } },
          ],
        },
        { text: "Confirm the application?" },
      ],
      "apply for a £5,000 personal loan over 3 years",
    );
    const token = first.reply.pendingToken!;

    const llm = new FakeLlm(
      [
        { toolCalls: [{ name: "loans", arguments: { confirm: token } }] },
        { text: "Submitted. Reference APP1001." },
      ],
      "Phrased.",
    );
    const store = new TraceStore();
    let tick = CLOCK;
    const tracer = new TurnTracer(store.beginTurn("conv-1", "yes", tick), () => (tick += 10));

    const second = await runSupervisor("yes, go ahead", [], {
      llm,
      ledger: first.ledger,
      tracer,
      sessionId: "sess-1",
      pendingToken: token,
    });

    expect(second.pendingToken).toBeUndefined();
    expect(first.ledger.listApplications()).toHaveLength(1);
    expect(first.ledger.listApplications()[0]!.reference).toMatch(/^APP\d+/);
  });

  /** A loan token must be as unforgeable as a payment token. */
  it("refuses an application token the conversation never issued", async () => {
    const { reply, ledger } = await run(
      [
        { toolCalls: [{ name: "loans", arguments: { confirm: "appl-forged" } }] },
        { text: "I couldn't confirm that." },
      ],
      "yes submit it",
    );

    expect(reply.delegations).toEqual([{ agent: "loans", ok: false }]);
    expect(ledger.listApplications()).toEqual([]);
  });

  it("never leaks an appl- token to the customer", async () => {
    const { reply } = await run(
      [
        {
          toolCalls: [
            { name: "loans", arguments: { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 } },
          ],
        },
        // A model echoing the specialist's internal summary verbatim.
        {
          text:
            'Ready to apply — Personal Loan. NOT YET SUBMITTED. Ask the customer to ' +
            'confirm, then call loans again with confirm="appl-1-42".',
        },
      ],
      "apply for a personal loan",
    );

    expect(reply.text).not.toMatch(/appl-[\w-]+/);
    expect(reply.text).not.toContain("confirm=");
    expect(reply.pendingToken).toMatch(/^appl-/);
  });

  it("blocks an application claim made without calling loans", async () => {
    const { reply, llm } = await run(
      [
        { text: "I've submitted the application for you." },
        {
          toolCalls: [
            { name: "loans", arguments: { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 } },
          ],
        },
        { text: "Please confirm the application first?" },
      ],
      "apply for £5,000 over 3 years",
    );

    expect(llm.turnsUsed).toBe(3);
    expect(reply.delegations).toEqual([{ agent: "loans", ok: true }]);
    expect(reply.text.toLowerCase()).toContain("confirm");
  });
});

describe("failure handling", () => {
  it("relays a specialist failure as an explainable result", async () => {
    const { reply, ledger } = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { toPayee: "Mallory", amountMinor: 100 } }] },
        { text: "Mallory isn't a saved payee." },
      ],
      "pay Mallory £1",
    );

    expect(reply.delegations).toEqual([{ agent: "payments", ok: false }]);
    expect(reply.text).toContain("Mallory");
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("survives a specialist that throws", async () => {
    // A balance call with a ledger that throws on read.
    const ledger = new Ledger(undefined, () => CLOCK);
    ledger.listAccounts = () => {
      throw new Error("ledger exploded");
    };
    const llm = new FakeLlm(
      [
        { toolCalls: [{ name: "balance", arguments: { question: "balance?" } }] },
        { text: "Something went wrong reading your accounts." },
      ],
      "Phrased.",
    );
    const store = new TraceStore();
    let tick = CLOCK;
    const tracer = new TurnTracer(store.beginTurn("conv-1", "b", tick), () => (tick += 10));

    const reply = await runSupervisor("balance?", [], {
      llm,
      ledger,
      tracer,
      sessionId: "sess-1",
    });

    expect(reply.delegations).toEqual([{ agent: "balance", ok: false }]);
    expect(reply.text).toContain("went wrong");
  });

  it("propagates an LLM failure rather than inventing a reply", async () => {
    const ledger = new Ledger(undefined, () => CLOCK);
    const store = new TraceStore();
    let tick = CLOCK;
    const tracer = new TurnTracer(store.beginTurn("conv-1", "x", tick), () => (tick += 10));

    await expect(
      runSupervisor("hi", [], {
        llm: {
          complete: async () => {
            throw new Error("model unavailable");
          },
          phrase: async () => "",
        },
        ledger,
        tracer,
        sessionId: "sess-1",
      }),
    ).rejects.toThrow("model unavailable");

    // The failed span is recorded for diagnosis.
    const step = store.get("conv-1")!.turns[0]!.steps[0]!;
    expect(step.status).toBe("error");
    expect(step.error).toContain("model unavailable");
  });
});

describe("phantom payment guard", () => {
  describe("claimsPaymentAction", () => {
    it.each([
      "I've staged the payment of £1,500.00 to Bob.",
      "I have cancelled the payment staging to Bob.",
      "The payment of £200.00 has been successfully sent to Alice Chen.",
      "Your payment has been sent.",
      "I've now paid Alice.",
      "The payment is complete.",
    ])("flags the assertion %j", (text) => {
      expect(claimsPaymentAction(text)).toBe(true);
    });

    it.each([
      "I can send £200 to Alice — would you like me to?",
      "Please confirm: send £200.00 to Alice Chen from Current?",
      "How much would you like to send to Alice?",
      "You have £1,240.00 in Current.",
      "Alice isn't in your saved payees.",
      "Shall I stage a payment to Bob?",
    ])("does not flag the non-assertion %j", (text) => {
      expect(claimsPaymentAction(text)).toBe(false);
    });
  });

  /**
   * Observed with a live model: it narrated the two-step protocol instead of
   * executing it, so a customer's "yes" would confirm a payment that was never
   * validated. The ledger stays safe, but the conversation misleads.
   */
  it("re-prompts when the model claims a payment it never staged", async () => {
    const { reply, llm, ledger } = await run(
      [
        // Turn 1: claims a staged payment with no tool call at all.
        { text: "I've staged the payment of £1,500.00 to Bob. Please confirm." },
        // Turn 2: after the nudge, it actually calls the tool.
        { toolCalls: [{ name: "payments", arguments: { toPayee: "bob", amountMinor: 150_000 } }] },
        { text: "Please confirm: send £1,500.00 to Bob Okafor from Current?" },
      ],
      "send £1500 to Bob",
    );

    // The guard forced another iteration rather than returning the false claim.
    expect(llm.turnsUsed).toBe(3);
    expect(reply.delegations).toEqual([{ agent: "payments", ok: true }]);
    expect(reply.text).toContain("confirm");
    expect(reply.pendingToken).toMatch(/^pend-/);
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("tells the model plainly that nothing was staged", async () => {
    const { llm } = await run(
      [
        { text: "I have cancelled the payment." },
        { text: "There was no payment to cancel." },
      ],
      "cancel it",
    );

    const nudge = llm.requests[1]!.messages.at(-1)!.content;
    // Wording covers both stateful agents now that loans can submit applications.
    expect(nudge).toContain("without calling the payments or loans tool");
    expect(nudge).toContain("Nothing has been staged");
  });

  it("does not interfere when the payments agent WAS called", async () => {
    const { reply, llm } = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { toPayee: "alice", amountMinor: 20_000 } }] },
        // A legitimate assertion — the tool ran, so this must pass through.
        { text: "I've staged the payment of £200.00 to Alice Chen. Please confirm." },
      ],
      "send £200 to Alice",
    );

    expect(llm.turnsUsed).toBe(2);
    expect(reply.text).toContain("staged");
  });

  it("does not trip on an ordinary balance reply", async () => {
    const { reply, llm } = await run(
      [
        { toolCalls: [{ name: "balance", arguments: { question: "b" } }] },
        { text: "You have £1,240.00 in Current and £8,500.00 in Savings." },
      ],
      "balance?",
    );
    expect(llm.turnsUsed).toBe(2);
    expect(reply.text).toContain("£1,240.00");
  });
});

describe("token redaction", () => {
  it("leaves an ordinary reply untouched", () => {
    const text = "You have £1,240.00 in Current.";
    expect(redactTokens(text)).toBe(text);
  });

  it("prefers the specialist's customer-safe wording when one is supplied", () => {
    const leaked =
      'Ready to send £200.00 to Alice. NOT YET SENT — ask the customer to confirm, ' +
      'then call payments again with confirm="pend-1-99".';
    expect(redactTokens(leaked, "Please confirm: send £200.00 to Alice?")).toBe(
      "Please confirm: send £200.00 to Alice?",
    );
  });

  it("strips a bare token when no safe wording exists", () => {
    const result = redactTokens('Say yes and I will use confirm="pend-7-42".');
    expect(result).not.toContain("pend-7-42");
    expect(result).not.toContain("confirm=");
  });

  it("never leaves a pend- token in the output", () => {
    for (const text of [
      "Your token is pend-1-2345, please confirm.",
      'call payments again with confirm="pend-9-1"',
      "pend-abc-def",
    ]) {
      expect(redactTokens(text)).not.toMatch(/pend-[\w-]+/);
    }
  });

  it("falls back to a generic prompt if redaction empties the reply", () => {
    expect(redactTokens("pend-1-2")).toContain("confirm");
  });

  /** End-to-end: a model that leaks must not reach the customer. */
  it("redacts a leaked token from a real supervisor reply", async () => {
    const { reply } = await run(
      [
        { toolCalls: [{ name: "payments", arguments: { toPayee: "alice", amountMinor: 20_000 } }] },
        // A badly behaved model echoing the specialist's internal summary.
        {
          text:
            'Ready to send £200.00 to Alice Chen from Current. NOT YET SENT — ask the ' +
            'customer to confirm, then call payments again with confirm="pend-1-1881108061".',
        },
      ],
      "send £200 to Alice",
    );

    expect(reply.text).not.toMatch(/pend-[\w-]+/);
    expect(reply.text).not.toContain("confirm=");
    expect(reply.text.toLowerCase()).toContain("confirm");
    // A token is still outstanding server-side.
    expect(reply.pendingToken).toMatch(/^pend-/);
  });
});

describe("capability boundary", () => {
  it("never gives the supervisor a ledger handle it could spend from", async () => {
    // The supervisor only ever receives summary strings. Assert that the
    // messages fed back to the model contain no ledger object.
    const { llm } = await run(
      [
        { toolCalls: [{ name: "balance", arguments: { question: "b" } }] },
        { text: "Done." },
      ],
      "balance?",
    );

    for (const request of llm.requests) {
      for (const message of request.messages) {
        expect(typeof message.content).toBe("string");
      }
    }
  });
});
