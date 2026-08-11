/**
 * Loans agent — read-only.
 *
 * Eligibility and indicative quotes. Deliberately does not submit applications:
 * an irreversible action needs the confirmation machinery, and one agent
 * demonstrating that (payments) is enough for the workshop.
 *
 * The repayment maths is computed in TypeScript, not by the model. Models are
 * unreliable at arithmetic, and a wrong APR figure in a banking demo is a bad
 * look — so the model only phrases numbers it is handed.
 */
import { LedgerError, amortisingPaymentMinor, formatMoney } from "../bank/ledger.js";
import type { Agent, AgentContext, AgentResult } from "./types.js";

const INSTRUCTIONS = `You are a retail bank's lending assistant.
You are given loan products, the customer's estimated income, and pre-computed
quotes as JSON. Answer using ONLY that data.

Rules:
- Never invent a rate, a monthly payment, or an eligibility decision.
- Quote the monthly payment and total repayable exactly as given.
- Say clearly that figures are indicative and not a formal offer.
- Be brief: three sentences at most, or a short list when comparing products.
- Applications are submitted through a separate confirmation step, so do not say
  the customer must contact a branch or website.`;

/**
 * Standard amortising loan payment, in minor units.
 *
 * The implementation moved to the ledger, which needs it to quote a staged
 * application. Re-exported under the original name so callers and tests that
 * know it as `monthlyPaymentMinor` keep working.
 */
export const monthlyPaymentMinor = amortisingPaymentMinor;

export const loansAgent: Agent = {
  name: "loans",
  description:
    "Quote loans and submit applications. Call with just a question for indicative " +
    "quotes (monthly payment, total repayable). To apply, call with 'apply' set to a " +
    "product id — this validates and stages the application WITHOUT submitting, and " +
    "returns a confirmation request. Call again with 'confirm' only after the " +
    "customer has explicitly agreed. Never moves money.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The customer's lending question, in their own words.",
      },
      amountMinor: {
        type: "integer",
        description: "Requested amount in pence, if the customer named one. e.g. 500000 for £5,000.",
      },
      termMonths: {
        type: "integer",
        description: "Requested term in months, if the customer named one.",
      },
      apply: {
        type: "string",
        description:
          "Product id to apply for: 'loan-personal', 'loan-auto' or " +
          "'loan-home-improve'. Requires amountMinor and termMonths. Stages the " +
          "application; does NOT submit it.",
      },
      confirm: {
        type: "string",
        description:
          "The confirmation token from a staged application. Supply ONLY after the " +
          "customer has explicitly confirmed.",
      },
      cancel: {
        type: "string",
        description: "A confirmation token to discard, if the customer declined.",
      },
    },
    additionalProperties: false,
  },

  async handle(input, ctx: AgentContext): Promise<AgentResult> {
    const confirmToken = optionalString(input.confirm);
    const cancelToken = optionalString(input.cancel);
    const applyProductId = optionalString(input.apply);

    if (cancelToken) return cancelApplication(cancelToken, ctx);
    if (confirmToken) return submitApplication(confirmToken, ctx);
    if (applyProductId) return stageApplication(applyProductId, input, ctx);

    const question = String(input.question ?? "").trim();
    const amountMinor = toPositiveInt(input.amountMinor);
    const termMonths = toPositiveInt(input.termMonths);

    const incomeMinor = ctx.ledger.estimatedMonthlyIncomeMinor();
    const products = ctx.ledger.listLoanProducts();

    const quotes = products.map((product) => {
      const amount = amountMinor ?? product.minAmountMinor;
      const term = termMonths ?? Math.min(36, product.maxTermMonths);

      const reasons: string[] = [];
      if (amount < product.minAmountMinor) {
        reasons.push(`minimum is ${formatMoney(product.minAmountMinor)}`);
      }
      if (amount > product.maxAmountMinor) {
        reasons.push(`maximum is ${formatMoney(product.maxAmountMinor)}`);
      }
      if (term < product.minTermMonths || term > product.maxTermMonths) {
        reasons.push(`term must be ${product.minTermMonths}–${product.maxTermMonths} months`);
      }
      if (incomeMinor < product.minMonthlyIncomeMinor) {
        reasons.push(
          `needs monthly income of ${formatMoney(product.minMonthlyIncomeMinor)}, ` +
            `estimated ${formatMoney(incomeMinor)}`,
        );
      }

      const eligible = reasons.length === 0;
      const payment = eligible ? monthlyPaymentMinor(amount, product.aprPercent, term) : undefined;

      return {
        // The id is included so the model can pass it back as `apply`.
        productId: product.id,
        product: product.name,
        apr: `${product.aprPercent}%`,
        requested: formatMoney(amount),
        termMonths: term,
        eligible,
        ineligibleBecause: reasons.length ? reasons : undefined,
        monthlyPayment: payment !== undefined ? formatMoney(payment) : undefined,
        totalRepayable: payment !== undefined ? formatMoney(payment * term) : undefined,
      };
    });

    /*
     * Credit check over MCP — the transport Foundry's Toolbox uses.
     *
     * The score is advisory here: it annotates the quotes rather than gating them,
     * because a tool outage must not silently make a customer ineligible. If the
     * bureau is down we say so and quote on ledger facts alone.
     */
    let credit: { score: number; tier: string; factors: string[] } | undefined;
    let creditUnavailable: string | undefined;

    if (ctx.tools?.credit) {
      const result = await ctx.trace.span(
        "loans.creditCheck",
        { "gen_ai.operation.name": "tool.credit.score", transport: "mcp" },
        () =>
          ctx.tools!.credit!.creditScore({
            customerId: ctx.ledger.customer.id,
            agentSessionId: ctx.sessionId,
          }),
      );

      if (result.ok) {
        credit = {
          score: result.value.score,
          tier: result.value.tier,
          factors: result.value.factors,
        };
        ctx.trace.note(
          `credit.score ok via ${result.transport} in ${result.durationMs} ms: ` +
            `${result.value.score} (${result.value.tier})`,
          { score: result.value.score, tier: result.value.tier },
        );
      } else {
        creditUnavailable = result.reason;
        ctx.trace.note(`credit.score failed (${result.code}): ${result.reason}`);
      }
    }

    const payload = {
      ...(credit ? { creditCheck: credit } : {}),
      ...(creditUnavailable
        ? {
            creditCheckUnavailable:
              `Credit check unavailable: ${creditUnavailable}. Quote on the figures ` +
              `below and mention that a credit check will follow. Do NOT invent a score.`,
          }
        : {}),
      estimatedMonthlyIncome: formatMoney(incomeMinor),
      assumedAmount: amountMinor ? formatMoney(amountMinor) : "not specified",
      assumedTermMonths: termMonths ?? "not specified",
      quotes,
    };

    const summary = await ctx.trace.span(
      "loans.phrase",
      {
        "gen_ai.operation.name": "loans",
        eligibleProducts: quotes.filter((q) => q.eligible).length,
      },
      () => ctx.llm.phrase(INSTRUCTIONS, JSON.stringify({ question, ...payload })),
    );

    return {
      summary: summary.trim() || fallback(quotes),
      data: payload,
    };
  },
};

