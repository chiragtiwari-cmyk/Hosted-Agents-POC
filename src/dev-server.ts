/**
 * Offline dev server.
 *
 * Runs the entire stack — Express, SSE, WebSocket, UI — against a deterministic
 * stub model instead of a real provider. Two uses:
 *
 *   1. Verifying the plumbing without a key or any token spend.
 *   2. Running the workshop UI for attendees who have no provider access.
 *
 * The stub does keyword intent routing rather than real reasoning, so the
 * delegation traces it produces are genuine (the supervisor loop, agents, and
 * ledger are all real) while the routing decision is scripted.
 *
 *   npm run dev:offline
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import type { LlmClient, LlmCompletion, LlmRequest } from "./llm.js";
import { attachWebSocket, WS_PATH } from "./protocol/websocket.js";

const PORT = Number(process.env.PORT ?? 8088);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "..", "public");

/** Deterministic stand-in for a model. Routes by keyword, phrases by template. */
class StubLlm implements LlmClient {
  private callSeq = 0;

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const toolResults = request.messages.filter((m) => m.role === "tool");
    const text = (lastUser?.content ?? "").toLowerCase();

    // Once specialists have reported, summarise and stop.
    if (toolResults.length > 0) {
      return { text: toolResults.map((m) => m.content).join(" "), toolCalls: [] };
    }

    const calls: { name: string; arguments: Record<string, unknown> }[] = [];

