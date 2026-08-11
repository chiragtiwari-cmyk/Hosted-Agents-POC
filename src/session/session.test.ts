import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../bank/ledger.js";
import { IDLE_TIMEOUT_MS, MAX_LIFETIME_MS, SessionManager } from "./manager.js";
import { SessionStorage, storageRoot } from "./storage.js";

const CLOCK_START = Date.parse("2026-07-31T09:00:00Z");

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "folab-session-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function makeManager() {
  let nowMs = CLOCK_START;
  const storage = new SessionStorage(tempRoot);
  const manager = new SessionManager(storage, () => nowMs);
  return {
    storage,
    manager,
    advance(ms: number) {
      nowMs += ms;
    },
    /** A fresh manager over the SAME directory — models a new sandbox. */
    reboot() {
      return new SessionManager(new SessionStorage(tempRoot), () => nowMs);
    },
  };
}

describe("storageRoot", () => {
  it("honours an explicit override", () => {
    expect(storageRoot({ SESSION_STATE_DIR: "/tmp/x" })).toBe("/tmp/x");
  });

  it("writes beneath HOME when running as a Foundry hosted agent", () => {
    const root = storageRoot({ HOME: "/home/agent", FOUNDRY_AGENT_NAME: "my-agent" });
    expect(root).toBe("/home/agent/.agent-state");
  });

  it("stays inside the project when running locally", () => {
    const root = storageRoot({ HOME: "/Users/someone" });
    expect(root).toContain(".session-state");
    expect(root).not.toContain("/Users/someone");
  });
});

describe("ledger serialisation", () => {
  it("round-trips balances, transactions and counters", () => {
    const original = new Ledger(undefined, () => CLOCK_START);
    const staged = original.stagePayment({ toPayeeHint: "alice", amountMinor: 20_000 });
    original.commitPayment(staged.pending.token);

    const restored = new Ledger(original.toJSON(), () => CLOCK_START);

    expect(restored.getAccount("acc-current").balanceMinor).toBe(104_000);
    expect(restored.recentTransactions("acc-current")[0]?.description).toBe(
      "Payment to Alice Chen",
    );
    expect(restored.customer.name).toBe("Sam Rivera");
  });

  /**
   * The important one: a staged payment must survive a restore with its
   * reservation intact, or resuming a session would silently free the funds.
   */
  it("preserves a staged payment and its reservation across a restore", () => {
    const original = new Ledger(undefined, () => CLOCK_START);
    const staged = original.stagePayment({ toPayeeHint: "alice", amountMinor: 20_000 });
    expect(original.getAccount("acc-current").availableMinor).toBe(104_000);

    const restored = new Ledger(original.toJSON(), () => CLOCK_START);

    // Reservation still reflected, balance untouched.
    expect(restored.getAccount("acc-current").balanceMinor).toBe(124_000);
    expect(restored.getAccount("acc-current").availableMinor).toBe(104_000);
    // And the token still commits.
    const { receipt } = restored.commitPayment(staged.pending.token);
    expect(receipt.newBalanceMinor).toBe(104_000);
    expect(restored.getAccount("acc-current").availableMinor).toBe(104_000);
  });

  it("does not double-apply a reservation on restore", () => {
    const original = new Ledger(undefined, () => CLOCK_START);
    original.stagePayment({ toPayeeHint: "alice", amountMinor: 100_000 });

    // Two restores in a row must not compound the reservation.
    const once = new Ledger(original.toJSON(), () => CLOCK_START);
    const twice = new Ledger(once.toJSON(), () => CLOCK_START);

    expect(twice.getAccount("acc-current").availableMinor).toBe(24_000);
  });

  it("does not reissue a token id after a restore", () => {
    const original = new Ledger(undefined, () => CLOCK_START);
    const first = original.stagePayment({ toPayeeHint: "alice", amountMinor: 1_000 });

    const restored = new Ledger(original.toJSON(), () => CLOCK_START);
    const second = restored.stagePayment({ toPayeeHint: "bob", amountMinor: 1_000 });

    expect(second.pending.token).not.toBe(first.pending.token);
  });
});

