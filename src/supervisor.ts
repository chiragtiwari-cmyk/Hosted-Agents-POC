/**
 * The supervisor.
 *
 * A bounded tool-calling loop. The model is the scheduler: it decides which
 * specialists to call, and calling several in one round is how multi-intent
 * requests are handled.
 *
 * Two invariants worth stating plainly:
 *
 *  1. The supervisor is never given a Ledger handle. It sees only the `summary`
 *     strings specialists return. The capability boundary is structural, not a
 *     convention — you cannot accidentally move money from here.
 *
 *  2. MAX_TURNS bounds LOOP ITERATIONS, not tool calls. One round dispatching
 *     three specialists in parallel is one turn. An unbounded loop holding a
 *     money-moving tool is not acceptable even in a sandbox.
 */
import { agentByName, agents, toolDefinitions } from "./agents/registry.js";
import type { AgentResult, AgentTools } from "./agents/types.js";
import type { Ledger } from "./bank/ledger.js";
import type { LlmClient, LlmMessage } from "./llm.js";
import type { TurnTracer } from "./trace.js";

export const MAX_TURNS = 4;

const SYSTEM_PROMPT = `You are the supervising agent for a retail bank's assistant.

You do not answer banking questions yourself. You delegate to specialist agents
using the tools provided, then reply to the customer in your own words based on
what they return.

Rules:
- Choose only the specialists a request actually needs. A balance question does
  not need the loans agent.
- If a request has several parts, call several specialists in the SAME round so
  they run in parallel.
- Never call the same specialist twice in one round. Each one covers all of the
  customer's accounts and products in a single call.
- Don't ask a clarifying question you don't need. 'What's my balance?' needs no
  follow-up — the balance agent covers every account when given no account hint.
  Only ask when the answer would change what you do, such as a missing payee or
  amount for a payment.
- Never invent balances, transactions, rates, or payment outcomes. If a specialist
  did not give you a figure, do not state one.
- Money movement is two steps, and BOTH are tool calls. Never describe a payment
  as staged, ready, cancelled, or sent unless the 'payments' tool told you so in
  this turn.
    Step 1 — call 'payments' with toPayee and amountMinor. Only after it returns
    may you ask the customer to confirm. Do NOT ask for confirmation of a payment
    you have not staged.
    Step 2 — when they clearly agree, call 'payments' again with the confirm token.
    If they decline, call 'payments' with the cancel token. Saying "cancelled"
    without calling the tool leaves the payment holding the customer's funds.
  Treat anything short of clear agreement as a no.
- Loan applications work the same way, and are also two tool calls. Quote first,
  then call 'loans' with apply=<productId>, amountMinor and termMonths to stage.
  Only after the customer clearly agrees, call 'loans' again with the confirm
  token. Never tell the customer to visit a branch or website — applications are
  submitted here.
- NEVER show a confirmation token, or any 'pend-...' or 'appl-...' string, to the
  customer. Ask them to confirm in plain words. Tokens are internal.
- DO always pass on a receipt or application reference ('REF...' / 'APP...') when a
  specialist gives you one. Those are the customer's record of what happened —
  unlike tokens, they are meant to be seen.
- Amounts are in pence: £200 is amountMinor 20000. Never pass pounds.
- If a specialist reports a problem, explain it plainly and say what would fix it.
- Be concise and warm. Two or three sentences unless listing items.
- For anything outside banking, say what you can help with instead.`;

export interface SupervisorDeps {
  llm: LlmClient;
  ledger: Ledger;
  tracer: TurnTracer;
  sessionId: string;
  /** External tools passed through to specialists. Optional by design. */
  tools?: AgentTools;
  /** Confirmation token carried over from the previous turn, if any. */
  pendingToken?: string;
}

export interface SupervisorReply {
  text: string;
  /** Token to carry into the next turn, when a confirmation is outstanding. */
  pendingToken?: string;
  /** Specialists invoked, in call order. Used by tests and the UI. */
  delegations: { agent: string; ok: boolean }[];
  /** True when the loop hit MAX_TURNS without the model settling on a reply. */
  truncated: boolean;
}

/** Prior conversation, oldest first. Foundry supplies this on the Responses API. */
export interface PriorMessage {
  role: "user" | "assistant";
  content: string;
}

