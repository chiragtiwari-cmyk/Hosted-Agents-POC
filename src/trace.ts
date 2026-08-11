/**
 * Delegation tracing.
 *
 * Two sinks, written from the same call sites so they cannot drift:
 *
 *   1. An in-process ring buffer, which the UI's trace pane reads. The UI must
 *      work with no Application Insights resource configured, and App Insights
 *      ingestion lag (tens of seconds) would make a live demo look broken.
 *
 *   2. OpenTelemetry spans, when APPLICATIONINSIGHTS_CONNECTION_STRING is present.
 *      Foundry injects it. Attribute names follow the gen_ai.* convention so the
 *      Foundry portal's Traces tab renders them.
 *
 * OTel is loaded lazily and failure to initialise is non-fatal — a tracing
 * problem must never take down the agent.
 */
import type { TraceSink } from "./agents/types.js";

export interface TraceStep {
  /** Depth 0 is the supervisor; 1 is a specialist. */
  depth: number;
  name: string;
  startedAtMs: number;
  durationMs?: number;
  attributes: Record<string, string | number | boolean>;
  status: "running" | "ok" | "error";
  error?: string;
  notes: { message: string; atMs: number }[];
}

export interface ConversationTrace {
  conversationId: string;
  turns: TurnTrace[];
}

export interface TurnTrace {
  turnIndex: number;
  userMessage: string;
  startedAtMs: number;
  durationMs?: number;
  steps: TraceStep[];
  reply?: string;
}

/** Bounded store of recent conversation traces. */
export class TraceStore {
  private order: string[] = [];
  private byId = new Map<string, ConversationTrace>();

  constructor(private capacity = 20) {}

  get(conversationId: string): ConversationTrace | undefined {
    return this.byId.get(conversationId);
  }

  list(): { conversationId: string; turns: number }[] {
    return this.order.map((id) => ({
      conversationId: id,
      turns: this.byId.get(id)?.turns.length ?? 0,
    }));
  }

  /** Begin a turn, evicting the oldest conversation when over capacity. */
  beginTurn(conversationId: string, userMessage: string, nowMs: number): TurnTrace {
    let conversation = this.byId.get(conversationId);
    if (!conversation) {
      conversation = { conversationId, turns: [] };
      this.byId.set(conversationId, conversation);
      this.order.push(conversationId);
      while (this.order.length > this.capacity) {
        const evicted = this.order.shift();
        if (evicted) this.byId.delete(evicted);
      }
    }
    const turn: TurnTrace = {
      turnIndex: conversation.turns.length,
      userMessage,
      startedAtMs: nowMs,
      steps: [],
    };
    conversation.turns.push(turn);
    return turn;
  }
}

/** Emits OTel spans when configured. Absent otherwise. */
export interface SpanExporter {
  startSpan(name: string, attributes: Record<string, string | number | boolean>): {
    end(status: "ok" | "error", error?: string): void;
    setAttributes?(attrs: Record<string, string | number | boolean>): void;
  };
  /** Activate incoming trace context so child spans nest under the platform's parent. */
  activateIncomingContext?(traceparent: string): void;
}

/**
 * Writes to a turn's step list and, when present, to an OTel exporter.
 * Live listeners receive each step change so SSE and WebSocket clients can
 * render the trace as it happens.
 */
export class TurnTracer implements TraceSink {
  private listeners = new Set<(step: TraceStep) => void>();

  constructor(
    private turn: TurnTrace,
    private now: () => number = () => Date.now(),
    private exporter?: SpanExporter,
    private depth = 0,
  ) {}

