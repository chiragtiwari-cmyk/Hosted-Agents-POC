/**
 * Session lifecycle, mirroring Foundry's hosted-agent model.
 *
 * Foundry's semantics, which this reproduces:
 *
 *   active   compute running, requests routed to it, $HOME available
 *   idle     no requests for 15 minutes; compute deprovisioned, state persisted
 *   stopped  compute terminated explicitly, filesystem volume retained
 *   resumed  same session ID used again; new compute, state restored
 *
 * Deleting a session releases its resources; stopping keeps the volume.
 * Sessions are permanently deleted after 30 days of inactivity.
 *
 * IMPORTANT — session is not conversation. A session is the sandbox and its
 * filesystem. A conversation is message history. Reusing a session ID does NOT
 * replay prior messages; that is what conversation IDs are for. Conflating them
 * is the most common mistake against this API, so they are separate types here.
 */
import type { BankData } from "../bank/ledger.js";
import { Ledger } from "../bank/ledger.js";
import { SessionStorage, STATE_SCHEMA_VERSION } from "./storage.js";

/** Foundry's documented timings. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** 20 GiB at 1 vCPU+, minus ~20% reserved for system use. */
export const SESSION_DISK_BUDGET_BYTES = Math.floor(20 * 1024 ** 3 * 0.8);

export type SessionStatus = "active" | "idle" | "stopped";

export interface SessionMetadata {
  agentSessionId: string;
  status: SessionStatus;
  createdAtMs: number;
  lastUsedAtMs: number;
  /** Scoping value; a caller only sees sessions tagged with their key. */
  isolationKey: string;
  /** Agent version this session is pinned to, when explicitly bound. */
  versionIndicator?: string;
  /** Times the sandbox has been restored from persisted state. */
  resumeCount: number;
}

/** On-disk shape of a session's state. */
interface PersistedSessionState {
  schemaVersion: number;
  metadata: SessionMetadata;
  /** Serialised ledger. Absent on a fresh session — seeded from fixtures. */
  bank?: BankData;
  /** Pending confirmation carried across turns. */
  pendingToken?: string;
}

/**
 * A live session: metadata plus the in-memory objects reconstructed from disk.
 * `ledger` is per-session, so two customers cannot see each other's money.
 */
export interface LiveSession {
  metadata: SessionMetadata;
  ledger: Ledger;
  pendingToken?: string;
}

export interface SessionView extends SessionMetadata {
  diskUsedBytes: number;
  diskBudgetBytes: number;
  /** Milliseconds until idle deprovisioning, or 0 once elapsed. */
  idleInMs: number;
  expiresAtMs: number;
}

export class SessionManager {
  /** Reconstructed sessions. Cleared on deprovision; rebuilt from disk. */
  private live = new Map<string, LiveSession>();
  /** sessionId -> reason, for sessions whose last persist failed. */
  private persistFailures = new Map<string, string>();

  constructor(
    private storage: SessionStorage = new SessionStorage(),
    private now: () => number = () => Date.now(),
  ) {}

  get store(): SessionStorage {
    return this.storage;
  }

  /**
   * Get or create a session, restoring persisted state when present.
   *
   * This is the resume path: after the sandbox is deprovisioned the in-memory
   * map is empty, so the next reference reads state.json back off $HOME.
   */
  async acquire(
    sessionId: string,
    options: { isolationKey?: string; versionIndicator?: string } = {},
  ): Promise<LiveSession> {
    const cached = this.live.get(sessionId);
    if (cached) {
      cached.metadata.status = "active";
      cached.metadata.lastUsedAtMs = this.now();
      return cached;
    }

    const persisted = await this.storage.readState<PersistedSessionState>(sessionId);

    if (persisted) {
      if (persisted.schemaVersion !== STATE_SCHEMA_VERSION) {
        // Refuse rather than guess at an incompatible shape; a wrong ledger is
        // worse than a clear error.
        throw new Error(
          `Session ${sessionId} was written by schema v${persisted.schemaVersion}; ` +
            `this build expects v${STATE_SCHEMA_VERSION}.`,
        );
      }

      const restored: LiveSession = {
        metadata: {
          ...persisted.metadata,
          status: "active",
          lastUsedAtMs: this.now(),
          resumeCount: persisted.metadata.resumeCount + 1,
        },
        ledger: new Ledger(persisted.bank, this.now),
        ...(persisted.pendingToken ? { pendingToken: persisted.pendingToken } : {}),
      };
      this.live.set(sessionId, restored);
      await this.persist(sessionId);
      return restored;
    }

    const created: LiveSession = {
      metadata: {
        agentSessionId: sessionId,
        status: "active",
        createdAtMs: this.now(),
        lastUsedAtMs: this.now(),
        isolationKey: options.isolationKey ?? "default",
        ...(options.versionIndicator ? { versionIndicator: options.versionIndicator } : {}),
        resumeCount: 0,
      },
      ledger: new Ledger(undefined, this.now),
    };
    this.live.set(sessionId, created);
    await this.persist(sessionId);
    return created;
  }

  /**
   * The live session, without acquiring or restoring it. Used by tools that need
   * to read ledger facts for a session already in flight — acquiring here would
   * reactivate an idle session as a side effect of a tool call.
   */
  peek(sessionId: string): LiveSession | undefined {
    return this.live.get(sessionId);
  }

