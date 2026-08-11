import { beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../bank/ledger.js";
import { FakeLlm, RecordingTrace } from "../testing/fakes.js";
import { balanceAgent } from "./balance.js";
import { loansAgent, monthlyPaymentMinor } from "./loans.js";
import { paymentsAgent } from "./payments.js";
import { agentByName, agents, toolDefinitions } from "./registry.js";
import type { AgentContext } from "./types.js";

function makeContext(overrides: Partial<AgentContext> = {}) {
  const ledger = overrides.ledger ?? new Ledger(undefined, () => Date.parse("2026-07-31T09:00:00Z"));
  const llm = overrides.llm ?? new FakeLlm([], "Here you go.");
  const trace = overrides.trace ?? new RecordingTrace();
  return { ledger, llm, trace, sessionId: "sess-test", ...overrides } as AgentContext & {
    ledger: Ledger;
    llm: FakeLlm;
    trace: RecordingTrace;
  };
}

describe("registry and tool generation", () => {
  it("exposes each agent exactly once", () => {
    expect(agents.map((a) => a.name)).toEqual(["balance", "payments", "loans"]);
    expect(new Set(agents.map((a) => a.name)).size).toBe(agents.length);
  });

  it("resolves agents by name and reports unknown ones", () => {
    expect(agentByName("balance")).toBe(balanceAgent);
    expect(agentByName("nope")).toBeUndefined();
  });

  it("derives OpenAI tool definitions from the registry", () => {
    const tools = toolDefinitions();
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description.length).toBeGreaterThan(20);
      expect(tool.function.parameters.type).toBe("object");
    }
    expect(tools.map((t) => t.function.name)).toEqual(["balance", "payments", "loans"]);
  });

  it("keeps every schema a closed object so the model cannot invent fields", () => {
    for (const agent of agents) {
      expect(agent.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("balance agent", () => {
  it("reads all accounts and phrases an answer", async () => {
    const ctx = makeContext({ llm: new FakeLlm([], "Current £1,240.00, Savings £8,500.00.") });

    const result = await balanceAgent.handle({ question: "what are my balances?" }, ctx);

    expect(result.failed).toBeUndefined();
    expect(result.summary).toContain("£1,240.00");
    const data = result.data as { accounts: unknown[] };
    expect(data.accounts).toHaveLength(2);
  });

  it("narrows to one account when given a hint", async () => {
    const ctx = makeContext();
    const result = await balanceAgent.handle(
      { question: "how much is in savings?", accountHint: "savings" },
      ctx,
    );
    const data = result.data as { accounts: { name: string }[] };
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]!.name).toBe("Savings");
  });

  it("refuses an unknown account instead of guessing", async () => {
    const ctx = makeContext();
    const result = await balanceAgent.handle(
      { question: "balance?", accountHint: "offshore" },
      ctx,
    );
    expect(result.failed).toBe(true);
    expect(result.summary).toContain("offshore");
    expect(ctx.llm.phraseCalls).toHaveLength(0);
  });

  it("passes real ledger figures to the model, never invented ones", async () => {
    const ctx = makeContext();
    await balanceAgent.handle({ question: "balances?" }, ctx);
    const sent = ctx.llm.phraseCalls[0]!.user;
    expect(sent).toContain("£1,240.00");
    expect(sent).toContain("£8,500.00");
  });

  it("falls back to raw figures if the model returns nothing", async () => {
    const ctx = makeContext({ llm: new FakeLlm([], "   ") });
    const result = await balanceAgent.handle({ question: "balances?" }, ctx);
    expect(result.summary).toContain("Current: £1,240.00");
  });

  it("records a trace span", async () => {
    const ctx = makeContext();
    await balanceAgent.handle({ question: "balances?" }, ctx);
    expect(ctx.trace.names()).toContain("balance.phrase");
  });
});

describe("loans agent", () => {
  describe("monthlyPaymentMinor", () => {
    it("computes a standard amortising payment", () => {
      // £10,000 over 24 months at 6.9% APR → £447.27/month.
      expect(monthlyPaymentMinor(1_000_000, 6.9, 24)).toBe(44_727);
      // Total repayable exceeds principal by roughly the interest charged.
      expect(44_727 * 24).toBeGreaterThan(1_000_000);
    });

    it("handles a zero rate as simple division", () => {
      expect(monthlyPaymentMinor(120_000, 0, 12)).toBe(10_000);
    });

    it("rejects a non-positive term", () => {
      expect(() => monthlyPaymentMinor(100_000, 5, 0)).toThrow();
    });
  });

  it("quotes eligible products with computed payments", async () => {
    const ctx = makeContext();
    const result = await loansAgent.handle(
      { question: "can I borrow £5,000 over 3 years?", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );
    const data = result.data as { quotes: { product: string; eligible: boolean; monthlyPayment?: string }[] };
    const personal = data.quotes.find((q) => q.product === "Personal Loan")!;
    expect(personal.eligible).toBe(true);
    expect(personal.monthlyPayment).toMatch(/^£\d/);
  });

  it("explains ineligibility rather than silently dropping a product", async () => {
    const ctx = makeContext();
    // £2,000 clears the personal-loan minimum (£1,000) but falls below the
    // car-finance (£3,000) and home-improvement (£5,000) minimums.
    const result = await loansAgent.handle(
      { question: "borrow £2,000?", amountMinor: 200_000, termMonths: 36 },
      ctx,
    );
    const data = result.data as {
      quotes: { product: string; eligible: boolean; ineligibleBecause?: string[] }[];
    };

    const personal = data.quotes.find((q) => q.product === "Personal Loan")!;
    expect(personal.eligible).toBe(true);

    for (const name of ["Car Finance", "Home Improvement Loan"]) {
      const quote = data.quotes.find((q) => q.product === name)!;
      expect(quote.eligible, `${name} should be ineligible at £2,000`).toBe(false);
      expect(quote.ineligibleBecause!.join(" ")).toContain("minimum");
      // An ineligible product must not carry a quote figure.
      expect(quote).not.toHaveProperty("monthlyPayment", expect.stringMatching(/£/));
    }
  });

  it("gates on income when the amount is in range", async () => {
    const ctx = makeContext();
    // Home improvement needs £2,500/month; estimated income is £2,850, so it
    // passes. Raise the bar by asking with an income the fixtures cannot support.
    const result = await loansAgent.handle(
      { question: "borrow £60,000?", amountMinor: 6_000_000, termMonths: 60 },
      ctx,
    );
    const data = result.data as {
      quotes: { product: string; eligible: boolean; ineligibleBecause?: string[] }[];
    };
    const personal = data.quotes.find((q) => q.product === "Personal Loan")!;
    expect(personal.eligible).toBe(false);
    expect(personal.ineligibleBecause!.join(" ")).toContain("maximum");
  });

  it("never lets the model see an un-computed payment figure", async () => {
    const ctx = makeContext();
    await loansAgent.handle({ question: "loan options?", amountMinor: 500_000 }, ctx);
    const sent = JSON.parse(ctx.llm.phraseCalls[0]!.user) as {
      quotes: { eligible: boolean; monthlyPayment?: string }[];
    };
    for (const quote of sent.quotes) {
      if (quote.eligible) expect(quote.monthlyPayment).toBeDefined();
    }
  });
});

describe("loan applications", () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext();
  });

  it("stages without submitting and returns a confirmation", async () => {
    const result = await loansAgent.handle(
      { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );

    expect(result.needsConfirmation).toBeDefined();
    expect(result.needsConfirmation!.token).toMatch(/^appl-/);
    expect(result.customerSafe).toContain("Please confirm");
    expect(result.customerSafe).toContain("£154.16");
    expect(result.summary).toContain("NOT YET SUBMITTED");
    // Nothing recorded yet.
    expect(ctx.ledger.listApplications()).toEqual([]);
  });

  it("submits only when given the token, with a reference", async () => {
    const staged = await loansAgent.handle(
      { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );

    const submitted = await loansAgent.handle(
      { confirm: staged.needsConfirmation!.token },
      ctx,
    );

    expect(submitted.failed).toBeUndefined();
    expect(submitted.summary).toMatch(/Reference APP\d+/);
    expect(submitted.summary).toContain("in review");

    const applications = ctx.ledger.listApplications();
    expect(applications).toHaveLength(1);
    expect(applications[0]!.productName).toBe("Personal Loan");
    expect(applications[0]!.amountMinor).toBe(500_000);
    expect(applications[0]!.monthlyPaymentMinor).toBe(15_416);
    expect(applications[0]!.status).toBe("in_review");
  });

  it("asks for an amount rather than guessing", async () => {
    const result = await loansAgent.handle({ apply: "loan-personal", termMonths: 36 }, ctx);
    expect(result.failed).toBe(true);
    expect(result.summary).toContain("How much");
  });

  it("asks for a term rather than guessing", async () => {
    const result = await loansAgent.handle({ apply: "loan-personal", amountMinor: 500_000 }, ctx);
    expect(result.failed).toBe(true);
    expect(result.summary).toContain("how many months");
  });

  it("refuses an unknown product", async () => {
    const result = await loansAgent.handle(
      { apply: "loan-yacht", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );
    expect(result.failed).toBe(true);
    expect((result.data as { code: string }).code).toBe("unknown_product");
  });

  it("refuses an amount outside the product's range", async () => {
    // Personal loan lends £1,000–£25,000.
    const result = await loansAgent.handle(
      { apply: "loan-personal", amountMinor: 50_000, termMonths: 36 },
      ctx,
    );
    expect(result.failed).toBe(true);
    expect((result.data as { code: string }).code).toBe("not_eligible");
    expect(result.summary).toContain("lends between");
  });

  it("refuses a term outside the product's range", async () => {
    const result = await loansAgent.handle(
      { apply: "loan-personal", amountMinor: 500_000, termMonths: 240 },
      ctx,
    );
    expect(result.failed).toBe(true);
    expect(result.summary).toContain("terms run");
  });

  it("is single-use — a token cannot be replayed", async () => {
    const staged = await loansAgent.handle(
      { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );
    const token = staged.needsConfirmation!.token;
    await loansAgent.handle({ confirm: token }, ctx);

    const replay = await loansAgent.handle({ confirm: token }, ctx);

    expect(replay.failed).toBe(true);
    expect((replay.data as { code: string }).code).toBe("unknown_token");
    // Still exactly one application, not two.
    expect(ctx.ledger.listApplications()).toHaveLength(1);
  });

  it("cancels a staged application", async () => {
    const staged = await loansAgent.handle(
      { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );
    const result = await loansAgent.handle(
      { cancel: staged.needsConfirmation!.token },
      ctx,
    );

    expect(result.summary).toContain("cancelled");
    expect(ctx.ledger.listApplications()).toEqual([]);
  });

  /**
   * The counterpart to the payment re-validation test: eligibility is not frozen
   * at quote time. Here income collapses between staging and confirming.
   */
  it("re-validates eligibility at submit time", async () => {
    const staged = await loansAgent.handle(
      { apply: "loan-home-improve", amountMinor: 1_000_000, termMonths: 60 },
      ctx,
    );

    // Wipe the salary history the income estimate depends on.
    ctx.ledger.estimatedMonthlyIncomeMinor = () => 0;

    const result = await loansAgent.handle(
      { confirm: staged.needsConfirmation!.token },
      ctx,
    );

    expect(result.failed).toBe(true);
    expect((result.data as { code: string }).code).toBe("not_eligible");
    expect(ctx.ledger.listApplications()).toEqual([]);
  });

  it("never calls the model — references and figures are deterministic", async () => {
    const staged = await loansAgent.handle(
      { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );
    await loansAgent.handle({ confirm: staged.needsConfirmation!.token }, ctx);
    expect(ctx.llm.phraseCalls).toHaveLength(0);
  });

  it("traces stage and submit separately", async () => {
    const staged = await loansAgent.handle(
      { apply: "loan-personal", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );
    await loansAgent.handle({ confirm: staged.needsConfirmation!.token }, ctx);

    expect(ctx.trace.names()).toEqual([
      "loans.stageApplication",
      "loans.submitApplication",
    ]);
    expect(ctx.trace.notes.map((n) => n.message)).toEqual([
      "application staged, awaiting confirmation",
      "application submitted",
    ]);
  });

  it("exposes product ids on quotes so the model can apply", async () => {
    const result = await loansAgent.handle(
      { question: "loan options?", amountMinor: 500_000, termMonths: 36 },
      ctx,
    );
    const data = result.data as { quotes: { productId: string }[] };
    expect(data.quotes.map((q) => q.productId)).toContain("loan-personal");
  });
});

describe("payments agent", () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext();
  });

  it("stages without moving money and returns a confirmation", async () => {
    const before = ctx.ledger.getAccount("acc-current").balanceMinor;

    const result = await paymentsAgent.handle({ toPayee: "alice", amountMinor: 20_000 }, ctx);

    expect(result.needsConfirmation).toBeDefined();
    expect(result.needsConfirmation!.token).toMatch(/^pend-/);
    expect(result.needsConfirmation!.describe).toContain("£200.00");
    expect(result.summary).toContain("NOT YET SENT");
    expect(ctx.ledger.getAccount("acc-current").balanceMinor).toBe(before);
  });

  it("commits only when given the token", async () => {
    const staged = await paymentsAgent.handle({ toPayee: "alice", amountMinor: 20_000 }, ctx);
    const token = staged.needsConfirmation!.token;

    const committed = await paymentsAgent.handle({ confirm: token }, ctx);

    expect(committed.needsConfirmation).toBeUndefined();
    expect(committed.summary).toContain("Paid £200.00 to Alice Chen");
    expect(committed.summary).toMatch(/Reference REF\d+/);
    expect(ctx.ledger.getAccount("acc-current").balanceMinor).toBe(104_000);
  });

  it("asks for a payee instead of guessing", async () => {
    const result = await paymentsAgent.handle({ amountMinor: 5_000 }, ctx);
    expect(result.failed).toBe(true);
    expect(result.summary).toContain("Who should");
  });

  it("asks for an amount instead of guessing", async () => {
    const result = await paymentsAgent.handle({ toPayee: "alice" }, ctx);
    expect(result.failed).toBe(true);
    expect(result.summary).toContain("How much");
  });

  it.each([
    ["a fractional amount", { toPayee: "alice", amountMinor: 12.5 }],
    ["a negative amount", { toPayee: "alice", amountMinor: -100 }],
    ["a zero amount", { toPayee: "alice", amountMinor: 0 }],
  ])("refuses %s", async (_label, input) => {
    const result = await paymentsAgent.handle(input, ctx);
    expect(result.failed).toBe(true);
    expect(ctx.ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("reports an unsaved payee as a failure the supervisor can explain", async () => {
    const result = await paymentsAgent.handle({ toPayee: "Mallory", amountMinor: 100 }, ctx);
    expect(result.failed).toBe(true);
    expect(result.summary).toContain("saved payees");
    expect((result.data as { code: string }).code).toBe("unknown_payee");
  });

  it("reports insufficient funds without moving money", async () => {
    const result = await paymentsAgent.handle({ toPayee: "alice", amountMinor: 999_999 }, ctx);
    expect(result.failed).toBe(true);
    expect((result.data as { code: string }).code).toBe("insufficient_funds");
    expect(ctx.ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("cancels a staged payment", async () => {
    const staged = await paymentsAgent.handle({ toPayee: "alice", amountMinor: 20_000 }, ctx);
    const result = await paymentsAgent.handle(
      { cancel: staged.needsConfirmation!.token },
      ctx,
    );
    expect(result.summary).toContain("cancelled");
    expect(ctx.ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("refuses a replayed token", async () => {
    const staged = await paymentsAgent.handle({ toPayee: "alice", amountMinor: 5_000 }, ctx);
    const token = staged.needsConfirmation!.token;
    await paymentsAgent.handle({ confirm: token }, ctx);

    const replay = await paymentsAgent.handle({ confirm: token }, ctx);

    expect(replay.failed).toBe(true);
    expect((replay.data as { code: string }).code).toBe("unknown_token");
    expect(ctx.ledger.getAccount("acc-current").balanceMinor).toBe(119_000);
  });

  it("re-validates at commit time and refuses if funds have gone", async () => {
    const staged = await paymentsAgent.handle({ toPayee: "alice", amountMinor: 150_000 }, ctx);

    // A direct debit clears between staging and confirming.
    ctx.ledger.applyExternalDebit("acc-current", 160_000);

    const result = await paymentsAgent.handle(
      { confirm: staged.needsConfirmation!.token },
      ctx,
    );

    expect(result.failed).toBe(true);
    expect((result.data as { code: string }).code).toBe("insufficient_funds");
    // The refused payment moved nothing; only the external debit applied.
    expect(ctx.ledger.getAccount("acc-current").balanceMinor).toBe(-36_000);
  });

  it("reserves funds at stage time so a second payment cannot overdraw", async () => {
    await paymentsAgent.handle({ toPayee: "alice", amountMinor: 150_000 }, ctx);

    const second = await paymentsAgent.handle({ toPayee: "bob", amountMinor: 150_000 }, ctx);

    expect(second.failed).toBe(true);
    expect((second.data as { code: string }).code).toBe("insufficient_funds");
  });

  it("never calls the model — money figures are deterministic", async () => {
    const staged = await paymentsAgent.handle({ toPayee: "alice", amountMinor: 20_000 }, ctx);
    await paymentsAgent.handle({ confirm: staged.needsConfirmation!.token }, ctx);
    expect(ctx.llm.phraseCalls).toHaveLength(0);
    expect(ctx.llm.turnsUsed).toBe(0);
  });

  it("traces stage and commit separately", async () => {
    const staged = await paymentsAgent.handle({ toPayee: "alice", amountMinor: 20_000 }, ctx);
    await paymentsAgent.handle({ confirm: staged.needsConfirmation!.token }, ctx);
    expect(ctx.trace.names()).toEqual(["payments.stage", "payments.commit"]);
    expect(ctx.trace.notes.map((n) => n.message)).toEqual([
      "payment staged, awaiting confirmation",
      "payment committed",
    ]);
  });
});
