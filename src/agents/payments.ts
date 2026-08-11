/**
 * Payments agent — the only agent that changes state.
 *
 * Two modes, keyed on whether a `confirm` token is present:
 *
 *   no token  → validate and STAGE. Nothing moves. Returns needsConfirmation.
 *   token     → RE-VALIDATE and commit. Returns a receipt.
 *
 * The token references an intent; it is never a pre-authorization. Re-validation
 * at commit time is what makes that true, and it is the single most important
 * line of behaviour in this project.
 *
 * Note this agent does not phrase its own replies through the model. Money
 * movement should read back to the customer as exact, unembellished figures, so
 * the strings here are deterministic. The supervisor may reword, but the numbers
 * it is handed are computed.
 */
import { LedgerError, formatMoney } from "../bank/ledger.js";
import type { Agent, AgentContext, AgentResult } from "./types.js";

export const paymentsAgent: Agent = {
  name: "payments",
  description:
    "Move money to a saved payee. Call WITHOUT 'confirm' to validate and stage a " +
    "payment — this does not move money and returns a confirmation request. Call " +
    "again WITH the 'confirm' token only after the customer has explicitly agreed. " +
    "Use for 'send £200 to Alice', 'pay my credit card'.",
  inputSchema: {
    type: "object",
    properties: {
      toPayee: {
        type: "string",
        description: "Payee name or alias, e.g. 'Alice' or 'credit card'. Required when staging.",
      },
      amountMinor: {
        type: "integer",
        description: "Amount in pence, e.g. 20000 for £200.00. Required when staging.",
      },
      fromAccount: {
        type: "string",
        description: "Optional source account name. Defaults to the Current account.",
      },
      confirm: {
        type: "string",
        description:
          "The confirmation token from a previous staged payment. Supply this ONLY " +
          "after the customer has explicitly confirmed.",
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

    if (cancelToken) return cancel(cancelToken, ctx);
    if (confirmToken) return commit(confirmToken, ctx);
    return stage(input, ctx);
  },
};

function cancel(token: string, ctx: AgentContext): AgentResult {
  const existed = ctx.ledger.cancelPending(token);
  ctx.trace.note(existed ? "payment cancelled" : "nothing to cancel", { token });
  return {
    summary: existed
      ? "The payment was cancelled. No money has moved."
      : "There was no pending payment to cancel.",
    data: { cancelled: existed },
  };
}

async function commit(token: string, ctx: AgentContext): Promise<AgentResult> {
  return ctx.trace.span(
    "payments.commit",
    { "gen_ai.operation.name": "payments.commit" },
    async () => {
      try {
        const { receipt, from, to } = ctx.ledger.commitPayment(token);
        ctx.trace.note("payment committed", {
          reference: receipt.reference,
          amountMinor: receipt.amountMinor,
        });
        return {
          summary:
            `Paid ${formatMoney(receipt.amountMinor)} to ${to.name} from ${from.name}. ` +
            `Reference ${receipt.reference}. ` +
            `${from.name} balance is now ${formatMoney(receipt.newBalanceMinor)}.`,
          data: { receipt, committed: true },
        };
      } catch (error) {
        return failure(error, ctx, "commit");
      }
    },
  );
}

async function stage(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<AgentResult> {
  return ctx.trace.span(
    "payments.stage",
    { "gen_ai.operation.name": "payments.stage" },
    async () => {
      const toPayee = optionalString(input.toPayee);
      const amountMinor = input.amountMinor;

      // Ask rather than guess. A wrong payee or amount is not recoverable.
      if (!toPayee) {
        return {
          summary: "Who should the payment go to? I need a saved payee name.",
          failed: true,
        };
      }
      if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0) {
        return {
          summary: `How much should I send to ${toPayee}?`,
          failed: true,
        };
      }

      try {
        const { pending, from, to } = ctx.ledger.stagePayment({
          fromAccountHint: optionalString(input.fromAccount),
          toPayeeHint: toPayee,
          amountMinor,
        });

        const describe =
          `${formatMoney(pending.amountMinor)} to ${to.name} (${to.numberMasked}) ` +
          `from ${from.name}`;

        ctx.trace.note("payment staged, awaiting confirmation", {
          token: pending.token,
          amountMinor: pending.amountMinor,
        });

        return {
          // Written for the SUPERVISOR, not the customer. It names the token so
          // the model can replay it; the supervisor's system prompt forbids
          // repeating tokens verbatim, and `customerSafe` gives it wording to use.
          summary:
            `Ready to send ${describe}. NOT YET SENT — ask the customer to confirm, ` +
            `then call payments again with confirm="${pending.token}". ` +
            `Do not show the token to the customer.`,
          customerSafe: `Please confirm: send ${describe}?`,
          needsConfirmation: { ...pending, describe },
          data: { staged: true, describe, token: pending.token },
        };
      } catch (error) {
        return failure(error, ctx, "stage");
      }
    },
  );
}

/**
 * Ledger errors are conditions the customer should hear about, so they come back
 * as a normal result the supervisor can explain. Anything else is a real defect
 * and rethrows.
 */
function failure(error: unknown, ctx: AgentContext, phase: string): AgentResult {
  if (error instanceof LedgerError) {
    ctx.trace.note(`payment ${phase} refused: ${error.code}`, { code: error.code });
    return { summary: error.message, failed: true, data: { code: error.code } };
  }
  throw error;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