describe("session lifecycle", () => {
  it("creates a session on first use", async () => {
    const { manager } = makeManager();
    const session = await manager.acquire("sess-1", { isolationKey: "user-a" });

    expect(session.metadata.agentSessionId).toBe("sess-1");
    expect(session.metadata.status).toBe("active");
    expect(session.metadata.resumeCount).toBe(0);
    expect(session.metadata.isolationKey).toBe("user-a");
    expect(session.ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });

  it("returns the same live session on re-acquire without incrementing resumes", async () => {
    const { manager } = makeManager();
    const first = await manager.acquire("sess-1");
    first.ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 5_000 });

    const second = await manager.acquire("sess-1");

    expect(second).toBe(first);
    expect(second.metadata.resumeCount).toBe(0);
  });

  /** The headline behaviour: state survives the sandbox being torn down. */
  it("restores ledger state after deprovisioning", async () => {
    const { manager } = makeManager();
    const session = await manager.acquire("sess-1");
    const staged = session.ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 20_000 });
    session.ledger.commitPayment(staged.pending.token);
    await manager.persist("sess-1");

    await manager.forceDeprovision("sess-1");
    const resumed = await manager.acquire("sess-1");

    expect(resumed.metadata.resumeCount).toBe(1);
    expect(resumed.metadata.status).toBe("active");
    expect(resumed.ledger.getAccount("acc-current").balanceMinor).toBe(104_000);
  });

  it("restores state in a brand-new process", async () => {
    const { manager, reboot } = makeManager();
    const session = await manager.acquire("sess-1");
    const staged = session.ledger.stagePayment({ toPayeeHint: "bob", amountMinor: 30_000 });
    session.ledger.commitPayment(staged.pending.token);
    await manager.persist("sess-1");

    // A different SessionManager over the same $HOME — a new sandbox.
    const fresh = reboot();
    const resumed = await fresh.acquire("sess-1");

    expect(resumed.ledger.getAccount("acc-current").balanceMinor).toBe(94_000);
  });

  it("carries a pending confirmation across a deprovision", async () => {
    const { manager } = makeManager();
    const session = await manager.acquire("sess-1");
    const staged = session.ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 20_000 });
    await manager.setPendingToken("sess-1", staged.pending.token);

    await manager.forceDeprovision("sess-1");
    const resumed = await manager.acquire("sess-1");

    expect(resumed.pendingToken).toBe(staged.pending.token);
    // And it is still committable.
    const { receipt } = resumed.ledger.commitPayment(resumed.pendingToken!);
    expect(receipt.newBalanceMinor).toBe(104_000);
  });

  it("persists submitted loan applications across a restart", async () => {
    const { manager, reboot } = makeManager();
    const session = await manager.acquire("sess-1");
    const staged = session.ledger.stageApplication({
      productId: "loan-personal",
      amountMinor: 500_000,
      termMonths: 36,
    });
    const { application } = session.ledger.submitApplication(staged.pending.token);
    await manager.persist("sess-1");

    const resumed = await reboot().acquire("sess-1");
    const restored = resumed.ledger.listApplications();

    expect(restored).toHaveLength(1);
    expect(restored[0]!.reference).toBe(application.reference);
    expect(restored[0]!.monthlyPaymentMinor).toBe(15_416);
  });

  it("carries a staged application across a deprovision", async () => {
    const { manager } = makeManager();
    const session = await manager.acquire("sess-1");
    const staged = session.ledger.stageApplication({
      productId: "loan-personal",
      amountMinor: 500_000,
      termMonths: 36,
    });
    await manager.setPendingToken("sess-1", staged.pending.token);

    await manager.forceDeprovision("sess-1");
    const resumed = await manager.acquire("sess-1");

    // The staged application survived and is still submittable.
    expect(resumed.pendingToken).toBe(staged.pending.token);
    const { application } = resumed.ledger.submitApplication(resumed.pendingToken!);
    expect(application.reference).toMatch(/^APP\d+/);
  });

  it("does not reissue an application reference after a restore", async () => {
    const { manager, reboot } = makeManager();
    const session = await manager.acquire("sess-1");
    const first = session.ledger.stageApplication({
      productId: "loan-personal",
      amountMinor: 500_000,
      termMonths: 36,
    });
    const a = session.ledger.submitApplication(first.pending.token).application;
    await manager.persist("sess-1");

    const resumed = await reboot().acquire("sess-1");
    const second = resumed.ledger.stageApplication({
      productId: "loan-auto",
      amountMinor: 500_000,
      termMonths: 36,
    });
    const b = resumed.ledger.submitApplication(second.pending.token).application;

    expect(b.reference).not.toBe(a.reference);
    expect(resumed.ledger.listApplications()).toHaveLength(2);
  });

  it("isolates one session's money from another's", async () => {
    const { manager } = makeManager();
    const a = await manager.acquire("sess-a");
    const b = await manager.acquire("sess-b");

    const staged = a.ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 50_000 });
    a.ledger.commitPayment(staged.pending.token);

    expect(a.ledger.getAccount("acc-current").balanceMinor).toBe(74_000);
    expect(b.ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });
});

