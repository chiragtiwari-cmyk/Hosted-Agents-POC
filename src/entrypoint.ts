/**
 * Container entrypoint: picks a runtime mode so the image works with or without
 * credentials.
 *
 *   a provider is configured  → the real server (src/server.ts)
 *   nothing configured        → the offline stub (src/dev-server.ts)
 *   OFFLINE=1                 → force the stub, even if a key is present
 *
 * Why this exists: a published image that needs an API key to do anything gives a
 * bad first impression — it starts, serves the UI, then fails on the first
 * message. Defaulting to the stub means `docker run` works standalone, and the
 * whole orchestration story (supervisor loop, agents, sessions, tools, tracing)
 * is real. Only the model's routing decision is scripted.
 *
 * The mode is announced on startup, because silently running a stub while someone
 * believes they are talking to a real model would be worse than failing.
 */

const forcedOffline = process.env.OFFLINE === "1" || process.env.OFFLINE === "true";
const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
const hasAzure = Boolean(
  process.env.FOUNDRY_PROJECT_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT,
);

const useOffline = forcedOffline || (!hasOpenAi && !hasAzure);

if (useOffline) {
  const why = forcedOffline
    ? "OFFLINE=1 was set"
    : "no OPENAI_API_KEY or FOUNDRY_PROJECT_ENDPOINT found";
  console.log(
    [
      "┌──────────────────────────────────────────────────────────────┐",
      "│  OFFLINE MODE — deterministic stub model, no provider calls   │",
      "│                                                              │",
      "│  The runtime is real: supervisor loop, agents, ledger,        │",
      "│  sessions, tools and tracing all behave normally. Only the    │",
      "│  model's routing decision is keyword-matched, not reasoned.   │",
      "│                                                              │",
      "│  For real reasoning, restart with:                            │",
      "│    -e OPENAI_API_KEY=sk-...                                   │",
      "└──────────────────────────────────────────────────────────────┘",
      `  reason: ${why}`,
      "",
    ].join("\n"),
  );
  await import("./dev-server.js");
} else {
  await import("./server.js");
}
