/**
 * Conversation store — message history, distinct from session state.
 *
 * Foundry's split, which this reproduces:
 *
 *   session       the sandbox and its filesystem ($HOME, /files).
 *                 Identified by `agent_session_id`.
 *   conversation  the durable record of messages, tool calls and responses.
 *                 Identified by a `conversation` id, or chained via
 *                 `previous_response_id`.
 *
 * Reusing a session id does NOT replay history — that is what a conversation id
 * is for. Passing a conversation id automatically binds a stable session, so a
 * caller threading by conversation never has to track the session themselves.
 *
 * On Foundry the conversation store lives in the platform and is reachable from
 * the playground, Teams, and the API. Locally it is backed by the same persisted
 * volume, so the client contract is identical either way.
 */
import type { PriorMessage } from "../supervisor.js";
import type { SessionStorage } from "./storage.js";

export interface ConversationRecord {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** The session this conversation is bound to, so turns reuse one sandbox. */
  agentSessionId: string;
  messages: PriorMessage[];
  /** Response ids emitted for this conversation, newest last. */
  responseIds: string[];
  metadata: Record<string, string>;
}

/** Enough of a response to resolve `previous_response_id` into history. */
export interface ResponseRecord {
  id: string;
  conversationId: string;
  agentSessionId: string;
  createdAtMs: number;
  userMessage: string;
  assistantReply: string;
  previousResponseId?: string;
}

export class ConversationStore {
  /** Response id → record. Needed for previous_response_id chaining. */
  private responses = new Map<string, ResponseRecord>();

  constructor(
    private storage: SessionStorage,
    private now: () => number = () => Date.now(),
    private maxHistory = 40,
  ) {}

  async create(options: {
    id?: string;
    agentSessionId: string;
    metadata?: Record<string, string>;
  }): Promise<ConversationRecord> {
    const id = options.id ?? `conv_${this.randomId()}`;
    const record: ConversationRecord = {
      id,
      createdAtMs: this.now(),
      updatedAtMs: this.now(),
      agentSessionId: options.agentSessionId,
      messages: [],
      responseIds: [],
      metadata: options.metadata ?? {},
    };
    await this.storage.writeConversation(id, record);
    return record;
  }

  async get(id: string): Promise<ConversationRecord | undefined> {
    return this.storage.readConversation<ConversationRecord>(id);
  }

  /**
   * Fetch a conversation, creating it if absent. Foundry creates conversations
   * on first use for the Responses protocol, so an unknown id is not an error.
   */
  async getOrCreate(id: string, agentSessionId: string): Promise<ConversationRecord> {
    return (await this.get(id)) ?? this.create({ id, agentSessionId });
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (existing) {
      for (const responseId of existing.responseIds) this.responses.delete(responseId);
    }
    return this.storage.deleteConversation(id);
  }

  async list(): Promise<ConversationRecord[]> {
    const ids = await this.storage.listConversationIds();
    const records: ConversationRecord[] = [];
    for (const id of ids) {
      const record = await this.get(id);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /** Append a completed turn and register its response id. */
  async appendTurn(
    conversationId: string,
    turn: {
      responseId: string;
      agentSessionId: string;
      userMessage: string;
      assistantReply: string;
      previousResponseId?: string;
    },
  ): Promise<ConversationRecord> {
    const record = await this.getOrCreate(conversationId, turn.agentSessionId);

    record.messages.push({ role: "user", content: turn.userMessage });
    record.messages.push({ role: "assistant", content: turn.assistantReply });
    if (record.messages.length > this.maxHistory) {
      // Trim in pairs so a user turn never loses its assistant reply.
      record.messages = record.messages.slice(-this.maxHistory);
    }
    record.responseIds.push(turn.responseId);
    record.updatedAtMs = this.now();
    record.agentSessionId = turn.agentSessionId;

    this.responses.set(turn.responseId, {
      id: turn.responseId,
      conversationId,
      agentSessionId: turn.agentSessionId,
      createdAtMs: this.now(),
      userMessage: turn.userMessage,
      assistantReply: turn.assistantReply,
      ...(turn.previousResponseId ? { previousResponseId: turn.previousResponseId } : {}),
    });

    await this.storage.writeConversation(conversationId, record);
    return record;
  }

  getResponse(responseId: string): ResponseRecord | undefined {
    return this.responses.get(responseId);
  }

  /**
   * Rebuild history by walking a `previous_response_id` chain backwards.
   *
   * This is the stateless-client path: no conversation object, each turn points
   * at the previous response. Returns oldest-first.
   */
  historyFromResponseChain(previousResponseId: string): PriorMessage[] {
    const chain: ResponseRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = previousResponseId;

    while (cursor) {
      if (seen.has(cursor)) break; // defensive: never loop on a cyclic chain
      seen.add(cursor);
      const record = this.responses.get(cursor);
      if (!record) break;
      chain.push(record);
      cursor = record.previousResponseId;
      if (chain.length > this.maxHistory) break;
    }

    return chain
      .reverse()
      .flatMap((record) => [
        { role: "user" as const, content: record.userMessage },
        { role: "assistant" as const, content: record.assistantReply },
      ]);
  }

  /**
   * The session a conversation is bound to, if any. Used so threading by
   * conversation id automatically reuses one sandbox.
   */
  async sessionFor(conversationId: string): Promise<string | undefined> {
    return (await this.get(conversationId))?.agentSessionId;
  }

  private randomId(): string {
    return Math.random().toString(36).slice(2, 12);
  }
}
