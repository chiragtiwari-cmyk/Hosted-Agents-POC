import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeLlm } from "../testing/fakes.js";
import { SessionManager } from "./manager.js";
import { MAX_UPLOAD_BYTES } from "./routes.js";
import { SessionStorage } from "./storage.js";

const CLOCK = Date.parse("2026-07-31T09:00:00Z");
const KEY = "x-ms-user-isolation-key";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "folab-routes-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function harness() {
  const storage = new SessionStorage(tempRoot);
  const sessions = new SessionManager(storage, () => CLOCK);
  const ctx = createApp({
    llm: new FakeLlm([{ text: "ok" }, { text: "ok" }, { text: "ok" }], "ok"),
    storage,
    sessions,
    now: () => CLOCK,
  });
  return { ...ctx, storage };
}

describe("POST /endpoint/sessions", () => {
  it("creates a session and returns Foundry-shaped fields", async () => {
    const { app } = harness();
    const res = await request(app).post("/endpoint/sessions").send({}).expect(201);

    expect(res.body.object).toBe("agent.session");
    expect(res.body.agent_session_id).toMatch(/^sess_/);
    expect(res.body.status).toBe("active");
    expect(res.body.resume_count).toBe(0);
    expect(typeof res.body.created_at).toBe("number");
    expect(typeof res.body.expires_at).toBe("number");
    expect(res.body.disk_budget_bytes).toBeGreaterThan(0);
    expect(res.body.idle_in_seconds).toBe(900); // 15-minute idle timeout
  });

  it("pins a session to a concrete agent version", async () => {
    const { app } = harness();
    const res = await request(app)
      .post("/endpoint/sessions")
      .send({ version_indicator: { type: "version_ref", agent_version: "2" } })
      .expect(201);
    expect(res.body.version_indicator).toBe("2");
  });

  /** Foundry rejects aliases like @latest for an explicit pin. */
  it("rejects an alias as a version pin", async () => {
    const { app } = harness();
    const res = await request(app)
      .post("/endpoint/sessions")
      .send({ version_indicator: { type: "version_ref", agent_version: "@latest" } })
      .expect(400);
    expect(res.body.error.message).toContain("concrete version");
  });

  it("records the caller's isolation key", async () => {
    const { app } = harness();
    const res = await request(app)
      .post("/endpoint/sessions")
      .set(KEY, "user-123")
      .send({})
      .expect(201);
    expect(res.body.isolation_key).toBe("user-123");
  });
});

describe("GET /endpoint/sessions", () => {
  it("lists only the caller's own sessions", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").set(KEY, "user-a").send({ agent_session_id: "a1" });
    await request(app).post("/endpoint/sessions").set(KEY, "user-a").send({ agent_session_id: "a2" });
    await request(app).post("/endpoint/sessions").set(KEY, "user-b").send({ agent_session_id: "b1" });

    const forA = await request(app).get("/endpoint/sessions").set(KEY, "user-a").expect(200);
    expect(forA.body.object).toBe("list");
    expect(forA.body.data.map((s: { agent_session_id: string }) => s.agent_session_id).sort()).toEqual(
      ["a1", "a2"],
    );

    const forB = await request(app).get("/endpoint/sessions").set(KEY, "user-b").expect(200);
    expect(forB.body.data.map((s: { agent_session_id: string }) => s.agent_session_id)).toEqual(["b1"]);
  });

  it("exposes a cross-user view with all=true (the Foundry User role)", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").set(KEY, "user-a").send({ agent_session_id: "a1" });
    await request(app).post("/endpoint/sessions").set(KEY, "user-b").send({ agent_session_id: "b1" });

    const all = await request(app).get("/endpoint/sessions").query({ all: "true" }).expect(200);
    expect(all.body.data).toHaveLength(2);
  });
});

describe("GET /endpoint/sessions/:id", () => {
  it("returns a session the caller owns", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").set(KEY, "user-a").send({ agent_session_id: "s1" });
    const res = await request(app).get("/endpoint/sessions/s1").set(KEY, "user-a").expect(200);
    expect(res.body.agent_session_id).toBe("s1");
  });

  /** Another caller's session must be invisible, not merely forbidden. */
  it("hides a session belonging to another isolation key", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").set(KEY, "user-a").send({ agent_session_id: "s1" });
    await request(app).get("/endpoint/sessions/s1").set(KEY, "user-b").expect(404);
  });

  it("404s for an unknown session", async () => {
    const { app } = harness();
    await request(app).get("/endpoint/sessions/nope").expect(404);
  });
});