describe("stop and delete", () => {
  it("stop retains the volume so state survives", async () => {
    const { manager } = makeManager();
    const session = await manager.acquire("sess-1");
    const staged = session.ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 10_000 });
    session.ledger.commitPayment(staged.pending.token);
    await manager.persist("sess-1");

    expect(await manager.stop("sess-1")).toBe(true);
    expect((await manager.get("sess-1"))?.status).toBe("stopped");

    const resumed = await manager.acquire("sess-1");
    expect(resumed.ledger.getAccount("acc-current").balanceMinor).toBe(114_000);
  });

  it("stopping an already-stopped session succeeds", async () => {
    const { manager } = makeManager();
    await manager.acquire("sess-1");
    expect(await manager.stop("sess-1")).toBe(true);
    expect(await manager.stop("sess-1")).toBe(true);
  });

  it("stopping an unknown session reports false", async () => {
    const { manager } = makeManager();
    expect(await manager.stop("nope")).toBe(false);
  });

  it("delete removes the persisted filesystem", async () => {
    const { manager } = makeManager();
    await manager.acquire("sess-1");
    await manager.persist("sess-1");

    expect(await manager.delete("sess-1")).toBe(true);
    expect(await manager.get("sess-1")).toBeUndefined();

    // Re-acquiring yields a fresh ledger, not the old one.
    const recreated = await manager.acquire("sess-1");
    expect(recreated.metadata.resumeCount).toBe(0);
    expect(recreated.ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
  });
});

describe("idle deprovisioning", () => {
  it("deprovisions only sessions past the idle timeout", async () => {
    const { manager, advance } = makeManager();
    await manager.acquire("old");
    advance(IDLE_TIMEOUT_MS + 1_000);
    await manager.acquire("fresh");

    const deprovisioned = await manager.deprovisionIdle();

    expect(deprovisioned).toEqual(["old"]);
    expect((await manager.get("old"))?.status).toBe("idle");
    expect((await manager.get("fresh"))?.status).toBe("active");
  });

  it("reports time remaining before idle", async () => {
    const { manager, advance } = makeManager();
    await manager.acquire("sess-1");
    advance(5 * 60 * 1000);

    const view = await manager.get("sess-1");
    expect(view?.idleInMs).toBe(IDLE_TIMEOUT_MS - 5 * 60 * 1000);
  });

  it("purges sessions past the 30-day maximum lifetime", async () => {
    const { manager, advance } = makeManager();
    await manager.acquire("ancient");
    await manager.persist("ancient");
    advance(MAX_LIFETIME_MS + 1);

    const purged = await manager.purgeExpired();

    expect(purged).toEqual(["ancient"]);
    expect(await manager.get("ancient")).toBeUndefined();
  });
});

