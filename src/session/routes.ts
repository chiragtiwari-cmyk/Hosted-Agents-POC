/**
 * Session and conversation management routes, mirroring Foundry's contract.
 *
 *   POST   /endpoint/sessions                        create (optional version pin)
 *   GET    /endpoint/sessions                        list (scoped by isolation key)
 *   GET    /endpoint/sessions/:id                    get
 *   POST   /endpoint/sessions/:id:stop               stop compute, keep volume
 *   DELETE /endpoint/sessions/:id                    delete session and volume
 *   PUT    /endpoint/sessions/:id/files/content?path= upload  (50 MB cap)
 *   GET    /endpoint/sessions/:id/files?path=         list
 *   GET    /endpoint/sessions/:id/files/content?path= download
 *   DELETE /endpoint/sessions/:id/files?path=         delete
 *   POST   /endpoint/protocols/openai/conversations   create conversation
 *   GET    /endpoint/protocols/openai/conversations/:id
 *   DELETE /endpoint/protocols/openai/conversations/:id
 *
 * Isolation keys: Foundry supports two schemes. `Entra` (default) derives the key
 * from the caller's token; `Header` reads `x-ms-user-isolation-key`. We implement
 * Header, falling back to a fixed key, because there is no Entra token locally.
 * The key is a partitioning value, NOT authorization — real access control
 * belongs in a layer above the agent endpoint.
 */
import express, { type Request, type Response, type Router } from "express";
import type { SessionManager } from "./manager.js";
import type { ConversationStore } from "./conversations.js";

/** Foundry's documented per-file upload limit. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const DEFAULT_ISOLATION_KEY = "default";

export interface SessionRoutesDeps {
  sessions: SessionManager;
  conversations: ConversationStore;
  /** Grants the cross-user view that Foundry gates behind the Foundry User role. */
  allowAdminList?: boolean;
}

/**
 * Reads the isolation key. Header scheme; absent header means the default
 * partition so local use needs no ceremony.
 */
export function isolationKeyOf(req: Request): string {
  const header = req.header("x-ms-user-isolation-key");
  return header && header.trim() ? header.trim() : DEFAULT_ISOLATION_KEY;
}

function firstParam(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: { type: "not_found", message } });
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { type: "invalid_request_error", message } });
}

