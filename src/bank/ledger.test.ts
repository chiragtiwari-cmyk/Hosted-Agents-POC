import { describe, expect, it } from "vitest";
import bankFixture from "./bank.json" with { type: "json" };
import { type BankData, Ledger, LedgerError, PENDING_TTL_MS, formatMoney } from "./ledger.js";

/**
 * A ledger with a controllable clock, set just after the newest fixture
 * transaction (2026-07-30) so newly recorded payments are dated "today"
 * relative to the fixture history.
 */
function makeLedger() {
  let nowMs = Date.parse("2026-07-31T09:00:00Z");
  const ledger = new Ledger(undefined, () => nowMs);
  return {
    ledger,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("formatMoney", () => {
  it("formats pence as pounds with two decimal places", () => {
    expect(formatMoney(124000)).toBe("£1,240.00");
    expect(formatMoney(5)).toBe("£0.05");
    expect(formatMoney(0)).toBe("£0.00");
    expect(formatMoney(-6318)).toBe("-£63.18");
  });
});

describe("account lookup", () => {
  it("finds accounts by name, partial name and masked number", () => {
    const { ledger } = makeLedger();
    expect(ledger.findAccount("Current")?.id).toBe("acc-current");
    expect(ledger.findAccount("savings")?.id).toBe("acc-savings");
    expect(ledger.findAccount("4417")?.id).toBe("acc-current");
  });

  it("returns undefined for unknown or empty hints", () => {
    const { ledger } = makeLedger();
    expect(ledger.findAccount("offshore")).toBeUndefined();
    expect(ledger.findAccount("")).toBeUndefined();
    expect(ledger.findAccount(undefined)).toBeUndefined();
  });

  it("defaults to the current account", () => {
    const { ledger } = makeLedger();
    expect(ledger.defaultAccount().id).toBe("acc-current");
  });

  it("hands out copies so callers cannot mutate ledger state", () => {
    const { ledger } = makeLedger();
    const account = ledger.getAccount("acc-current");
    account.balanceMinor = 999;
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124000);
  });
});

describe("payee lookup", () => {
  it("matches exact names and aliases", () => {
    const { ledger } = makeLedger();
    expect(ledger.findPayee("alice")?.id).toBe("payee-alice");
    expect(ledger.findPayee("Alice Chen")?.id).toBe("payee-alice");
    expect(ledger.findPayee("credit card")?.id).toBe("payee-card");
  });

  it("matches loosely so natural phrasing resolves", () => {
    const { ledger } = makeLedger();
    expect(ledger.findPayee("my aurora card")?.id).toBe("payee-card");
  });

  it("returns undefined for an unsaved payee", () => {
    const { ledger } = makeLedger();
    expect(ledger.findPayee("Mallory")).toBeUndefined();
  });
});

describe("stagePayment", () => {
  it("stages without moving money", () => {
    const { ledger } = makeLedger();
    const before = ledger.getAccount("acc-current").balanceMinor;

    const { pending, from, to } = ledger.stagePayment({
      toPayeeHint: "alice",
      amountMinor: 20000,
    });

    expect(pending.token).toMatch(/^pend-/);
    expect(from.id).toBe("acc-current");
    expect(to.id).toBe("payee-alice");
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(before);
  });

  it("rejects an unknown payee", () => {
    const { ledger } = makeLedger();
    expect(() => ledger.stagePayment({ toPayeeHint: "Mallory", amountMinor: 100 }))
      .toThrowError(expect.objectContaining({ code: "unknown_payee" }));
  });

  it("rejects an unknown source account", () => {
    const { ledger } = makeLedger();
    expect(() =>
      ledger.stagePayment({
        fromAccountHint: "offshore",
        toPayeeHint: "alice",
        amountMinor: 100,
      }),
    ).toThrowError(expect.objectContaining({ code: "unknown_account" }));
  });

  it.each([0, -1, 12.5])("rejects the invalid amount %s", (amount) => {
    const { ledger } = makeLedger();
    expect(() => ledger.stagePayment({ toPayeeHint: "alice", amountMinor: amount }))
      .toThrowError(expect.objectContaining({ code: "invalid_amount" }));
  });

  it("allows spending into the overdraft but not past it", () => {
    // Current: £1,240 available + £500 overdraft = £1,740 ceiling.
    expect(() => makeLedger().ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 174000 }))
      .not.toThrow();
    // A fresh ledger — staging reserves funds, so reuse would skew the ceiling.
    expect(() => makeLedger().ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 174001 }))
      .toThrowError(expect.objectContaining({ code: "insufficient_funds" }));
  });

  it("reserves funds when staging so two payments cannot jointly overdraw", () => {
    const { ledger } = makeLedger();
    // £1,240 balance + £500 overdraft. Stage £1,000, leaving £740 of headroom.
    ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 100_000 });
    expect(ledger.getAccount("acc-current").availableMinor).toBe(24_000);
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124_000);

    // A second £1,000 would exceed the remaining £740 headroom.
    expect(() => ledger.stagePayment({ toPayeeHint: "bob", amountMinor: 100_000 }))
      .toThrowError(expect.objectContaining({ code: "insufficient_funds" }));
  });

  it("releases the reservation when a staged payment is cancelled", () => {
    const { ledger } = makeLedger();
    const { pending } = ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 100_000 });
    expect(ledger.getAccount("acc-current").availableMinor).toBe(24_000);

    ledger.cancelPending(pending.token);

    expect(ledger.getAccount("acc-current").availableMinor).toBe(124_000);
    expect(() => ledger.stagePayment({ toPayeeHint: "bob", amountMinor: 100_000 })).not.toThrow();
  });

  it("releases the reservation when a staged payment expires", () => {
    const { ledger, advance } = makeLedger();
    const { pending } = ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 100_000 });
    advance(PENDING_TTL_MS + 1);

    expect(() => ledger.commitPayment(pending.token))
      .toThrowError(expect.objectContaining({ code: "token_expired" }));

    // Funds must not be stranded as permanently unavailable.
    expect(ledger.getAccount("acc-current").availableMinor).toBe(124_000);
  });

  it("has no overdraft headroom on savings", () => {
    const { ledger } = makeLedger();
    expect(() =>
      ledger.stagePayment({
        fromAccountHint: "savings",
        toPayeeHint: "alice",
        amountMinor: 850001,
      }),
    ).toThrowError(expect.objectContaining({ code: "insufficient_funds" }));
  });
});

