/**
 * Test doubles. No automated test reaches Azure or spends tokens.
 */
import type { TraceSink } from "../agents/types.js";
import type { LlmClient, LlmCompletion, LlmRequest, LlmToolCall } from "../llm.js";

/** A scripted completion: either plain text or a set of tool calls. */
export type ScriptedTurn =
  | { text: string }
  | { toolCalls: { name: string; arguments: Record<string, unknown> }[]; text?: string };

/**
 * An LLM that returns pre-scripted turns in order. `phrase` returns a fixed
 * string unless overridden, so specialist tests assert on ledger behaviour
 * rather than on model prose.
 */
export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  readonly phraseCalls: { system: string; user: string }[] = [];
  private turn = 0;
  private callSeq = 0;

  constructor(
    private script: ScriptedTurn[] = [],
    private phraseReply: string | ((system: string, user: string) => string) = "OK.",
  ) {}

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.requests.push(request);
    const scripted = this.script[this.turn++];
    if (!scripted) {
      throw new Error(
        `FakeLlm ran out of script at turn ${this.turn}. ` +
          `Provide ${this.turn} entries or expect fewer calls.`,
      );
    }
    if ("toolCalls" in scripted) {
      return {
        text: scripted.text ?? "",
        toolCalls: scripted.toolCalls.map<LlmToolCall>((call) => ({
          id: `call-${++this.callSeq}`,
          name: call.name,
          arguments: call.arguments,
        })),
      };
    }
    return { text: scripted.text, toolCalls: [] };
  }

  async phrase(system: string, user: string): Promise<string> {
    this.phraseCalls.push({ system, user });
    return typeof this.phraseReply === "function"
      ? this.phraseReply(system, user)
      : this.phraseReply;
  }

  /** Turns consumed so far — asserts on loop iteration counts. */
  get turnsUsed(): number {
    return this.turn;
  }
}

/** An LLM that always fails, for retry and degradation tests. */
export class FailingLlm implements LlmClient {
  calls = 0;
  constructor(private message = "upstream unavailable") {}
  async complete(): Promise<LlmCompletion> {
    this.calls++;
    throw new Error(this.message);
  }
  async phrase(): Promise<string> {
    this.calls++;
    throw new Error(this.message);
  }
}

/** Collects trace activity so tests can assert on delegation structure. */
export class RecordingTrace implements TraceSink {
  readonly spans: { name: string; attributes: Record<string, unknown> }[] = [];
  readonly notes: { message: string; attributes?: Record<string, unknown> }[] = [];

  async span<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.spans.push({ name, attributes });
    return fn();
  }

  note(message: string, attributes?: Record<string, string | number | boolean>): void {
    this.notes.push({ message, attributes });
  }

  names(): string[] {
    return this.spans.map((s) => s.name);
  }
}