    // A staged payment or application plus agreement → confirm.
    const payTokenMatch = /confirm="(pend-[^"]+)"/.exec(lastUser?.content ?? "");
    const appTokenMatch = /confirm="(appl-[^"]+)"/.exec(lastUser?.content ?? "");
    const tokenMatch = payTokenMatch ?? appTokenMatch;
    const tokenAgent = payTokenMatch ? "payments" : "loans";
    const agreed = /\b(yes|yeah|yep|confirm|go ahead|do it|please do|proceed)\b/.test(text);
    const declined = /\b(no|nope|cancel|stop|don't|do not)\b/.test(text);

    if (tokenMatch && agreed) {
      calls.push({ name: tokenAgent, arguments: { confirm: tokenMatch[1] } });
    } else if (tokenMatch && declined) {
      calls.push({ name: tokenAgent, arguments: { cancel: tokenMatch[1] } });
    } else if (/\b(apply|application|proceed|take it|go with)\b/.test(text) && /loan|finance|borrow/.test(text)) {
      // "apply for the personal loan" → stage an application.
      const product = /car|auto|vehicle/.test(text)
        ? "loan-auto"
        : /home|improve|renovat/.test(text)
          ? "loan-home-improve"
          : "loan-personal";
      const amount = parseAmountMinor(text) ?? 500_000;
      const years = /(\d+)\s*year/.exec(text)?.[1];
      const months = /(\d+)\s*month/.exec(text)?.[1];
      calls.push({
        name: "loans",
        arguments: {
          apply: product,
          amountMinor: amount,
          termMonths: years ? Number(years) * 12 : months ? Number(months) : 36,
        },
      });
    } else {
      if (/balance|spend|spent|transaction|account|how much.*(have|left)/.test(text)) {
        // Detect a currency request so the FX tool gets exercised offline too.
        const currency = /\beuro?s?\b|\beur\b/.test(text)
          ? "EUR"
          : /\bdollars?\b|\busd\b/.test(text)
            ? "USD"
            : undefined;
        calls.push({
          name: "balance",
          arguments: {
            question: lastUser?.content ?? "",
            ...(currency ? { currency } : {}),
          },
        });
      }
      if (/send|pay|transfer|move/.test(text)) {
        const payee = /\b(?:to|pay)\s+(?:my\s+)?([a-z ]+?)(?:\s|$|,|\.)/.exec(text)?.[1]?.trim();
        const amount = parseAmountMinor(text);
        calls.push({
          name: "payments",
          arguments: {
            ...(payee ? { toPayee: payee } : {}),
            ...(amount ? { amountMinor: amount } : {}),
          },
        });
      }
      if (/loan|borrow|finance|lend|mortgage/.test(text)) {
        const amount = parseAmountMinor(text);
        const years = /(\d+)\s*year/.exec(text)?.[1];
        const months = /(\d+)\s*month/.exec(text)?.[1];
        calls.push({
          name: "loans",
          arguments: {
            question: lastUser?.content ?? "",
            ...(amount ? { amountMinor: amount } : {}),
            ...(years ? { termMonths: Number(years) * 12 } : months ? { termMonths: Number(months) } : {}),
          },
        });
      }
    }

    if (calls.length === 0) {
      return {
        text:
          "I can help with balances, payments, and loans. Try 'what's my balance', " +
          "'send £200 to Alice', or 'can I borrow £5,000 over 3 years'.",
        toolCalls: [],
      };
    }

    return {
      text: "",
      toolCalls: calls.map((call) => ({
        id: `stub-call-${++this.callSeq}`,
        name: call.name,
        arguments: call.arguments,
      })),
    };
  }

  async phrase(_system: string, user: string): Promise<string> {
    const payload = JSON.parse(user) as {
      accounts?: { name: string; balanceGBP: string; availableGBP: string }[];
      recentTransactions?: { date: string; description: string; amount: string }[];
      quotes?: {
        product: string;
        apr: string;
        eligible: boolean;
        monthlyPayment?: string;
        totalRepayable?: string;
        ineligibleBecause?: string[];
      }[];
    };

    if (payload.accounts) {
      const lines = payload.accounts.map((a) => `${a.name}: ${a.balanceGBP}`).join(" and ");
      const fx = (payload as { convertedTotal?: { total: string; currency: string; rate: number } })
        .convertedTotal;
      const fxNote = fx
        ? ` That is ${fx.total} at ${fx.rate} ${fx.currency}/GBP.`
        : (payload as { conversionUnavailable?: string }).conversionUnavailable
          ? " The currency conversion is unavailable right now, so these are sterling figures."
          : "";
      const recent = payload.recentTransactions?.slice(0, 3) ?? [];
      const tail = recent.length
        ? ` Recent: ${recent.map((t) => `${t.description} ${t.amount}`).join("; ")}.`
        : "";
      return `You have ${lines}.${fxNote}${tail}`;
    }

    if (payload.quotes) {
      const credit = (payload as { creditCheck?: { score: number; tier: string } }).creditCheck;
      const creditNote = credit ? ` Credit score ${credit.score} (${credit.tier}).` : "";
      const eligible = payload.quotes.filter((q) => q.eligible);
      if (eligible.length === 0) {
        const why = payload.quotes[0]?.ineligibleBecause?.join("; ") ?? "the figures don't qualify";
        return `Nothing matches at the moment — ${why}. These figures are indicative only.`;
      }
      return (
        eligible
          .map(
            (q) =>
              `${q.product} at ${q.apr} APR is ${q.monthlyPayment} a month ` +
              `(${q.totalRepayable} total)`,
          )
          .join(", ") + `.${creditNote} These are indicative figures, not a formal offer.`
      );
    }

    return "Done.";
  }
}

/** "£5,000", "5000", "£200.50" → minor units. */
function parseAmountMinor(text: string): number | undefined {
  const match = /£?\s*([\d,]+(?:\.\d{1,2})?)\s*(k|thousand)?/i.exec(text);
  if (!match) return undefined;
  let value = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (match[2]) value *= 1000;
  return Math.round(value * 100);
}

const { app, runTurn } = createApp({
  llm: new StubLlm(),
  modelName: "stub-model (offline)",
  publicDir: PUBLIC_DIR,
});

const server = http.createServer(app);
attachWebSocket(server, { runTurn, deltaDelayMs: 25 });

server.listen(PORT, () => {
  console.log(
    [
      `OFFLINE dev server on :${PORT} — deterministic stub model, no provider calls`,
      `  UI         http://localhost:${PORT}/`,
      `  responses  POST http://localhost:${PORT}/responses`,
      `  websocket  ws://localhost:${PORT}${WS_PATH}`,
    ].join("\n"),
  );
});