describe("session stop and delete", () => {
  it("stops a session, keeping its state", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").send({ agent_session_id: "s1" });
    await request(app)
      .post("/api/demo/debit")
      .send({ agent_session_id: "s1", amountMinor: 100_000 })
      .expect(200);

    const res = await request(app).post("/endpoint/sessions/s1:stop").expect(200);
    expect(res.body.status).toBe("stopped");

    // Resuming restores the debited balance.
    const state = await request(app).get("/api/state").query({ agent_session_id: "s1" }).expect(200);
    expect(state.body.accounts[0].balanceMinor).toBe(24_000);
  });

  it("stopping twice succeeds", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").send({ agent_session_id: "s1" });
    await request(app).post("/endpoint/sessions/s1:stop").expect(200);
    await request(app).post("/endpoint/sessions/s1:stop").expect(200);
  });

  it("deletes a session and its volume", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").send({ agent_session_id: "s1" });
    await request(app).delete("/endpoint/sessions/s1").expect(204);
    await request(app).get("/endpoint/sessions/s1").expect(404);
  });

  it("refuses to delete another caller's session", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").set(KEY, "user-a").send({ agent_session_id: "s1" });
    await request(app).delete("/endpoint/sessions/s1").set(KEY, "user-b").expect(404);
    // Still there for its owner.
    await request(app).get("/endpoint/sessions/s1").set(KEY, "user-a").expect(200);
  });
});

