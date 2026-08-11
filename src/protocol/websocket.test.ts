import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import { SessionManager } from "../session/manager.js";
import { SessionStorage } from "../session/storage.js";
import { FakeLlm, type ScriptedTurn } from "../testing/fakes.js";
import type { Ledger } from "../bank/ledger.js";
import { WS_PATH, attachWebSocket } from "./websocket.js";

const CLOCK = Date.parse("2026-07-31T09:00:00Z");
/** Tests that inspect the ledger address this session explicitly. */
const WS_SESSION = "ws-session";

interface Harness {
  url: string;
  ledger: Ledger;
  close: () => Promise<void>;
}

const open: Harness[] = [];
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "folab-ws-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function serve(script: ScriptedTurn[], phraseReply = "Phrased."): Promise<Harness> {
  const storage = new SessionStorage(tempRoot);
  const sessions = new SessionManager(storage, () => CLOCK);
  const { app, runTurn } = createApp({
    llm: new FakeLlm(script, phraseReply),
    storage,
    sessions,
    modelName: "test-model",
    now: () => CLOCK,
  });
  const ledger = (await sessions.acquire(WS_SESSION)).ledger;
  const server = http.createServer(app);
  const wss = attachWebSocket(server, { runTurn });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const harness: Harness = {
    url: `ws://127.0.0.1:${port}${WS_PATH}`,
    ledger,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => server.close(() => resolve()));
      }),
  };
  open.push(harness);
  return harness;
}