export function createSessionRouter(deps: SessionRoutesDeps): Router {
  const router = express.Router();
  const { sessions, conversations } = deps;

  /* ------------------------------------------------------------- sessions */

  router.post("/endpoint/sessions", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      version_indicator?: { type?: string; agent_version?: string };
      agent_session_id?: string;
    };

    const pin = body.version_indicator?.agent_version;
    if (pin && /^@/.test(pin)) {
      // Foundry rejects aliases here; the pin must be a concrete version.
      return badRequest(res, "version_indicator.agent_version must be a concrete version, not an alias.");
    }

    const sessionId = body.agent_session_id ?? `sess_${Math.random().toString(36).slice(2, 12)}`;
    const session = await sessions.acquire(sessionId, {
      isolationKey: isolationKeyOf(req),
      ...(pin ? { versionIndicator: pin } : {}),
    });

    res.status(201).json(toSessionPayload(await sessions.get(session.metadata.agentSessionId)));
  });

  router.get("/endpoint/sessions", async (req: Request, res: Response) => {
    // An explicit all=true models the admin (Foundry User role) cross-user view.
    const wantsAll = firstParam(req.query.all) === "true" && deps.allowAdminList !== false;
    const views = await sessions.list(wantsAll ? undefined : isolationKeyOf(req));
    res.json({ data: views.map(toSessionPayload), object: "list" });
  });

  router.get("/endpoint/sessions/:id", async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    const view = id ? await sessions.get(id) : undefined;
    if (!view) return notFound(res, `No session ${id}`);
    if (view.isolationKey !== isolationKeyOf(req)) return notFound(res, `No session ${id}`);
    res.json(toSessionPayload(view));
  });

  /**
   * Foundry spells this `POST .../sessions/{id}:stop`. Express treats the colon
   * as a param delimiter, so the route is registered against the literal.
   */
  router.post("/endpoint/sessions/:id\\:stop", async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    if (!id) return badRequest(res, "Session id is required.");
    const view = await sessions.get(id);
    if (view && view.isolationKey !== isolationKeyOf(req)) {
      return notFound(res, `No session ${id}`);
    }
    const stopped = await sessions.stop(id);
    if (!stopped) return notFound(res, `No session ${id}`);
    res.json(toSessionPayload(await sessions.get(id)));
  });

  router.delete("/endpoint/sessions/:id", async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    if (!id) return badRequest(res, "Session id is required.");
    const view = await sessions.get(id);
    if (!view) return notFound(res, `No session ${id}`);
    if (view.isolationKey !== isolationKeyOf(req)) return notFound(res, `No session ${id}`);
    await sessions.delete(id);
    res.status(204).end();
  });

  /* ---------------------------------------------------------------- files */

  /** Raw body, so binary uploads survive. */
  const rawBody = express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES });

  router.put("/endpoint/sessions/:id/files/content", rawBody, async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    const filePath = firstParam(req.query.path);
    if (!id) return badRequest(res, "Session id is required.");
    if (!filePath) return badRequest(res, "`path` query parameter is required.");

    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
    if (data.byteLength === 0) return badRequest(res, "Upload body is empty.");
    if (data.byteLength > MAX_UPLOAD_BYTES) {
      return res.status(413).json({
        error: { type: "payload_too_large", message: `Maximum upload size is ${MAX_UPLOAD_BYTES} bytes.` },
      });
    }

    try {
      // Touch the session so uploading before the first turn works, as Foundry allows.
      await sessions.acquire(id, { isolationKey: isolationKeyOf(req) });
      await sessions.store.writeFile(id, filePath, data);
      res.status(201).json({ path: filePath, size: data.byteLength });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
  });

  router.get("/endpoint/sessions/:id/files", async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    if (!id) return badRequest(res, "Session id is required.");
    const target = firstParam(req.query.path) ?? ".";
    try {
      const entries = await sessions.store.listFiles(id, target);
      res.json({
        entries: entries.map((entry) => ({
          name: entry.name,
          size: entry.size,
          is_directory: entry.isDirectory,
          modified_at: entry.modifiedAt,
        })),
      });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
  });

  router.get("/endpoint/sessions/:id/files/content", async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    const filePath = firstParam(req.query.path);
    if (!id) return badRequest(res, "Session id is required.");
    if (!filePath) return badRequest(res, "`path` query parameter is required.");
    try {
      const data = await sessions.store.readFile(id, filePath);
      if (!data) return notFound(res, `No file at ${filePath}`);
      res.setHeader("Content-Type", "application/octet-stream");
      res.send(data);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
  });

  router.delete("/endpoint/sessions/:id/files", async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    const filePath = firstParam(req.query.path);
    if (!id) return badRequest(res, "Session id is required.");
    if (!filePath) return badRequest(res, "`path` query parameter is required.");
    try {
      const existing = await sessions.store.readFile(id, filePath);
      if (!existing) return notFound(res, `No file at ${filePath}`);
      await sessions.store.deleteFile(id, filePath);
      res.status(204).end();
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
  });

  /* -------------------------------------------------------- conversations */

  router.post("/endpoint/protocols/openai/conversations", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { metadata?: Record<string, string>; agent_session_id?: string };
    // A conversation binds a stable session, so later turns reuse one sandbox.
    const sessionId = body.agent_session_id ?? `sess_${Math.random().toString(36).slice(2, 12)}`;
    await sessions.acquire(sessionId, { isolationKey: isolationKeyOf(req) });
    const record = await conversations.create({
      agentSessionId: sessionId,
      ...(body.metadata ? { metadata: body.metadata } : {}),
    });
    res.status(201).json(toConversationPayload(record));
  });

  router.get("/endpoint/protocols/openai/conversations", async (_req, res: Response) => {
    const all = await conversations.list();
    res.json({ object: "list", data: all.map(toConversationPayload) });
  });

  router.get("/endpoint/protocols/openai/conversations/:id", async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    const record = id ? await conversations.get(id) : undefined;
    if (!record) return notFound(res, `No conversation ${id}`);
    res.json({
      ...toConversationPayload(record),
      messages: record.messages,
    });
  });

  router.delete("/endpoint/protocols/openai/conversations/:id", async (req: Request, res: Response) => {
    const id = firstParam(req.params.id);
    if (!id) return badRequest(res, "Conversation id is required.");
    const existed = await conversations.get(id);
    if (!existed) return notFound(res, `No conversation ${id}`);
    await conversations.delete(id);
    res.status(204).end();
  });

  return router;
}

function toSessionPayload(view: Awaited<ReturnType<SessionManager["get"]>>) {
  if (!view) return undefined;
  return {
    agent_session_id: view.agentSessionId,
    object: "agent.session",
    status: view.status,
    created_at: Math.floor(view.createdAtMs / 1000),
    last_used_at: Math.floor(view.lastUsedAtMs / 1000),
    expires_at: Math.floor(view.expiresAtMs / 1000),
    isolation_key: view.isolationKey,
    resume_count: view.resumeCount,
    idle_in_seconds: Math.floor(view.idleInMs / 1000),
    disk_used_bytes: view.diskUsedBytes,
    disk_budget_bytes: view.diskBudgetBytes,
    ...(view.versionIndicator ? { version_indicator: view.versionIndicator } : {}),
  };
}

function toConversationPayload(record: {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  agentSessionId: string;
  messages: unknown[];
  metadata: Record<string, string>;
}) {
  return {
    id: record.id,
    object: "conversation",
    created_at: Math.floor(record.createdAtMs / 1000),
    updated_at: Math.floor(record.updatedAtMs / 1000),
    agent_session_id: record.agentSessionId,
    message_count: record.messages.length,
    metadata: record.metadata,
  };
}
