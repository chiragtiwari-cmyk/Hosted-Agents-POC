/**
 * Conversation state.
 *
 * Foundry manages message history for the Responses protocol when a conversation
 * id is supplied, but this server also serves a local UI and a WebSocket where no
 * platform-managed history exists. So it keeps its own bounded store and treats
 * any history supplied on the request as authoritative when present.
 *
 * The pending confirmation token lives here rather than in the model's context.
 * Models drop opaque strings across turns; a server-side token means the confirm
 * path does not depend on model recall, and it cannot be forged from a prompt.
 */
import type { PriorMessage } from "./supervisor.js";

export interface ConversationState {
  id: string;
  history: PriorMessage[];
  pendingToken?: string;
  updatedAtMs: number;
}

export class ConversationStore {
  private byId = new Map<string, ConversationState>();
  private order: string[] = [];

  constructor(
    private capacity = 200,
    private maxHistory = 20,
    private now: () => number = () => Date.now(),
  ) {}

  get(id: string): ConversationState {
    let state = this.byId.get(id);
    if (!state) {
      state = { id, history: [], updatedAtMs: this.now() };
      this.byId.set(id, state);
      this.order.push(id);
      while (this.order.length > this.capacity) {
        const evicted = this.order.shift();
        if (evicted) this.byId.delete(evicted);
      }
    }
    return state;
  }

  /** Record a completed turn, trimming history to the retention window. */
  append(id: string, userMessage: string, assistantReply: string, pendingToken?: string): void {
    const state = this.get(id);
    state.history.push({ role: "user", content: userMessage });
    state.history.push({ role: "assistant", content: assistantReply });
    // Keep pairs intact when trimming.
    if (state.history.length > this.maxHistory) {
      state.history = state.history.slice(-this.maxHistory);
    }
    state.pendingToken = pendingToken;
    state.updatedAtMs = this.now();
  }

  reset(id: string): void {
    this.byId.delete(id);
    this.order = this.order.filter((existing) => existing !== id);
  }
}
