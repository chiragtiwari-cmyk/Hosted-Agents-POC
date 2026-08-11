/**
 * Balance agent — read-only.
 *
 * Reads the ledger directly and uses the model only to phrase the answer. That
 * split is deliberate: the interesting behaviour of this system lives in the
 * orchestration, not inside a specialist.
 */
import { formatMoney } from "../bank/ledger.js";
import type { Agent, AgentContext, AgentResult } from "./types.js";

const INSTRUCTIONS = `You are a retail bank's balance assistant.
You are given the customer's real account data as JSON. Answer their question about
balances or recent spending using ONLY that data.

Rules:
- Never invent an account, transaction, or figure that is not in the data.
- Format money with a pound sign and two decimal places.
- Be brief: two sentences at most unless listing transactions.
- If listing transactions, use a short bulleted list with dates and amounts.
- You cannot move money. If asked to, say that a payment request is needed.
- Every per-account figure is in POUNDS STERLING (the field names end in GBP).
  Never relabel a sterling figure as another currency.
- If 'convertedTotal' is present it is an exact figure from the FX service. Read
  it carefully:
    'sterlingTotal' is the COMBINED total of every account listed, in pounds.
    'total' is that same combined amount converted at 'rate'.
  State both, name the rate, and make clear the converted figure is the total
  across all accounts — never present one account's balance as the total. Do NOT
  say "approximately" and do NOT tell the customer to check the rate themselves:
  hedging an exact number makes it look like a guess.
- If 'conversionUnavailable' is present, give sterling figures only and say the
  conversion is unavailable. Never estimate a converted amount.`;

