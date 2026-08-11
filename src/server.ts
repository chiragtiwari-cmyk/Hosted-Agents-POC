/**
 * Entrypoint.
 *
 * Port 8088 — the port Foundry hosted containers listen on locally; the gateway
 * handles routing in production.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ModelClient, modelNameOf, readModelConfig, withRetry } from "./llm.js";
import { attachWebSocket, WS_PATH } from "./protocol/websocket.js";
import { createOtelExporter } from "./trace.js";

const PORT = Number(process.env.PORT ?? 8088);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js → ../public; src/server.ts → ../public. Both resolve.
const PUBLIC_DIR = path.resolve(HERE, "..", "public");

async function main(): Promise<void> {
  const config = readModelConfig();
  const exporter = await createOtelExporter();

  const { app, runTurn } = createApp({
    llm: withRetry(new ModelClient(config)),
    modelName: modelNameOf(config),
    publicDir: PUBLIC_DIR,
    ...(exporter ? { exporter } : {}),
  });

  const server = http.createServer(app);
  attachWebSocket(server, { runTurn, deltaDelayMs: 40 });

  server.listen(PORT, () => {
    const provider = config.provider === "openai" ? "OpenAI API" : "Azure/Foundry";
    console.log(
      [
        `banking supervisor listening on :${PORT}`,
        `  provider   ${provider} (${modelNameOf(config)})`,
        `  tracing    ${exporter ? "OpenTelemetry → App Insights" : "ring buffer only"}`,
        `  UI         http://localhost:${PORT}/`,
        `  responses  POST http://localhost:${PORT}/responses`,
        `  websocket  ws://localhost:${PORT}${WS_PATH}`,
      ].join("\n"),
    );
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, closing.`);
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