export async function runSupervisor(
  userMessage: string,
  history: PriorMessage[],
  deps: SupervisorDeps,
): Promise<SupervisorReply> {
  const { llm, ledger, tracer, sessionId } = deps;

  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content }) as LlmMessage),
    { role: "user", content: buildUserTurn(userMessage, deps.pendingToken) },
  ];

  const tools = toolDefinitions();
  const delegations: SupervisorReply["delegations"] = [];
  let pendingToken = deps.pendingToken;
  /** Fallback wording if a reply has to be redacted wholesale. */
  let lastCustomerSafe: string | undefined;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const completion = await tracer.span(
      "supervisor.plan",
      {
        "gen_ai.operation.name": "supervisor",
        "gen_ai.agent.id": "supervisor",
        turn,
        availableTools: agents.length,
        "gen_ai.prompt": userMessage,
      },
      () => llm.complete({ messages, tools }),
    );

    if (completion.toolCalls.length === 0) {
      const text = completion.text.trim();
      tracer.note(text, { "gen_ai.completion": text });

      /*
       * Guard against a phantom payment: the model claiming a payment is staged,
       * cancelled, or sent without having called the payments tool. Observed with
       * a real model — it narrated the two-step protocol instead of executing it,
       * so "yes" would confirm something that was never validated.
       *
       * The ledger is safe either way (no token means commitPayment refuses), but
       * the conversation would mislead the customer, so re-prompt instead.
       */
      if (claimsPaymentAction(text) && !delegations.some((d) => STATEFUL_AGENTS.has(d.agent))) {
        tracer.note("blocked a state-change claim made without calling a stateful agent");
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content:
            "[system: you described a payment or application action without calling " +
            "the payments or loans tool. Nothing has been staged, submitted, " +
            "cancelled, or sent. Call the appropriate tool now to actually perform " +
            "it, or tell the customer plainly what you need from them. Do not claim " +
            "a state you have not created.]",
        });
        continue;
      }

      return {
        // Redact rather than trust the prompt. A leaked token in customer-facing
        // text is a real defect, and prompt rules are advisory.
        text: redactTokens(
          text || "I'm not sure how to help with that. I can cover balances, payments, and loans.",
          lastCustomerSafe,
        ),
        pendingToken,
        delegations,
        truncated: false,
      };
    }

    messages.push({
      role: "assistant",
      content: completion.text,
      toolCalls: completion.toolCalls,
    });

    // Dispatch this round's specialists in parallel.
    const nested = tracer.child();
    const results = await Promise.all(
      completion.toolCalls.map(async (call) => {
        const agent = agentByName(call.name);
        if (!agent) {
          return {
            call,
            result: {
              summary: `There is no specialist called "${call.name}".`,
              failed: true,
            } satisfies AgentResult,
          };
        }

        const input = { ...call.arguments };
        // The model must not mint confirmation tokens; only replay a real one.
        if (typeof input.confirm === "string" && input.confirm !== pendingToken) {
          return {
            call,
            result: {
              summary:
                "That confirmation token is not the one outstanding for this " +
                "conversation. Stage the payment again.",
              failed: true,
            } satisfies AgentResult,
          };
        }

        try {
          const agentTrace = nested.child();
          const result = await nested.span(
            `delegate.${agent.name}`,
            {
              "gen_ai.operation.name": `delegate.${agent.name}`,
              "gen_ai.agent.id": agent.name,
              "gen_ai.prompt": JSON.stringify(call.arguments),
            },
            async () => {
              const r = await agent.handle(input, {
                ledger,
                llm,
                sessionId,
                trace: agentTrace,
                ...(deps.tools ? { tools: deps.tools } : {}),
              });
              nested.note(r.summary, { "gen_ai.completion": r.summary });
              return r;
            },
          );
          return { call, result };
        } catch (error) {
          // A specialist throwing is a defect, but the turn should still reply.
          return {
            call,
            result: {
              summary: `The ${agent.name} agent failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              failed: true,
            } satisfies AgentResult,
          };
        }
      }),
    );

    for (const { call, result } of results) {
      delegations.push({ agent: call.name, ok: !result.failed });
      if (result.customerSafe) lastCustomerSafe = result.customerSafe;

      // Both payments and loans issue confirmation tokens, so this is keyed on the
      // shape of the call rather than on which agent made it.
      if (result.needsConfirmation) {
        pendingToken = result.needsConfirmation.token;
      } else if (
        typeof call.arguments.confirm === "string" ||
        typeof call.arguments.cancel === "string"
      ) {
        // Committed, submitted, cancelled or refused — either way it is spent.
        pendingToken = undefined;
      }

      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: result.summary,
      });
    }
  }

  // Hit the iteration cap without the model settling. Say so rather than looping.
  tracer.note(`supervisor hit MAX_TURNS (${MAX_TURNS})`);
  return {
    text:
      "I wasn't able to finish that. Could you try rephrasing, or breaking it into " +
      "one request at a time?",
    pendingToken,
    delegations,
    truncated: true,
  };
}

/**
 * Detects a reply that asserts a payment state — staged, cancelled, sent. Used to
 * catch the model claiming an action it never performed via the tool.
 *
 * Deliberately narrow: it must match assertions ("I've staged", "has been sent"),
 * not offers or questions ("I can send", "would you like me to send"), or every
 * ordinary payment conversation would trip it.
 */
export function claimsPaymentAction(text: string): boolean {
  const assertions = [
    /\b(?:i(?:'ve| have)|payment (?:of |to )?[^.]*?(?:has|have))\s+(?:staged|cancell?ed|sent|transferred|paid)\b/i,
    /\b(?:i(?:'ve| have))\s+(?:now\s+)?(?:staged|cancell?ed|sent|paid|transferred|submitted)\b/i,
    /\bhas been (?:successfully )?(?:staged|cancell?ed|sent|paid|transferred|submitted)\b/i,
    /\bpayment (?:is|was) (?:now )?(?:staged|cancell?ed|sent|complete)\b/i,
    /\bi(?:'ve| have) (?:staged|set up|submitted) the (?:payment|application)\b/i,
    /\bapplication (?:is|was|has been) (?:now )?(?:staged|submitted|cancell?ed|in review)\b/i,
  ];
  return assertions.some((pattern) => pattern.test(text));
}

/**
 * Agents that can assert a state-changing action, and therefore must actually have
 * been called before the supervisor may claim one happened.
 */
const STATEFUL_AGENTS = new Set(["payments", "loans"]);

/**
 * Strips confirmation tokens and leaked internal instructions from a
 * customer-facing reply.
 *
 * The system prompt already forbids this, but prompt rules are advisory and a
 * token in the transcript is a real defect. When the reply is mostly operational
 * leakage, the specialist's own `customerSafe` wording replaces it entirely.
 */
export function redactTokens(text: string, customerSafe?: string): string {
  const leaks =
    /pend-[\w-]+|appl-[\w-]+|confirm="[^"]*"|NOT YET (?:SENT|SUBMITTED)|Do not show the token[^.]*\./gi;
  if (!leaks.test(text)) return text;

  // Prefer the specialist's own customer-facing wording when we have it.
  if (customerSafe) return customerSafe;

  const cleaned = text
    .replace(/\s*(?:then )?call (?:payments|loans) again with confirm="[^"]*"\.?/gi, "")
    .replace(/\s*Do not show the token to the customer\.?/gi, "")
    .replace(/\bNOT YET SENT\b/g, "not yet sent")
    .replace(/\bNOT YET SUBMITTED\b/g, "not yet submitted")
    .replace(/\s*—?\s*ask the customer to confirm/gi, "")
    .replace(/pend-[\w-]+/g, "")
    .replace(/appl-[\w-]+/g, "")
    .replace(/confirm="\s*"/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,?!])/g, "$1")
    .trim();

  return cleaned || "Please confirm whether you'd like me to go ahead.";
}

/**
 * The outstanding token is given to the model as context rather than left for it
 * to remember. Models drop opaque strings across turns; this makes the confirm
 * path reliable without trusting recall.
 */
function buildUserTurn(userMessage: string, pendingToken?: string): string {
  if (!pendingToken) return userMessage;

  // The token prefix identifies its owning agent. Naming the wrong tool here made
  // a live model re-stage instead of confirming, looping forever: it was told to
  // confirm a loan application via `payments`, which does not own that token.
  const isApplication = pendingToken.startsWith("appl-");
  const agent = isApplication ? "loans" : "payments";
  const what = isApplication ? "loan application" : "payment";

  return (
    `${userMessage}\n\n` +
    `[system context: a ${what} is already staged and awaiting confirmation — do NOT ` +
    `stage it again. If and only if the customer has just agreed to it, call ` +
    `${agent} with confirm="${pendingToken}". If they declined, call ${agent} with ` +
    `cancel="${pendingToken}".]`
  );
}