  onStep(listener: (step: TraceStep) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private activeOtelSpan?: ReturnType<NonNullable<SpanExporter["startSpan"]>>;

  async span<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const step: TraceStep = {
      depth: this.depth,
      name,
      startedAtMs: this.now(),
      attributes,
      status: "running",
      notes: [],
    };
    this.turn.steps.push(step);
    this.emit(step);

    const otel = this.exporter?.startSpan(name, attributes);
    this.activeOtelSpan = otel;
    try {
      const result = await fn();
      step.status = "ok";
      step.durationMs = this.now() - step.startedAtMs;
      otel?.end("ok");
      this.activeOtelSpan = undefined;
      this.emit(step);
      return result;
    } catch (error) {
      step.status = "error";
      step.durationMs = this.now() - step.startedAtMs;
      step.error = error instanceof Error ? error.message : String(error);
      otel?.end("error", step.error);
      this.activeOtelSpan = undefined;
      this.emit(step);
      throw error;
    }
  }

  note(message: string, attributes?: Record<string, string | number | boolean>): void {
    const step = this.turn.steps[this.turn.steps.length - 1];
    if (step) {
      step.notes.push({ message, atMs: this.now() });
      if (attributes) {
        Object.assign(step.attributes, attributes);
        this.activeOtelSpan?.setAttributes?.(attributes);
      }
      this.emit(step);
    }
  }

  /** A tracer that records nested steps one level deeper. */
  child(): TurnTracer {
    const nested = new TurnTracer(this.turn, this.now, this.exporter, this.depth + 1);
    for (const listener of this.listeners) nested.listeners.add(listener);
    return nested;
  }

  private emit(step: TraceStep): void {
    for (const listener of this.listeners) {
      try {
        listener(step);
      } catch {
        // A broken listener (closed socket) must not fail the turn.
      }
    }
  }
}

/**
 * Best-effort OTel setup. Returns undefined when no connection string is present
 * or the SDK cannot be loaded, in which case only the ring buffer is written.
 *
 * When APPLICATIONINSIGHTS_CONNECTION_STRING is present (Foundry injects it
 * automatically), spans are exported to Azure Monitor / Application Insights
 * via the Azure Monitor Trace Exporter.
 */
export async function createOtelExporter(
  connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
): Promise<SpanExporter | undefined> {
  if (!connectionString) return undefined;
  try {
    const monitorMod = await import("@azure/monitor-opentelemetry-exporter");
    const sdkMod = await import("@opentelemetry/sdk-trace-node");
    const resMod = await import("@opentelemetry/resources");
    const api = await import("@opentelemetry/api");

    const resource = resMod.resourceFromAttributes({ "service.name": "foundry-orchestration-lab" });
    const azExporter = new monitorMod.AzureMonitorTraceExporter({ connectionString });
    const processor = new sdkMod.SimpleSpanProcessor(azExporter);

    const provider = new sdkMod.NodeTracerProvider({
      resource,
      spanProcessors: [processor],
    });
    provider.register();

    const tracer = api.trace.getTracer("foundry-orchestration-lab");
    let activeCtx: ReturnType<typeof api.context.active> | undefined;

    return {
      activateIncomingContext(traceparent: string) {
        const parts = traceparent.split("-");
        if (parts.length < 4) return;
        const traceId = parts[1];
        const spanId = parts[2];
        const flags = parts[3];
        if (!traceId || !spanId || !flags) return;
        const remoteCtx = {
          traceId,
          spanId,
          traceFlags: parseInt(flags, 16),
          isRemote: true,
        };
        activeCtx = api.trace.setSpanContext(api.context.active(), remoteCtx);
      },

      startSpan(name, attributes) {
        const span = activeCtx
          ? tracer.startSpan(name, { attributes }, activeCtx)
          : tracer.startSpan(name, { attributes });
        return {
          end(status, error) {
            if (status === "error") {
              span.setStatus({ code: 2, message: error });
            }
            span.end();
          },
          setAttributes(attrs: Record<string, string | number | boolean>) {
            span.setAttributes(attrs);
          },
        };
      },
    };
  } catch (err) {
    console.warn("[trace] OTel setup failed, falling back to ring buffer:", err instanceof Error ? err.message : err);
    return undefined;
  }
}