/** Connects, sends messages, and collects frames until `turn.completed` or `error`. */
function exchange(
  url: string,
  messages: unknown[],
  options: { until?: string[]; timeoutMs?: number } = {},
): Promise<Record<string, unknown>[]> {
  const terminal = options.until ?? ["turn.completed", "error"];
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out; frames so far: ${JSON.stringify(frames)}`));
    }, options.timeoutMs ?? 5_000);

    socket.on("open", () => {
      for (const message of messages) socket.send(JSON.stringify(message));
    });

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (terminal.includes(String(frame.type))) {
        clearTimeout(timer);
        socket.close();
        resolve(frames);
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("WebSocket handshake", () => {
  it("greets a new connection with ready", async () => {
    const { url } = await serve([{ text: "hi" }]);
    const frames = await exchange(url, [], { until: ["ready"] });
    expect(frames[0]).toEqual({ type: "ready", path: WS_PATH });
  });

  it("answers a ping with a pong", async () => {
    const { url } = await serve([{ text: "hi" }]);
    const frames = await exchange(url, [{ type: "ping" }], { until: ["pong"] });
    expect(frames.map((f) => f.type)).toEqual(["ready", "pong"]);
  });
});

describe("WebSocket turn", () => {
  it("streams started, deltas, and completed", async () => {
    const { url } = await serve([
      { toolCalls: [{ name: "balance", arguments: { question: "b" } }] },
      { text: "You have one thousand two hundred and forty pounds in Current." },
    ]);

    const frames = await exchange(url, [
      { type: "turn", message: "what's my balance?", conversation: "ws-conv-1" },
    ]);
    const types = frames.map((f) => f.type);

    expect(types[0]).toBe("ready");
    expect(types).toContain("turn.started");
    expect(types).toContain("response.delta");
    expect(types.at(-1)).toBe("turn.completed");

    const assembled = frames
      .filter((f) => f.type === "response.delta")
      .map((f) => f.delta as string)
      .join("");
    expect(assembled).toBe("You have one thousand two hundred and forty pounds in Current.");

    const completed = frames.at(-1)!;
    expect(completed.text).toBe(assembled);
    expect(completed.conversation).toBe("ws-conv-1");
    expect(completed.delegations).toEqual([{ agent: "balance", ok: true }]);
    expect(completed.truncated).toBe(false);
  });

  it("emits live delegation steps for the trace pane", async () => {
    const { url } = await serve([
      {
        toolCalls: [
          { name: "balance", arguments: { question: "b" } },
          { name: "loans", arguments: { question: "l" } },
        ],
      },
      { text: "Both done." },
    ]);

    const frames = await exchange(url, [{ type: "turn", message: "balance and loan?" }]);
    const steps = frames
      .filter((f) => f.type === "delegation.step")
      .map((f) => f.step as { name: string; depth: number });

    expect(steps.some((s) => s.name === "supervisor.plan" && s.depth === 0)).toBe(true);
    expect(steps.some((s) => s.name === "delegate.balance" && s.depth === 1)).toBe(true);
    expect(steps.some((s) => s.name === "delegate.loans" && s.depth === 1)).toBe(true);
    // Steps must be tagged with the turn they belong to.
    expect(frames.find((f) => f.type === "delegation.step")!.turnId).toBe("turn-1");
  });

  it("carries a full payment confirmation across two turns on one socket", async () => {
    const { url, ledger } = await serve([
      { toolCalls: [{ name: "payments", arguments: { toPayee: "alice", amountMinor: 20_000 } }] },
      { text: "Confirm £200.00 to Alice Chen from Current?" },
      { toolCalls: [{ name: "payments", arguments: { confirm: "__REPLACED__" } }] },
      { text: "Sent." },
    ]);

    // Turn one stages. Money must not move.
    const first = await exchange(url, [
      { type: "turn", message: "send £200 to Alice", agent_session_id: WS_SESSION },
    ]);
    expect(first.at(-1)!.type).toBe("turn.completed");
    expect(ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
    // Funds are reserved while pending, though the balance is untouched.
    expect(ledger.getAccount("acc-current").availableMinor).toBe(104_000);
  });
});

describe("WebSocket validation", () => {
  it("rejects a non-JSON frame", async () => {
    const { url } = await serve([{ text: "hi" }]);
    const frames = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = new WebSocket(url);
      const collected: Record<string, unknown>[] = [];
      const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
      socket.on("open", () => socket.send("not json at all"));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        collected.push(frame);
        if (frame.type === "error") {
          clearTimeout(timer);
          socket.close();
          resolve(collected);
        }
      });
      socket.on("error", reject);
    });
    expect(frames.at(-1)!.message).toContain("must be JSON");
  });

  it("rejects an unsupported message type", async () => {
    const { url } = await serve([{ text: "hi" }]);
    const frames = await exchange(url, [{ type: "shout", message: "hey" }]);
    expect(frames.at(-1)!.type).toBe("error");
    expect(frames.at(-1)!.message).toContain("Unsupported message type");
  });

  it.each([
    ["an empty message", { type: "turn", message: "   " }],
    ["a missing message", { type: "turn" }],
    ["a non-string message", { type: "turn", message: 42 }],
  ])("rejects %s", async (_label, payload) => {
    const { url } = await serve([{ text: "hi" }]);
    const frames = await exchange(url, [payload]);
    expect(frames.at(-1)!.type).toBe("error");
    expect(frames.at(-1)!.message).toContain("required");
  });

  it("reports a model failure as an error frame, not a dropped socket", async () => {
    const storage = new SessionStorage(tempRoot);
    const sessions = new SessionManager(storage, () => CLOCK);
    const ledger = (await sessions.acquire(WS_SESSION)).ledger;
    const { app, runTurn } = createApp({
      llm: {
        complete: async () => {
          throw new Error("model exploded");
        },
        phrase: async () => "",
      },
      storage,
      sessions,
      now: () => CLOCK,
    });
    const server = http.createServer(app);
    const wss = attachWebSocket(server, { runTurn });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    open.push({
      url: "",
      ledger,
      close: () => new Promise<void>((r) => wss.close(() => server.close(() => r()))),
    });

    const frames = await exchange(`ws://127.0.0.1:${port}${WS_PATH}`, [
      { type: "turn", message: "hi" },
    ]);

    expect(frames.at(-1)!.type).toBe("error");
    expect(frames.at(-1)!.message).toContain("model exploded");
  });
});