describe("isolation keys", () => {
  it("scopes list to the caller's own sessions", async () => {
    const { manager } = makeManager();
    await manager.acquire("a1", { isolationKey: "user-a" });
    await manager.acquire("a2", { isolationKey: "user-a" });
    await manager.acquire("b1", { isolationKey: "user-b" });

    const forA = await manager.list("user-a");
    expect(forA.map((s) => s.agentSessionId).sort()).toEqual(["a1", "a2"]);

    const forB = await manager.list("user-b");
    expect(forB.map((s) => s.agentSessionId)).toEqual(["b1"]);
  });

  it("lists every session when no key is given (the admin view)", async () => {
    const { manager } = makeManager();
    await manager.acquire("a1", { isolationKey: "user-a" });
    await manager.acquire("b1", { isolationKey: "user-b" });

    expect((await manager.list()).length).toBe(2);
  });

  it("pins a session to an explicit agent version", async () => {
    const { manager } = makeManager();
    const session = await manager.acquire("sess-1", { versionIndicator: "2" });
    expect(session.metadata.versionIndicator).toBe("2");

    await manager.forceDeprovision("sess-1");
    const resumed = await manager.acquire("sess-1");
    // The pin survives a resume — later turns keep using that version.
    expect(resumed.metadata.versionIndicator).toBe("2");
  });
});

describe("session files", () => {
  it("writes, lists, reads and deletes a file", async () => {
    const { storage } = makeManager();
    await storage.writeFile("sess-1", "notes.txt", Buffer.from("hello"));

    const listed = await storage.listFiles("sess-1");
    expect(listed.map((f) => f.name)).toEqual(["notes.txt"]);
    expect(listed[0]!.size).toBe(5);
    expect(listed[0]!.isDirectory).toBe(false);

    expect((await storage.readFile("sess-1", "notes.txt"))?.toString()).toBe("hello");
    expect(await storage.deleteFile("sess-1", "notes.txt")).toBe(true);
    expect(await storage.readFile("sess-1", "notes.txt")).toBeUndefined();
  });

  it("supports nested paths", async () => {
    const { storage } = makeManager();
    await storage.writeFile("sess-1", "reports/q3/summary.csv", Buffer.from("a,b"));
    const nested = await storage.listFiles("sess-1", "reports/q3");
    expect(nested.map((f) => f.name)).toEqual(["summary.csv"]);
  });

  /** Traversal would let one session read another's state.json. */
  it.each([
    "../../etc/passwd",
    "../state.json",
    "/etc/passwd",
    "a/../../../../outside.txt",
  ])("refuses the traversal path %j", async (bad) => {
    const { storage } = makeManager();
    // Either it throws, or it resolves safely inside the session directory.
    try {
      const resolved = storage.resolveFilePath("sess-1", bad);
      expect(resolved.startsWith(storage.sessionFilesDir("sess-1"))).toBe(true);
    } catch (error) {
      expect((error as Error).message).toContain("escapes");
    }
  });

  it("keeps one session's files invisible to another", async () => {
    const { storage } = makeManager();
    await storage.writeFile("sess-a", "secret.txt", Buffer.from("a-only"));
    expect(await storage.listFiles("sess-b")).toEqual([]);
    expect(await storage.readFile("sess-b", "secret.txt")).toBeUndefined();
  });

  it("reports disk usage for the session budget", async () => {
    const { manager, storage } = makeManager();
    await manager.acquire("sess-1");
    await manager.persist("sess-1");
    await storage.writeFile("sess-1", "big.bin", Buffer.alloc(4096));

    const view = await manager.get("sess-1");
    expect(view!.diskUsedBytes).toBeGreaterThan(4096);
    expect(view!.diskBudgetBytes).toBeGreaterThan(4096);
  });
});

