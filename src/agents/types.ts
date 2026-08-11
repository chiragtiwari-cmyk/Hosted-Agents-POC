/**
 * The agent contract — the seam the whole runtime hangs on.
 *
 * Three things matter here:
 *
 *  1. `inputSchema` and `description` are what the supervisor turns into an LLM
 *     tool definition. Agents describe themselves; the supervisor has no
 *     hardcoded knowledge of who exists.
 *
 *  2. Agents never talk to each other in slice one. A specialist returns to the
 *     supervisor, which decides what happens next. That constraint is what makes
 *     the later split to separate Foundry deployments a transport change rather
 *     than a rewrite.
 *
 *  3. `needsConfirmation` lives on the shared result type even though only the
 *     payments agent ever sets it. The alternative — a distinct confirming-agent
 *     type — would force the supervisor to branch on agent kind.
 */
import type { Ledger, PendingAction } from "../bank/ledger.js";
import type { LlmClient } from "../llm.js";
import type { CreditReport, FxResult, ToolResult } from "../tools/clients.js";

/** Minimal JSON Schema shape for tool parameters. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentContext {
  ledger: Ledger;
  llm: LlmClient;
  sessionId: string;
  /** Records a step into the conversation's trace. */
  trace: TraceSink;
  /**
   * External tools, reached over a real network boundary. Optional: agents must
   * work without them, because a tool being unavailable is a normal condition and
   * not a reason to fail a turn.
   */
  tools?: AgentTools;
}

export interface AgentTools {
  /** Plain HTTP tool. */
  fx?: {
    convert(input: { amountMinor: number; from: string; to: string }): Promise<ToolResult<FxResult>>;
  };
  /** MCP tool — the transport Foundry's Toolbox uses. */
  credit?: {
    creditScore(input: {
      customerId: string;
      agentSessionId?: string;
    }): Promise<ToolResult<CreditReport>>;
  };
}

export interface TraceSink {
  /** Wrap an operation in a trace span, recording duration and outcome. */
  span<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T>;
  /** Record a point-in-time note on the current conversation. */
  note(message: string, attributes?: Record<string, string | number | boolean>): void;
}

export interface AgentResult {
  /** What the supervisor sees. Keep it short — it goes back into a prompt. */
  summary: string;
  /**
   * Wording safe to show the customer verbatim. Set when `summary` contains
   * operational detail — confirmation tokens, internal instructions — that must
   * never reach the user. The supervisor prefers this when replying.
   */
  customerSafe?: string;
  /** Structured detail for the trace pane and tests. Never shown to the model. */
  data?: unknown;
  /** Set only when the action needs the customer to confirm before committing. */
  needsConfirmation?: PendingAction & { describe: string };
  /** True when the agent could not do what was asked. */
  failed?: boolean;
}

export interface Agent {
  /** Stable identifier, also used as the tool name suffix. */
  readonly name: string;
  /** Becomes the tool description the supervisor's model reads. */
  readonly description: string;
  /** Becomes the tool's parameter schema. */
  readonly inputSchema: JsonSchema;
  handle(input: Record<string, unknown>, ctx: AgentContext): Promise<AgentResult>;
}

/** An OpenAI-style function tool definition. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

/**
 * Derive the supervisor's tool list from the agent registry. Adding a specialist
 * is one file plus one registry line — no supervisor change.
 */
export function toToolDefinition(agent: Agent): ToolDefinition {
  return {
    type: "function",
    function: {
      name: agent.name,
      description: agent.description,
      parameters: agent.inputSchema,
    },
  };
}