  /**
   * Write a session's state to $HOME. Called after every mutating turn.
   *
   * A write failure is reported but NOT thrown. Losing durability is bad; taking
   * the whole agent down is worse — the turn in flight should still answer, and
   * an unwritable volume must not become a crash loop. Observed for real: a
   * root-owned mounted volume made the first write fail with EACCES and killed
   * the process on startup.
   */
  async persist(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session) return;
    const state: PersistedSessionState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      metadata: session.metadata,
      bank: session.ledger.toJSON(),
      ...(session.pendingToken ? { pendingToken: session.pendingToken } : {}),
    };
    try {
      await this.storage.writeState(sessionId, state);
      this.persistFailures.delete(sessionId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.persistFailures.set(sessionId, reason);
      // Surface it loudly — silent non-durability is its own trap.
      console.error(
        `[session] failed to persist ${sessionId}: ${reason}. ` +
          `State is in memory only and will be lost when this compute is recycled.`,
      );
    }
  }

  /** Sessions whose last write failed, so /health can report degraded durability. */
  get durabilityFailures(): { sessionId: string; reason: string }[] {
    return [...this.persistFailures.entries()].map(([sessionId, reason]) => ({
      sessionId,
      reason,
    }));
  }

  async setPendingToken(sessionId: string, token: string | undefined): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session) return;
    if (token) session.pendingToken = token;
    else delete session.pendingToken;
    await this.persist(sessionId);
  }

  /**
   * Drop a session's compute while keeping its persisted volume — Foundry's
   * "stop", and what happens automatically at the idle timeout. The next
   * `acquire` restores from disk.
   */
  async stop(sessionId: string): Promise<boolean> {
    const session = this.live.get(sessionId);
    if (session) {
      session.metadata.status = "stopped";
      await this.persist(sessionId);
      this.live.delete(sessionId);
      return true;
    }
    // Stopping an already-stopped session succeeds, per the platform contract.
    const persisted = await this.storage.readState<PersistedSessionState>(sessionId);
    if (!persisted) return false;
    persisted.metadata.status = "stopped";
    await this.storage.writeState(sessionId, persisted);
    return true;
  }

  /** Terminate and release resources, including the persisted filesystem. */
  async delete(sessionId: string): Promise<boolean> {
    this.live.delete(sessionId);
    return this.storage.deleteSession(sessionId);
  }

  /**
   * Simulates the 15-minute idle deprovision without waiting. Used by the
   * workshop's "deprovision" control and by tests: it clears in-memory state so
   * the next turn must restore from $HOME.
   */
  async deprovisionIdle(nowMs = this.now()): Promise<string[]> {
    const deprovisioned: string[] = [];
    for (const [id, session] of [...this.live.entries()]) {
      if (nowMs - session.metadata.lastUsedAtMs >= IDLE_TIMEOUT_MS) {
        session.metadata.status = "idle";
        await this.persist(id);
        this.live.delete(id);
        deprovisioned.push(id);
      }
    }
    return deprovisioned;
  }

  /** Forcibly deprovision one session regardless of elapsed time. */
  async forceDeprovision(sessionId: string): Promise<boolean> {
    const session = this.live.get(sessionId);
    if (!session) return false;
    session.metadata.status = "idle";
    await this.persist(sessionId);
    this.live.delete(sessionId);
    return true;
  }

  async get(sessionId: string): Promise<SessionView | undefined> {
    const live = this.live.get(sessionId);
    const metadata =
      live?.metadata ??
      (await this.storage.readState<PersistedSessionState>(sessionId))?.metadata;
    if (!metadata) return undefined;
    return this.toView(metadata, await this.storage.sessionSizeBytes(sessionId));
  }

  /**
   * List sessions visible to a caller. Foundry scopes by isolation key: a caller
   * sees only their own sessions unless they hold the Foundry User role, which
   * grants cross-user access. `isolationKey: undefined` models that admin view.
   */
  async list(isolationKey?: string): Promise<SessionView[]> {
    const ids = new Set([...this.live.keys(), ...(await this.storage.listSessionIds())]);
    const views: SessionView[] = [];
    for (const id of ids) {
      const live = this.live.get(id);
      const metadata =
        live?.metadata ?? (await this.storage.readState<PersistedSessionState>(id))?.metadata;
      if (!metadata) continue;
      if (isolationKey !== undefined && metadata.isolationKey !== isolationKey) continue;
      views.push(this.toView(metadata, await this.storage.sessionSizeBytes(id)));
    }
    return views.sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs);
  }

  /** Purge sessions past the 30-day maximum lifetime. */
  async purgeExpired(): Promise<string[]> {
    const purged: string[] = [];
    for (const view of await this.list()) {
      if (this.now() - view.lastUsedAtMs > MAX_LIFETIME_MS) {
        await this.delete(view.agentSessionId);
        purged.push(view.agentSessionId);
      }
    }
    return purged;
  }

  private toView(metadata: SessionMetadata, diskUsedBytes: number): SessionView {
    const elapsed = this.now() - metadata.lastUsedAtMs;
    return {
      ...metadata,
      diskUsedBytes,
      diskBudgetBytes: SESSION_DISK_BUDGET_BYTES,
      idleInMs: Math.max(0, IDLE_TIMEOUT_MS - elapsed),
      expiresAtMs: metadata.lastUsedAtMs + MAX_LIFETIME_MS,
    };
  }
}
