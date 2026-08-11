/**
 * A plain HTTP tool: FX conversion.
 *
 * This exists to put a real network boundary in the workshop. Every other "tool"
 * in this runtime is an in-process function call, which hides the things that
 * actually bite in production: latency, timeouts, partial failure, and the need to
 * degrade rather than invent a number.
 *
 * Mounted on the same Express app the agent runs in, so a demo needs one process.
 * The agent still reaches it over the loopback network — `fetch` to 127.0.0.1 — so
 * the failure modes are genuine rather than simulated.
 *
 *   POST /tools/fx/convert  { amountMinor, from, to }
 *     -> { amountMinor, from, to, rate, convertedMinor, asOf }
 */
import express, { type Request, type Response, type Router } from "express";

/**
 * Fixed rates. A real service would be live; fixed values keep the workshop
 * deterministic and mean a demo never depends on an external provider.
 */
const RATES: Record<string, number> = {
  "GBP:EUR": 1.17,
  "GBP:USD": 1.27,
  "EUR:GBP": 0.855,
  "USD:GBP": 0.787,
};

export const SUPPORTED_CURRENCIES = ["GBP", "EUR", "USD"] as const;

/** Injectable so tests can make the tool slow or broken on demand. */
export interface HttpToolOptions {
  /** Artificial latency, so the trace shows a bar worth looking at. */
  latencyMs?: number;
  /** When set, every call fails this way — for demonstrating degradation. */
  failureMode?: "none" | "error" | "hang";
  now?: () => number;
}

export interface FxConversion {
  amountMinor: number;
  from: string;
  to: string;
  rate: number;
  convertedMinor: number;
  asOf: string;
}

export class FxToolConfig {
  latencyMs: number;
  failureMode: NonNullable<HttpToolOptions["failureMode"]>;

  constructor(options: HttpToolOptions = {}) {
    this.latencyMs = options.latencyMs ?? 120;
    this.failureMode = options.failureMode ?? "none";
  }
}

export function convertFx(
  amountMinor: number,
  from: string,
  to: string,
  nowMs: number,
): FxConversion {
  const rate = from === to ? 1 : RATES[`${from}:${to}`];
  if (rate === undefined) {
    throw new Error(`No rate available for ${from} to ${to}`);
  }
  return {
    amountMinor,
    from,
    to,
    rate,
    // Rounded to whole minor units — money is never a float here.
    convertedMinor: Math.round(amountMinor * rate),
    asOf: new Date(nowMs).toISOString(),
  };
}

export function createHttpToolRouter(options: HttpToolOptions = {}): {
  router: Router;
  config: FxToolConfig;
} {
  const config = new FxToolConfig(options);
  const now = options.now ?? (() => Date.now());
  const router = express.Router();

  router.post("/tools/fx/convert", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { amountMinor?: unknown; from?: unknown; to?: unknown };

    const amountMinor = typeof body.amountMinor === "number" ? body.amountMinor : NaN;
    const from = String(body.from ?? "").toUpperCase();
    const to = String(body.to ?? "").toUpperCase();

    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      res.status(400).json({
        error: { code: "invalid_amount", message: "`amountMinor` must be a non-negative integer." },
      });
      return;
    }
    if (!SUPPORTED_CURRENCIES.includes(from as never)) {
      res.status(400).json({
        error: { code: "unsupported_currency", message: `Unsupported \`from\` currency: ${from}` },
      });
      return;
    }
    if (!SUPPORTED_CURRENCIES.includes(to as never)) {
      res.status(400).json({
        error: { code: "unsupported_currency", message: `Unsupported \`to\` currency: ${to}` },
      });
      return;
    }

    // Failure injection: the workshop needs to show what an agent does when a
    // tool is down, not just when it works.
    if (config.failureMode === "error") {
      res.status(503).json({
        error: { code: "upstream_unavailable", message: "FX provider is unavailable." },
      });
      return;
    }
    if (config.failureMode === "hang") {
      // Longer than any client timeout, so the client aborts.
      await sleep(30_000);
    }

    if (config.latencyMs > 0) await sleep(config.latencyMs);

    try {
      res.json(convertFx(amountMinor, from, to, now()));
    } catch (error) {
      res.status(422).json({
        error: {
          code: "no_rate",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  /** Lets the UI and tests flip the tool into a failing state. */
  router.post("/tools/fx/_mode", (req: Request, res: Response) => {
    const mode = (req.body ?? {}).mode;
    if (mode !== "none" && mode !== "error" && mode !== "hang") {
      res.status(400).json({
        error: { code: "invalid_mode", message: "mode must be none, error or hang." },
      });
      return;
    }
    config.failureMode = mode;
    res.json({ ok: true, mode });
  });

  return { router, config };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
