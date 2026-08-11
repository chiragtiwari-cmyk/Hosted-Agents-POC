/**
 * Tool clients — the side of the boundary that transfers to Foundry.
 *
 * On Foundry the MCP client points at the project's Toolbox endpoint rather than
 * at our own /mcp route, but the client code is the same: initialize, list, call,
 * with a timeout and a bounded retry.
 *
 * Two rules that both clients share, and that the tests enforce:
 *
 *  1. A tool failure NEVER throws into the agent. It returns `{ ok: false }` with
 *     a reason, so the agent can tell the customer what it could not do. An
 *     exception here would abort the turn and lose the rest of the answer.
 *
 *  2. A failed tool must never yield a figure. Degrading means saying less, not
 *     guessing — a made-up exchange rate in a banking demo is worse than an
 *     apology.
 */

export interface ToolOk<T> {
  ok: true;
  value: T;
  /** Wall-clock duration, so the agent can surface slow tools. */
  durationMs: number;
  transport: "http" | "mcp";
}

export interface ToolFailure {
  ok: false;
  reason: string;
  code: "timeout" | "transport" | "tool_error" | "bad_response";
  durationMs: number;
  transport: "http" | "mcp";
}

export type ToolResult<T> = ToolOk<T> | ToolFailure;

export interface ToolClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Total attempts, including the first. 2 means one retry. */
  attempts?: number;
  now?: () => number;
}

/** Shared timeout + retry, so both transports behave identically on failure. */
async function withRetry<T>(
  transport: "http" | "mcp",
  options: ToolClientOptions,
  attempt: (signal: AbortSignal) => Promise<T>,
): Promise<ToolResult<T>> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const attempts = options.attempts ?? 2;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  let lastFailure: ToolFailure | undefined;

  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const value = await attempt(controller.signal);
      return { ok: true, value, durationMs: now() - startedAt, transport };
    } catch (error) {
      const aborted = controller.signal.aborted;
      lastFailure = {
        ok: false,
        code: aborted ? "timeout" : error instanceof ToolError ? error.code : "transport",
        reason: aborted
          ? `Timed out after ${timeoutMs} ms`
          : error instanceof Error
            ? error.message
            : String(error),
        durationMs: now() - startedAt,
        transport,
      };
      // A tool that answered with a definite error will answer the same way
      // again; only retry transport-level problems.
      if (error instanceof ToolError && error.code === "tool_error") break;
    } finally {
      clearTimeout(timer);
    }
  }

  return (
    lastFailure ?? {
      ok: false,
      code: "transport",
      reason: "Tool call failed for an unknown reason",
      durationMs: 0,
      transport,
    }
  );
}

class ToolError extends Error {
  constructor(
    message: string,
    readonly code: ToolFailure["code"],
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/* ------------------------------------------------------------------- HTTP --- */

export interface FxResult {
  amountMinor: number;
  from: string;
  to: string;
  rate: number;
  convertedMinor: number;
  asOf: string;
}

export class HttpToolClient {
  constructor(private options: ToolClientOptions) {}

  convert(input: { amountMinor: number; from: string; to: string }): Promise<ToolResult<FxResult>> {
    return withRetry("http", this.options, async (signal) => {
      const response = await fetch(`${this.options.baseUrl}/tools/fx/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new ToolError(
          body.error?.message ?? `FX service returned ${response.status}`,
          // 4xx is our own bad request and will not improve on retry; 5xx might.
          response.status >= 400 && response.status < 500 ? "tool_error" : "transport",
        );
      }

      const value = (await response.json()) as FxResult;
      if (typeof value.convertedMinor !== "number" || typeof value.rate !== "number") {
        throw new ToolError("FX service returned an unusable payload", "bad_response");
      }
      return value;
    });
  }
}

/* -------------------------------------------------------------------- MCP --- */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CreditReport {
  customerId: string;
  score: number;
  tier: "excellent" | "good" | "fair" | "poor";
  factors: string[];
  checkedAt: string;
}

/**
 * An MCP client over HTTP POST.
 *
 * `initialize` is performed once and cached: MCP is a session-oriented protocol,
 * and re-initialising per call would be both wasteful and wrong.
 */
export class McpToolClient {
  private nextId = 1;
  private initialised: Promise<void> | undefined;

  constructor(private options: ToolClientOptions) {}

  /** Idempotent handshake. */
  private ensureInitialised(): Promise<void> {
    this.initialised ??= (async () => {
      const result = await this.rpc<{ protocolVersion?: string }>("initialize", {});
      if (!result.ok) {
        // Allow a later call to retry the handshake rather than latching failure.
        this.initialised = undefined;
        throw new ToolError(result.reason, result.code);
      }
    })();
    return this.initialised;
  }

  async listTools(): Promise<ToolResult<McpToolDefinition[]>> {
    return withRetry("mcp", this.options, async () => {
      await this.ensureInitialised();
      const result = await this.rpc<{ tools?: McpToolDefinition[] }>("tools/list", {});
      if (!result.ok) throw new ToolError(result.reason, result.code);
      return result.value.tools ?? [];
    });
  }

  async creditScore(input: {
    customerId: string;
    agentSessionId?: string;
  }): Promise<ToolResult<CreditReport>> {
    return withRetry("mcp", this.options, async () => {
      await this.ensureInitialised();
      const result = await this.rpc<{
        structuredContent?: CreditReport;
        content?: { type: string; text?: string }[];
        isError?: boolean;
      }>("tools/call", { name: "credit.score", arguments: input });

      if (!result.ok) throw new ToolError(result.reason, result.code);
      if (result.value.isError) {
        throw new ToolError("credit.score reported an error", "tool_error");
      }

      // Prefer the structured form; the text block is for display only, and
      // parsing prose back into numbers is exactly the mistake to avoid.
      const report = result.value.structuredContent;
      if (!report || typeof report.score !== "number") {
        throw new ToolError("credit.score returned no structured result", "bad_response");
      }
      return report;
    });
  }

  /** One JSON-RPC round trip. Maps protocol errors onto ToolFailure codes. */
  private async rpc<T>(method: string, params: unknown): Promise<ToolResult<T>> {
    const timeoutMs = this.options.timeoutMs ?? 2_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const now = this.options.now ?? (() => Date.now());
    const startedAt = now();

    try {
      const response = await fetch(`${this.options.baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          ok: false,
          code: "transport",
          reason: `MCP endpoint returned ${response.status}`,
          durationMs: now() - startedAt,
          transport: "mcp",
        };
      }

      const body = (await response.json()) as {
        result?: T;
        error?: { code: number; message: string };
      };

      if (body.error) {
        return {
          ok: false,
          code: "tool_error",
          reason: `${body.error.message} (JSON-RPC ${body.error.code})`,
          durationMs: now() - startedAt,
          transport: "mcp",
        };
      }
      if (body.result === undefined) {
        return {
          ok: false,
          code: "bad_response",
          reason: "MCP response contained neither result nor error",
          durationMs: now() - startedAt,
          transport: "mcp",
        };
      }

      return { ok: true, value: body.result, durationMs: now() - startedAt, transport: "mcp" };
    } catch (error) {
      return {
        ok: false,
        code: controller.signal.aborted ? "timeout" : "transport",
        reason: error instanceof Error ? error.message : String(error),
        durationMs: now() - startedAt,
        transport: "mcp",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