/* ------------------------------------------------------- application flow --- */

/*
 * Same two-step shape as payments: stage, then confirm. Deliberately so — the
 * confirmation gate should look like a reusable primitive of this runtime rather
 * than a quirk of the payments agent.
 *
 * These paths do not call the model. An application reference and a repayment
 * figure must read back exactly as computed.
 */

async function stageApplication(
  productId: string,
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<AgentResult> {
  return ctx.trace.span(
    "loans.stageApplication",
    { "gen_ai.operation.name": "loans.stageApplication", productId },
    async () => {
      const amountMinor = toPositiveInt(input.amountMinor);
      const termMonths = toPositiveInt(input.termMonths);

      // Ask rather than guess: a wrong amount or term is not a recoverable error.
      if (!amountMinor) {
        return { summary: "How much would the customer like to borrow?", failed: true };
      }
      if (!termMonths) {
        return { summary: "Over how many months should the loan run?", failed: true };
      }

      try {
        const { pending, product } = ctx.ledger.stageApplication({
          productId,
          amountMinor,
          termMonths,
        });

        const describe =
          `${product.name}: ${formatMoney(pending.amountMinor)} over ` +
          `${pending.termMonths} months at ${pending.aprPercent}% APR, ` +
          `${formatMoney(pending.monthlyPaymentMinor)} a month ` +
          `(${formatMoney(pending.monthlyPaymentMinor * pending.termMonths)} total)`;

        ctx.trace.note("application staged, awaiting confirmation", {
          token: pending.token,
          amountMinor: pending.amountMinor,
        });

        return {
          summary:
            `Ready to apply — ${describe}. NOT YET SUBMITTED. Ask the customer to ` +
            `confirm, then call loans again with confirm="${pending.token}". ` +
            `Do not show the token to the customer.`,
          customerSafe: `Please confirm: apply for ${describe}?`,
          needsConfirmation: {
            ...pending,
            // The shared type carries payment fields; an application has no
            // source account or payee, so these are marked not applicable.
            fromAccountId: "n/a",
            toPayeeId: product.id,
            describe,
          },
          data: { stagedApplication: true, describe, token: pending.token },
        };
      } catch (error) {
        return applicationFailure(error, ctx, "stage");
      }
    },
  );
}

async function submitApplication(token: string, ctx: AgentContext): Promise<AgentResult> {
  return ctx.trace.span(
    "loans.submitApplication",
    { "gen_ai.operation.name": "loans.submitApplication" },
    async () => {
      try {
        const { application } = ctx.ledger.submitApplication(token);
        ctx.trace.note("application submitted", {
          reference: application.reference,
          amountMinor: application.amountMinor,
        });
        return {
          summary:
            `Application submitted. Reference ${application.reference}: ` +
            `${application.productName}, ${formatMoney(application.amountMinor)} over ` +
            `${application.termMonths} months at ${application.aprPercent}% APR, ` +
            `${formatMoney(application.monthlyPaymentMinor)} a month. ` +
            `Status: in review — a banker will review it within 2 working days.`,
          data: { application, submitted: true },
        };
      } catch (error) {
        return applicationFailure(error, ctx, "submit");
      }
    },
  );
}

function cancelApplication(token: string, ctx: AgentContext): AgentResult {
  const existed = ctx.ledger.cancelPendingApplication(token);
  ctx.trace.note(existed ? "application cancelled" : "nothing to cancel", { token });
  return {
    summary: existed
      ? "The application was cancelled. Nothing has been submitted."
      : "There was no pending application to cancel.",
    data: { cancelled: existed },
  };
}

/** Ledger errors are for the customer; anything else is a defect and rethrows. */
function applicationFailure(error: unknown, ctx: AgentContext, phase: string): AgentResult {
  if (error instanceof LedgerError) {
    ctx.trace.note(`application ${phase} refused: ${error.code}`, { code: error.code });
    return { summary: error.message, failed: true, data: { code: error.code } };
  }
  throw error;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function fallback(quotes: { product: string; eligible: boolean; monthlyPayment?: string }[]): string {
  const eligible = quotes.filter((q) => q.eligible);
  if (eligible.length === 0) return "No products match on the current figures.";
  return eligible
    .map((q) => `${q.product}: ${q.monthlyPayment ?? "n/a"} per month`)
    .join(", ");
}