export const balanceAgent: Agent = {
  name: "balance",
  description:
    "Look up account balances, available funds, and recent transactions. Read-only — " +
    "cannot move money. Use for questions like 'what's my balance', 'how much did I " +
    "spend on groceries', 'show recent transactions'.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The customer's balance or spending question, in their own words.",
      },
      accountHint: {
        type: "string",
        description:
          "Optional account name if the customer named one, e.g. 'Current' or 'Savings'. " +
          "Omit to cover all accounts.",
      },
      currency: {
        type: "string",
        description:
          "Optional target currency ('EUR' or 'USD') when the customer asks for their " +
          "balance in another currency. Converted via the FX service.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },

  async handle(input, ctx: AgentContext): Promise<AgentResult> {
    const question = String(input.question ?? "").trim();
    const accountHint = input.accountHint ? String(input.accountHint) : undefined;

    const requested = accountHint ? ctx.ledger.findAccount(accountHint) : undefined;
    if (accountHint && !requested) {
      // Don't guess at an account the customer may not have.
      const names = ctx.ledger.listAccounts().map((a) => a.name).join(" and ");
      return {
        summary: `There's no account matching "${accountHint}". The customer has: ${names}.`,
        failed: true,
        data: { accountHint },
      };
    }

    const accounts = requested ? [requested] : ctx.ledger.listAccounts();
    const transactions = ctx.ledger.recentTransactions(requested?.id, 12);

    /*
     * Optional FX conversion over a real HTTP boundary.
     *
     * If the tool is unavailable the answer degrades to sterling with an explicit
     * note — it must never fall back to an invented rate. A wrong exchange rate
     * reads as authoritative, which is worse than admitting the conversion failed.
     */
    /*
     * The model frequently omits `currency` even when the customer clearly asked
     * for one — observed live: it called balance with no currency, then apologised
     * for a conversion it had never attempted. So the agent also reads the intent
     * out of the question itself rather than trusting the argument to be passed.
     */
    const currency = optionalCurrency(input.currency) ?? currencyFromQuestion(question);
    let converted: ConvertedBalances | undefined;
    let fxUnavailable: string | undefined;

    if (currency && ctx.tools?.fx) {
      const result = await ctx.trace.span(
        "balance.fxConvert",
        { "gen_ai.operation.name": "tool.fx.convert", transport: "http", to: currency },
        () =>
          ctx.tools!.fx!.convert({
            amountMinor: accounts.reduce((sum, a) => sum + a.balanceMinor, 0),
            from: "GBP",
            to: currency,
          }),
      );

      if (result.ok) {
        converted = {
          currency,
          rate: result.value.rate,
          total: formatForeign(result.value.convertedMinor, currency),
          sterlingTotal: formatMoney(result.value.amountMinor),
          asOf: result.value.asOf,
        };
        ctx.trace.note(`fx.convert ok via ${result.transport} in ${result.durationMs} ms`, {
          rate: result.value.rate,
        });
      } else {
        fxUnavailable = result.reason;
        ctx.trace.note(`fx.convert failed (${result.code}): ${result.reason}`);
      }
    } else if (currency) {
      fxUnavailable = "The FX service is not configured.";
    }

    const payload = {
      // Every figure carries its currency explicitly. Without this a model asked
      // for euros relabelled the sterling balances as euros — £9,740 shown as
      // €9,740, which is flatly wrong rather than merely imprecise.
      accountCurrency: "GBP",
      accounts: accounts.map((a) => ({
        name: a.name,
        number: a.numberMasked,
        balanceGBP: formatMoney(a.balanceMinor, a.currency),
        availableGBP: formatMoney(a.availableMinor, a.currency),
        overdraftGBP: a.overdraftLimitMinor > 0 ? formatMoney(a.overdraftLimitMinor) : "none",
      })),
      ...(converted ? { convertedTotal: converted } : {}),
      ...(fxUnavailable
        ? {
            conversionUnavailable:
              `Could not convert to ${currency}: ${fxUnavailable}. ` +
              `State sterling figures only and say the conversion is unavailable. ` +
              `Do NOT estimate a rate.`,
          }
        : {}),
      recentTransactions: transactions.map((t) => ({
        date: t.date,
        description: t.description,
        amount: formatMoney(t.amountMinor),
        category: t.category,
      })),
    };

    const summary = await ctx.trace.span(
      "balance.phrase",
      { "gen_ai.operation.name": "balance", accounts: accounts.length },
      () => ctx.llm.phrase(INSTRUCTIONS, JSON.stringify({ question, ...payload })),
    );

    return {
      summary: summary.trim() || describeFallback(payload.accounts),
      data: payload,
    };
  },
};

/** Used if the model returns nothing — the customer still gets their balance. */
function describeFallback(accounts: { name: string; balanceGBP: string }[]): string {
  return accounts.map((a) => `${a.name}: ${a.balanceGBP}`).join(", ");
}

interface ConvertedBalances {
  currency: string;
  rate: number;
  /** The converted total, in the target currency. */
  total: string;
  /** The sterling total it was converted from, so the pair is unambiguous. */
  sterlingTotal: string;
  asOf: string;
}

const FX_CURRENCIES = new Set(["EUR", "USD"]);

function optionalCurrency(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  // GBP is the ledger currency, so asking for it needs no conversion.
  return FX_CURRENCIES.has(upper) ? upper : undefined;
}

/**
 * Fallback intent detection, for when the model drops the `currency` argument.
 * Deliberately conservative: it matches explicit currency words only, so an
 * ordinary balance question never triggers a needless FX call.
 */
function currencyFromQuestion(question: string): string | undefined {
  const text = question.toLowerCase();
  if (/\beuros?\b|\beur\b|€/.test(text)) return "EUR";
  if (/\b(?:us\s*)?dollars?\b|\busd\b|\$/.test(text)) return "USD";
  return undefined;
}

function formatForeign(minor: number, currency: string): string {
  const symbol = currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  const major = Math.floor(Math.abs(minor) / 100);
  const pence = String(Math.abs(minor) % 100).padStart(2, "0");
  return `${minor < 0 ? "-" : ""}${symbol}${major.toLocaleString("en-GB")}.${pence}`;
}
