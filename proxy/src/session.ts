import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Session state for velocity/volume triggers (PROXY-MVP.md §3).
 *
 * "Session" at the proxy layer is an approximation: the client API key over a
 * rolling window (default 60 min). There is no true agent-session identity in
 * the HTTP traffic, so velocity triggers inherit that imprecision — stated
 * plainly in the README.
 *
 * The key itself is never stored: session_key = sha256(authorization header).
 * Persisted in SQLite so counts survive proxy restarts mid-window.
 */

export interface SessionWindows {
  /** Rolling window for send/delete counts, minutes. Default 60. */
  windowMinutes: number;
  /** AFTER_ERROR_BULK lookback, minutes. Default 10. */
  errorWindowMinutes: number;
}

export const DEFAULT_WINDOWS: SessionWindows = {
  windowMinutes: 60,
  errorWindowMinutes: 10,
};

export type SessionEventKind = "send" | "delete" | "error";

export function sessionKeyFromAuth(authHeader: string | undefined): string {
  return createHash("sha256")
    .update(authHeader ?? "anonymous")
    .digest("hex");
}

export class SessionStore {
  private db: DatabaseSync;

  constructor(
    path: string, // ":memory:" or a file path
    private readonly windows: SessionWindows = DEFAULT_WINDOWS
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        session_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_events
        ON session_events (session_key, kind, ts);
    `);
  }

  record(sessionKey: string, kind: SessionEventKind, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO session_events (session_key, kind, ts) VALUES (?, ?, ?)")
      .run(sessionKey, kind, now);
  }

  /** Counts within the rolling windows, excluding nothing — callers add the
   *  in-flight call themselves (the classifier takes "counts before this call"). */
  counts(sessionKey: string, now = Date.now()): { sends: number; deletes: number; recentError: boolean } {
    const since = now - this.windows.windowMinutes * 60_000;
    const errorSince = now - this.windows.errorWindowMinutes * 60_000;
    const count = (kind: string, after: number): number => {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_events WHERE session_key = ? AND kind = ? AND ts > ?"
        )
        .get(sessionKey, kind, after) as { n: number };
      return row.n;
    };
    return {
      sends: count("send", since),
      deletes: count("delete", since),
      recentError: count("error", errorSince) > 0,
    };
  }

  /** Drop events older than the longest window — called opportunistically. */
  prune(now = Date.now()): void {
    const horizon =
      now - Math.max(this.windows.windowMinutes, this.windows.errorWindowMinutes) * 60_000;
    this.db.prepare("DELETE FROM session_events WHERE ts <= ?").run(horizon);
  }

  close(): void {
    this.db.close();
  }
}