describe("commitPayment", () => {
  it("debits the source account and records a transaction", () => {
    const { ledger } = makeLedger();
    const { pending } = ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 20000 });

    const { receipt } = ledger.commitPayment(pending.token);

    expect(receipt.amountMinor).toBe(20000);
    expect(receipt.newBalanceMinor).toBe(104000);
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(104000);
    expect(ledger.recentTransactions("acc-current")[0]?.description).toBe("Payment to Alice Chen");
  });

  it("credits the destination when it is an internal account", () => {
    // Add savings as a payee so an internal transfer is expressible.
    const data = structuredClone(bankFixture) as BankData;
    const ledger = new Ledger({
      ...data,
      payees: [
        ...data.payees,
        {
          id: "acc-savings",
          name: "My Savings",
          aliases: ["my savings"],
          sortCode: "04-00-72",
          numberMasked: "****9021",
        },
      ],
    });

    const { pending } = ledger.stagePayment({ toPayeeHint: "my savings", amountMinor: 10000 });
    ledger.commitPayment(pending.token);

    expect(ledger.getAccount("acc-current").balanceMinor).toBe(114000);
    expect(ledger.getAccount("acc-savings").balanceMinor).toBe(860000);
  });

  it("is single-use — a token cannot be replayed", () => {
    const { ledger } = makeLedger();
    const { pending } = ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 5000 });

    ledger.commitPayment(pending.token);

    expect(() => ledger.commitPayment(pending.token))
      .toThrowError(expect.objectContaining({ code: "unknown_token" }));
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(119000);
  });

  it("rejects a token that was never issued", () => {
    const { ledger } = makeLedger();
    expect(() => ledger.commitPayment("pend-nope")).toThrowError(
      expect.objectContaining({ code: "unknown_token" }),
    );
  });

  it("refuses a token that has aged past its TTL", () => {
    const { ledger, advance } = makeLedger();
    const { pending } = ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 5000 });

    advance(PENDING_TTL_MS + 1);

    expect(() => ledger.commitPayment(pending.token))
      .toThrowError(expect.objectContaining({ code: "token_expired" }));
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124000);
  });

  /**
   * The case the whole confirmation design exists for: funds were sufficient at
   * stage time but not at commit time.
   */
  /**
   * The case the whole confirmation design exists for. Reservations prevent the
   * common version of this (two staged payments overlapping), so to reach the
   * commit-time check the balance must move by a path that does not reserve —
   * here, an external debit landing between stage and confirm.
   */
  it("re-validates funds at commit time and refuses if they have gone", () => {
    const { ledger } = makeLedger();
    const staged = ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 150_000 });

    // A direct debit clears after staging, wiping out the balance behind us.
    ledger.applyExternalDebit("acc-current", 160_000);

    expect(() => ledger.commitPayment(staged.pending.token))
      .toThrowError(expect.objectContaining({ code: "insufficient_funds" }));
    // Nothing moved on the refused payment.
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(-36_000);
  });

  it("commits when funds are still there at confirm time", () => {
    const { ledger } = makeLedger();
    const staged = ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 20_000 });
    const { receipt } = ledger.commitPayment(staged.pending.token);

    expect(receipt.newBalanceMinor).toBe(104_000);
    // The reservation is consumed exactly once, not double-counted.
    expect(ledger.getAccount("acc-current").availableMinor).toBe(104_000);
  });
});

describe("cancelPending", () => {
  it("discards a staged payment", () => {
    const { ledger } = makeLedger();
    const { pending } = ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 5000 });

    expect(ledger.cancelPending(pending.token)).toBe(true);
    expect(ledger.peekPending(pending.token)).toBeUndefined();
    expect(() => ledger.commitPayment(pending.token)).toThrowError(LedgerError);
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124000);
  });

  it("reports false for an unknown token", () => {
    const { ledger } = makeLedger();
    expect(ledger.cancelPending("pend-nope")).toBe(false);
  });
});

describe("transactions and income", () => {
  it("returns transactions newest first, filtered by account", () => {
    const { ledger } = makeLedger();
    const txns = ledger.recentTransactions("acc-current", 3);
    expect(txns).toHaveLength(3);
    expect(txns.every((t) => t.accountId === "acc-current")).toBe(true);
    expect(txns[0]!.date >= txns[1]!.date).toBe(true);
  });

  it("estimates monthly income from salary credits", () => {
    const { ledger } = makeLedger();
    // One salary credit of £2,850 in a single month.
    expect(ledger.estimatedMonthlyIncomeMinor()).toBe(285000);
  });
});
