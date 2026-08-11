/**
 * WebSocket transport, matching Foundry's `/invocations_ws` protocol shape.
 *
 * This is the path voice uses: the browser streams a transcript up, and text
 * deltas plus live delegation steps come back down, so speech synthesis can start
 * before the whole reply exists.
 *
 * Note on Foundry support: WebSocket (`/invocations_ws`) is preview-limited by
 * region and API version. This endpoint is verified locally; deployment
 * verification is best-effort. See the README.
 *
 * Client → server:
 *   { type: "turn", message: string, conversation?: string, agent_session_id?: string }
 *   { type: "ping" }
 *
 * Server → client:
 *   { type: "turn.started", conversation, agent_session_id, turnId }
 *   { type: "delegation.step", step }        live trace, for the UI's right pane
 *   { type: "response.delta", delta }
 *   { type: "turn.completed", text, delegations, truncated, agent_session_id }
 *   { type: "error", message }
 *   { type: "pong" }
 *
 * The socket remembers the session it was allocated, so a client that connects
 * without one still gets a stable sandbox for the life of the connection.
 */
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { chunkText, type RunTurn } from "../app.js";

export interface WebSocketDeps {
  runTurn: RunTurn;
  /** Delay between text deltas, so voice playback has a natural cadence. */
  deltaDelayMs?: number;
  now?: () => number;
}

export const WS_PATH = "/invocations_ws";

export function attachWebSocket(server: Server, deps: WebSocketDeps): WebSocketServer {
  const wss = new WebSocketServer({ server, path: WS_PATH });
  const now = deps.now ?? (() => Date.now());

  wss.on("connection", (socket: WebSocket) => {
    let turnCounter = 0;
    // One turn at a time per socket: a second turn arriving mid-flight would
    // interleave deltas and corrupt the transcript.
    let busy = false;
    // Sticky per-connection session, so a client that never sends one still gets
    // continuity for the life of the socket.
    let socketSessionId: string | undefined;

    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };

    send({ type: "ready", path: WS_PATH });

    socket.on("message", async (raw) => {
      let parsed: {
        type?: unknown;
        message?: unknown;
        conversation?: unknown;
        agent_session_id?: unknown;
      };
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "Message must be JSON." });
        return;
      }

      if (parsed.type === "ping") {
        send({ type: "pong" });
        return;
      }

      if (parsed.type !== "turn") {
        send({ type: "error", message: `Unsupported message type: ${String(parsed.type)}` });
        return;
      }

      const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
      if (!message) {
        send({ type: "error", message: "`message` is required and must be non-empty." });
        return;
      }

      if (busy) {
        send({ type: "error", message: "A turn is already in progress on this connection." });
        return;
      }
      busy = true;

      const conversationId =
        typeof parsed.conversation === "string" && parsed.conversation.trim()
          ? parsed.conversation.trim()
          : undefined;
      const requestedSession =
        typeof parsed.agent_session_id === "string" && parsed.agent_session_id.trim()
          ? parsed.agent_session_id.trim()
          : undefined;
      const turnId = `turn-${++turnCounter}`;

      send({
        type: "turn.started",
        turnId,
        ...(conversationId ? { conversation: conversationId } : {}),
        ...(requestedSession ?? socketSessionId
          ? { agent_session_id: requestedSession ?? socketSessionId }
          : {}),
      });

      try {
        const result = await deps.runTurn({
          userMessage: message,
          ...(conversationId ? { conversationId } : {}),
          ...(requestedSession ?? socketSessionId
            ? { agentSessionId: requestedSession ?? socketSessionId }
            : {}),
          onStep: (step) => send({ type: "delegation.step", turnId, step }),
        });

        // Remember whatever the platform allocated, so later turns on this socket
        // land in the same sandbox.
        socketSessionId = result.agentSessionId;

        for (const chunk of chunkText(result.text)) {
          send({ type: "response.delta", turnId, delta: chunk });
          if (deps.deltaDelayMs) await sleep(deps.deltaDelayMs);
        }

        send({
          type: "turn.completed",
          turnId,
          ...(conversationId ? { conversation: conversationId } : {}),
          agent_session_id: result.agentSessionId,
          text: result.text,
          delegations: result.delegations,
          truncated: result.truncated,
        });
      } catch (error) {
        send({
          type: "error",
          turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        busy = false;
      }
    });
  });

  return wss;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
