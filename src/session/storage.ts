/**
 * Session-scoped persistent storage.
 *
 * Foundry hosted agents get a per-session `$HOME` that survives compute
 * deprovisioning: after 15 minutes idle the sandbox is torn down, and when the
 * same session ID is used again the platform provisions new compute and restores
 * the filesystem. Up to 20 GiB at 1 vCPU or larger, ~20% reserved for system use.
 * Sessions are permanently deleted after 30 days of inactivity.
 *
 * So anything written under `$HOME` here is durable across idle/resume without
 * a database. That is the whole point of the stateful-agent lesson.
 *
 * Layout:
 *   $HOME/sessions/<sessionId>/state.json     ledger + pending + metadata
 *   $HOME/sessions/<sessionId>/files/...      files via the /files API
 *   $HOME/conversations/<conversationId>.json message history
 *
 * Writes are atomic (temp file + rename) because a session can be deprovisioned
 * mid-request; a half-written state.json would lose a customer's ledger.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

/**
 * Bumped when the on-disk shape changes incompatibly.
 *
 * v2 added loan applications (`applications`, `pendingApplications`, `appSeq`) to
 * the serialised bank. Older state is refused rather than migrated — a wrong
 * ledger is worse than a clear error, and this is a workshop sandbox.
 */
export const STATE_SCHEMA_VERSION = 2;

/**
 * Root for persisted state. Foundry sets HOME to the persisted volume; locally
 * it falls back to a gitignored directory so behaviour matches without Azure.
 */
export function storageRoot(env: NodeJS.ProcessEnv = process.env): string {
  // 1. Explicit override always wins.
  const explicit = env.SESSION_STATE_DIR;
  if (explicit) return explicit;

  /*
   * 2. In a container, write beneath $HOME — that is the path Foundry mounts the
   *    persisted session volume at.
   *
   *    This used to be gated on FOUNDRY_AGENT_NAME being set, which was wrong: a
   *    container run with no environment fell through to process.cwd() = /app,
   *    which an unprivileged user cannot write. Observed as
   *    "EACCES: permission denied, mkdir '/app/.session-state'". The Docker
   *    marker is the honest signal, not an unrelated Foundry variable.
   */
  const home = env.HOME ?? env.USERPROFILE;
  if (home && isContainer(env)) return path.join(home, ".agent-state");

  // 3. Locally, keep it inside the project so it is easy to inspect and delete.
  return path.join(process.cwd(), ".session-state");
}

/**
 * Are we in a container? `/.dockerenv` is present in Docker images, and Foundry
 * always sets FOUNDRY_AGENT_NAME. Either is sufficient.
 */
function isContainer(env: NodeJS.ProcessEnv): boolean {
  if (env.FOUNDRY_AGENT_NAME) return true;
  if (env.RUNNING_IN_CONTAINER === "1") return true;
  try {
    return fsSync.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

export interface PersistedFileEntry {
  name: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
}

export class SessionStorage {
  constructor(private root: string = storageRoot()) {}

  get rootDir(): string {
    return this.root;
  }

  sessionDir(sessionId: string): string {
    return path.join(this.root, "sessions", safeSegment(sessionId));
  }

  sessionFilesDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "files");
  }

  private statePath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "state.json");
  }

  private conversationPath(conversationId: string): string {
    return path.join(this.root, "conversations", `${safeSegment(conversationId)}.json`);
  }

  /* ----------------------------------------------------------- session state */

  async readState<T>(sessionId: string): Promise<T | undefined> {
    return this.readJson<T>(this.statePath(sessionId));
  }

  async writeState(sessionId: string, state: unknown): Promise<void> {
    await this.writeJson(this.statePath(sessionId), state);
  }

  /* ------------------------------------------------------------ conversation */

  async readConversation<T>(conversationId: string): Promise<T | undefined> {
    return this.readJson<T>(this.conversationPath(conversationId));
  }

  async writeConversation(conversationId: string, value: unknown): Promise<void> {
    await this.writeJson(this.conversationPath(conversationId), value);
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    return this.removeQuietly(this.conversationPath(conversationId));
  }

  async listConversationIds(): Promise<string[]> {
    const dir = path.join(this.root, "conversations");
    try {
      const entries = await fs.readdir(dir);
      return entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -5));
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------------ sessions */

  async listSessionIds(): Promise<string[]> {
    const dir = path.join(this.root, "sessions");
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const dir = this.sessionDir(sessionId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /* --------------------------------------------------------------- file API */

  /**
   * Resolves a caller-supplied path inside a session's files directory.
   * Rejects traversal — the path must stay under the session root, or one
   * session could read another's files (or the agent's own state.json).
   */
  resolveFilePath(sessionId: string, requested: string): string {
    const base = this.sessionFilesDir(sessionId);
    const normalised = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    const resolved = path.resolve(base, normalised);
    const relative = path.relative(base, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes the session directory: ${requested}`);
    }
    return resolved;
  }

  async writeFile(sessionId: string, requested: string, data: Buffer): Promise<void> {
    const target = this.resolveFilePath(sessionId, requested);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.atomicWrite(target, data);
  }

  async readFile(sessionId: string, requested: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(this.resolveFilePath(sessionId, requested));
    } catch {
      return undefined;
    }
  }

  async deleteFile(sessionId: string, requested: string): Promise<boolean> {
    return this.removeQuietly(this.resolveFilePath(sessionId, requested));
  }

  async listFiles(sessionId: string, requested = "."): Promise<PersistedFileEntry[]> {
    const dir = this.resolveFilePath(sessionId, requested);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const detailed = await Promise.all(
        entries.map(async (entry) => {
          const stat = await fs.stat(path.join(dir, entry.name));
          return {
            name: entry.name,
            size: stat.size,
            isDirectory: entry.isDirectory(),
            modifiedAt: stat.mtime.toISOString(),
          };
        }),
      );
      return detailed.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /** Total bytes used by a session — for the 20 GiB budget display. */
  async sessionSizeBytes(sessionId: string): Promise<number> {
    return this.dirSize(this.sessionDir(sessionId));
  }

  /* ---------------------------------------------------------------- internals */

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      const raw = await fs.readFile(file, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return undefined;
      // Corrupt JSON is worth surfacing rather than silently resetting a ledger.
      if (error instanceof SyntaxError) {
        throw new Error(`Corrupt state file at ${file}: ${error.message}`);
      }
      throw error;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await this.atomicWrite(file, Buffer.from(JSON.stringify(value, null, 2), "utf8"));
  }

  /**
   * Temp file + rename. A session can be deprovisioned mid-write, and rename is
   * atomic on the same filesystem, so a reader never sees a partial file.
   */
  private async atomicWrite(file: string, data: Buffer): Promise<void> {
    const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(temp, data);
    try {
      await fs.rename(temp, file);
    } catch (error) {
      await this.removeQuietly(temp);
      throw error;
    }
  }

  private async removeQuietly(file: string): Promise<boolean> {
    try {
      await fs.rm(file, { force: true, recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await this.dirSize(full);
        else total += (await fs.stat(full)).size;
      }
    } catch {
      /* missing directory counts as zero */
    }
    return total;
  }
}

/** Session and conversation IDs come from callers; keep them filesystem-safe. */
function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`Invalid identifier: ${JSON.stringify(id)}`);
  }
  return cleaned.slice(0, 128);
}
