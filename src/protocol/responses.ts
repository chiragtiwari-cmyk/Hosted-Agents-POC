/**
 * The OpenAI Responses protocol surface, hand-written.
 *
 * Foundry's Python protocol libraries hide this. Writing it out is deliberate:
 * the workshop should be able to see exactly what the platform expects, rather
 * than trusting a library.
 *
 * Request shape (the subset we support):
 *   { input: string | InputItem[], conversation?: string, stream?: boolean }
 *
 * Response shape:
 *   { id, object: "response", created_at, status, model,
 *     output: [{ type: "message", role: "assistant",
 *                content: [{ type: "output_text", text }] }],
 *     usage: { input_tokens, output_tokens, total_tokens } }
 */

export interface ResponsesRequest {
  input?: unknown;
  conversation?: unknown;
  stream?: unknown;
  metadata?: unknown;
  /** Binds the call to a specific sandbox — Foundry reads this from the body. */
  agent_session_id?: unknown;
  /** Chains this turn to a prior response, for stateless clients. */
  previous_response_id?: unknown;
}

export interface ParsedRequest {
  /** The latest user message. */
  userMessage: string;
  /** Prior turns supplied inline by the caller, oldest first. */
  history: { role: "user" | "assistant"; content: string }[];
  /**
   * Conversation id when the caller threads by conversation. Undefined means the
   * caller is either stateless or chaining by previous_response_id.
   *
   * NOT the same as the session id — a conversation is message history, a session
   * is the sandbox. Reusing a session does not replay messages.
   */
  conversationId?: string;
  /** Sandbox binding. Undefined means the platform allocates a fresh session. */
  agentSessionId?: string;
  previousResponseId?: string;
  stream: boolean;
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request_error",
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * `input` accepts either a bare string or an array of input items. When it is an
 * array, earlier user/assistant items are treated as history and the final user
 * item is the turn — that is how a client replays a conversation without relying
 * on server-side state.
 */
export function parseRequest(body: ResponsesRequest): ParsedRequest {
  if (body === null || typeof body !== "object") {
    throw new ProtocolError("Request body must be a JSON object.");
  }

  const stream = body.stream === true;
  const optional = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  const base = {
    stream,
    ...(optional(body.conversation) ? { conversationId: optional(body.conversation)! } : {}),
    ...(optional(body.agent_session_id)
      ? { agentSessionId: optional(body.agent_session_id)! }
      : {}),
    ...(optional(body.previous_response_id)
      ? { previousResponseId: optional(body.previous_response_id)! }
      : {}),
  };

  const { input } = body;

  if (typeof input === "string") {
    const userMessage = input.trim();
    if (!userMessage) throw new ProtocolError("`input` must not be empty.");
    return { userMessage, history: [], ...base };
  }

  if (Array.isArray(input)) {
    const items = input.map(normaliseInputItem).filter((item): item is NonNullable<typeof item> => item !== undefined);
    if (items.length === 0) {
      throw new ProtocolError("`input` array contained no readable messages.");
    }
    const last = items[items.length - 1]!;
    if (last.role !== "user") {
      throw new ProtocolError("The final `input` item must be a user message.");
    }
    return {
      userMessage: last.content,
      history: items.slice(0, -1),
      ...base,
    };
  }

  throw new ProtocolError("`input` must be a string or an array of input items.");
}

/** Accepts both `{role, content: string}` and the content-parts form. */
function normaliseInputItem(
  raw: unknown,
): { role: "user" | "assistant"; content: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as { role?: unknown; content?: unknown; type?: unknown };

  const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : undefined;
  if (!role) return undefined;

  if (typeof item.content === "string") {
    const content = item.content.trim();
    return content ? { role, content } : undefined;
  }

  if (Array.isArray(item.content)) {
    const text = item.content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const candidate = part as { text?: unknown; type?: unknown };
        return typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("")
      .trim();
    return text ? { role, content: text } : undefined;
  }

  return undefined;
}

export interface ResponseEnvelopeInput {
  id: string;
  model: string;
  text: string;
  createdAtMs: number;
  /** Rough character-based estimate; this runtime does not meter real tokens. */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Echoed so the client learns which sandbox served the call and can bind later
   * turns to it. Foundry returns this on every response.
   */
  agentSessionId?: string;
  conversationId?: string;
  previousResponseId?: string;
}

export function buildResponse(input: ResponseEnvelopeInput): Record<string, unknown> {
  const inputTokens = input.usage?.inputTokens ?? 0;
  const outputTokens = input.usage?.outputTokens ?? 0;
  return {
    id: input.id,
    object: "response",
    created_at: Math.floor(input.createdAtMs / 1000),
    status: "completed",
    model: input.model,
    output: [
      {
        id: `${input.id}-msg`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: input.text, annotations: [] }],
      },
    ],
    output_text: input.text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
    ...(input.agentSessionId ? { agent_session_id: input.agentSessionId } : {}),
    ...(input.conversationId ? { conversation: input.conversationId } : {}),
    ...(input.previousResponseId ? { previous_response_id: input.previousResponseId } : {}),
  };
}

export function buildErrorResponse(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  if (error instanceof ProtocolError) {
    return {
      status: error.status,
      body: { error: { type: error.code, message: error.message } },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    body: { error: { type: "server_error", message } },
  };
}

/** Crude token estimate — enough for a usage field, not for billing. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/* ------------------------------------------------------------------------- *
 * SSE event framing
 *
 * Standard Responses streaming events, plus `delegation.step` — a custom event
 * carrying trace steps so the UI can draw the delegation tree live rather than
 * polling for it afterwards.
 * ------------------------------------------------------------------------- */

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamCreated(id: string, model: string, createdAtMs: number): string {
  return sseEvent("response.created", {
    type: "response.created",
    response: { id, object: "response", status: "in_progress", model, created_at: Math.floor(createdAtMs / 1000) },
  });
}

export function streamTextDelta(id: string, delta: string): string {
  return sseEvent("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `${id}-msg`,
    output_index: 0,
    content_index: 0,
    delta,
  });
}

export function streamCompleted(response: Record<string, unknown>): string {
  return sseEvent("response.completed", { type: "response.completed", response });
}

export function streamError(message: string): string {
  return sseEvent("error", { type: "error", message });
}