describe("session files", () => {
  it("uploads, lists, downloads and deletes", async () => {
    const { app } = harness();
    await request(app).post("/endpoint/sessions").send({ agent_session_id: "s1" });

    const upload = await request(app)
      .put("/endpoint/sessions/s1/files/content")
      .query({ path: "statement.csv" })
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("date,amount\n2026-07-30,-4.20\n"))
      .expect(201);
    expect(upload.body.path).toBe("statement.csv");
    expect(upload.body.size).toBeGreaterThan(0);

    const list = await request(app)
      .get("/endpoint/sessions/s1/files")
      .query({ path: "." })
      .expect(200);
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0].name).toBe("statement.csv");
    expect(list.body.entries[0].is_directory).toBe(false);

    const download = await request(app)
      .get("/endpoint/sessions/s1/files/content")
      .query({ path: "statement.csv" })
      .buffer(true)
      .expect(200)
      .expect("Content-Type", /application\/octet-stream/);
    // Binary-safe download, so the payload arrives as a Buffer.
    expect(Buffer.from(download.body).toString("utf8")).toContain("2026-07-30");

    await request(app)
      .delete("/endpoint/sessions/s1/files")
      .query({ path: "statement.csv" })
      .expect(204);
    await request(app)
      .get("/endpoint/sessions/s1/files/content")
      .query({ path: "statement.csv" })
      .expect(404);
  });

  it("round-trips binary content byte for byte", async () => {
    const { app } = harness();
    // Bytes that would be mangled by any utf8 round-trip.
    const binary = Buffer.from([0x00, 0xff, 0x1f, 0x80, 0xfe, 0x7f, 0x00, 0xc3]);

    await request(app)
      .put("/endpoint/sessions/s1/files/content")
      .query({ path: "blob.bin" })
      .set("Content-Type", "application/octet-stream")
      .send(binary)
      .expect(201);

    const download = await request(app)
      .get("/endpoint/sessions/s1/files/content")
      .query({ path: "blob.bin" })
      .buffer(true)
      .expect(200);

    expect(Buffer.from(download.body).equals(binary)).toBe(true);
  });

  /** Foundry allows uploading before the first turn; the session is created. */
  it("creates the session implicitly on upload", async () => {
    const { app } = harness();
    await request(app)
      .put("/endpoint/sessions/fresh/files/content")
      .query({ path: "a.txt" })
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("hi"))
      .expect(201);
    await request(app).get("/endpoint/sessions/fresh").expect(200);
  });

  it("requires a path", async () => {
    const { app } = harness();
    await request(app)
      .put("/endpoint/sessions/s1/files/content")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("x"))
      .expect(400);
    await request(app).get("/endpoint/sessions/s1/files/content").expect(400);
    await request(app).delete("/endpoint/sessions/s1/files").expect(400);
  });

  it("rejects an empty upload", async () => {
    const { app } = harness();
    await request(app)
      .put("/endpoint/sessions/s1/files/content")
      .query({ path: "empty.txt" })
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(0))
      .expect(400);
  });

  it("404s downloading a file that does not exist", async () => {
    const { app } = harness();
    await request(app)
      .get("/endpoint/sessions/s1/files/content")
      .query({ path: "ghost.txt" })
      .expect(404);
  });

  /** Traversal would expose another session's state.json. */
  it("refuses a traversal path", async () => {
    const { app } = harness();
    const res = await request(app)
      .put("/endpoint/sessions/s1/files/content")
      .query({ path: "../../escaped.txt" })
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("nope"));
    // Either rejected outright, or safely contained inside the session.
    if (res.status === 201) {
      const outside = path.join(tempRoot, "escaped.txt");
      await expect(fs.access(outside)).rejects.toThrow();
    } else {
      expect(res.status).toBe(400);
    }
  });

  it("keeps one session's files invisible to another", async () => {
    const { app } = harness();
    await request(app)
      .put("/endpoint/sessions/s-a/files/content")
      .query({ path: "secret.txt" })
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("a-only"))
      .expect(201);

    const list = await request(app).get("/endpoint/sessions/s-b/files").expect(200);
    expect(list.body.entries).toEqual([]);
  });

  it("documents the 50 MB upload ceiling", () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe("conversations API", () => {
  it("creates a conversation bound to a session", async () => {
    const { app } = harness();
    const res = await request(app)
      .post("/endpoint/protocols/openai/conversations")
      .send({})
      .expect(201);

    expect(res.body.object).toBe("conversation");
    expect(res.body.id).toMatch(/^conv_/);
    expect(res.body.agent_session_id).toMatch(/^sess_/);
    expect(res.body.message_count).toBe(0);
  });

  it("routes every turn for a conversation to the same session", async () => {
    const { app } = harness();
    const created = await request(app)
      .post("/endpoint/protocols/openai/conversations")
      .send({})
      .expect(201);
    const conversationId = created.body.id;
    const boundSession = created.body.agent_session_id;

    const first = await request(app)
      .post("/responses")
      .send({ input: "one", conversation: conversationId })
      .expect(200);
    const second = await request(app)
      .post("/responses")
      .send({ input: "two", conversation: conversationId })
      .expect(200);

    expect(first.body.agent_session_id).toBe(boundSession);
    expect(second.body.agent_session_id).toBe(boundSession);
  });

  it("accumulates message history", async () => {
    const { app } = harness();
    const created = await request(app).post("/endpoint/protocols/openai/conversations").send({});
    const id = created.body.id;

    await request(app).post("/responses").send({ input: "hello", conversation: id }).expect(200);

    const fetched = await request(app)
      .get(`/endpoint/protocols/openai/conversations/${id}`)
      .expect(200);
    expect(fetched.body.message_count).toBe(2);
    expect(fetched.body.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(fetched.body.messages[1].role).toBe("assistant");
  });

  it("lists and deletes conversations", async () => {
    const { app } = harness();
    const created = await request(app).post("/endpoint/protocols/openai/conversations").send({});
    const id = created.body.id;

    const list = await request(app).get("/endpoint/protocols/openai/conversations").expect(200);
    expect(list.body.data.some((c: { id: string }) => c.id === id)).toBe(true);

    await request(app).delete(`/endpoint/protocols/openai/conversations/${id}`).expect(204);
    await request(app).get(`/endpoint/protocols/openai/conversations/${id}`).expect(404);
  });

  it("404s deleting an unknown conversation", async () => {
    const { app } = harness();
    await request(app).delete("/endpoint/protocols/openai/conversations/nope").expect(404);
  });

  /** A conversation survives the sandbox being torn down. */
  it("persists history across a deprovision", async () => {
    const { app } = harness();
    const created = await request(app).post("/endpoint/protocols/openai/conversations").send({});
    const id = created.body.id;
    const sessionId = created.body.agent_session_id;

    await request(app).post("/responses").send({ input: "remember this", conversation: id }).expect(200);
    await request(app).post("/api/demo/deprovision").send({ agent_session_id: sessionId }).expect(200);

    const fetched = await request(app)
      .get(`/endpoint/protocols/openai/conversations/${id}`)
      .expect(200);
    expect(fetched.body.messages[0].content).toBe("remember this");
  });
});