describe("unwritable state volume", () => {
  /**
   * Regression: a root-owned mounted volume made the first write fail with
   * EACCES and killed the process on startup. Losing durability is bad; a crash
   * loop is worse — the turn in flight must still answer.
   */
  function brokenStorage() {
    const storage = new SessionStorage(tempRoot);
    storage.writeState = async () => {
      const error = new Error("EACCES: permission denied, mkdir '/home/node/.agent-state/sessions'");
      (error as NodeJS.ErrnoException).code = "EACCES";
      throw error;
    };
    return storage;
  }

  it("does not throw when the state volume cannot be written", async () => {
    const manager = new SessionManager(brokenStorage(), () => CLOCK_START);
    const session = await manager.acquire("sess-1");

    // The session is usable in memory even though nothing was persisted.
    expect(session.ledger.getAccount("acc-current").balanceMinor).toBe(124_000);
    await expect(manager.persist("sess-1")).resolves.toBeUndefined();
  });

  it("still serves a full payment flow with no durability", async () => {
    const manager = new SessionManager(brokenStorage(), () => CLOCK_START);
    const session = await manager.acquire("sess-1");

    const staged = session.ledger.stagePayment({ toPayeeHint: "alice", amountMinor: 20_000 });
    await manager.setPendingToken("sess-1", staged.pending.token);
    const { receipt } = session.ledger.commitPayment(staged.pending.token);

    expect(receipt.newBalanceMinor).toBe(104_000);
  });

  it("reports the failure so degraded durability is not silent", async () => {
    const manager = new SessionManager(brokenStorage(), () => CLOCK_START);
    await manager.acquire("sess-1");

    const failures = manager.durabilityFailures;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.sessionId).toBe("sess-1");
    expect(failures[0]!.reason).toContain("EACCES");
  });

  it("clears the failure once a write succeeds again", async () => {
    const storage = brokenStorage();
    const manager = new SessionManager(storage, () => CLOCK_START);
    await manager.acquire("sess-1");
    expect(manager.durabilityFailures).toHaveLength(1);

    // Volume becomes writable — e.g. ownership corrected and compute recycled.
    const working = new SessionStorage(tempRoot);
    storage.writeState = working.writeState.bind(working);
    await manager.persist("sess-1");

    expect(manager.durabilityFailures).toEqual([]);
  });

  it("reports ok when writes are working", async () => {
    const { manager } = makeManager();
    await manager.acquire("sess-1");
    expect(manager.durabilityFailures).toEqual([]);
  });
});

describe("corruption and schema handling", () => {
  it("surfaces a corrupt state file instead of silently resetting", async () => {
    const { manager, storage } = makeManager();
    await manager.acquire("sess-1");
    await manager.persist("sess-1");

    await fs.writeFile(path.join(storage.sessionDir("sess-1"), "state.json"), "{not json");

    const fresh = new SessionManager(new SessionStorage(tempRoot), () => CLOCK_START);
    await expect(fresh.acquire("sess-1")).rejects.toThrow(/Corrupt state file/);
  });

  it("refuses state written by an incompatible schema version", async () => {
    const { storage } = makeManager();
    await storage.writeState("sess-1", {
      schemaVersion: 999,
      metadata: {
        agentSessionId: "sess-1",
        status: "idle",
        createdAtMs: CLOCK_START,
        lastUsedAtMs: CLOCK_START,
        isolationKey: "default",
        resumeCount: 0,
      },
    });

    const manager = new SessionManager(storage, () => CLOCK_START);
    await expect(manager.acquire("sess-1")).rejects.toThrow(/schema v999/);
  });

  it("rejects an unusable session identifier", () => {
    const storage = new SessionStorage(tempRoot);
    expect(() => storage.sessionDir("..")).toThrow(/Invalid identifier/);
    expect(() => storage.sessionDir("")).toThrow(/Invalid identifier/);
  });

  it("writes state atomically, leaving no temp files behind", async () => {
    const { manager, storage } = makeManager();
    await manager.acquire("sess-1");
    await manager.persist("sess-1");

    const entries = await fs.readdir(storage.sessionDir("sess-1"));
    expect(entries).toEqual(["state.json"]);
    expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
  });
});
