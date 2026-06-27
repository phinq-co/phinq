import { createHash } from "node:crypto";
import type { SessionCounts } from "./classifier.js";

/** Rolling-window sizes (minutes) for velocity triggers. */
export interface SessionWindows {
  /** Window for send/delete velocity (EXTERNAL_COMM_VOLUME, BULK_DELETE). */
  windowMinutes: number;
  /** Window for the AFTER_ERROR_BULK "recent error" flag. */
  errorWindowMinutes: number;
}

export const DEFAULT_WINDOWS: SessionWindows = {
  windowMinutes: 60,
  errorWindowMinutes: 10,
};

type EventKind = "send" | "delete" | "error";

/**
 * In-memory rolling-window counters, keyed by session. The proxy persists these
 * in SQLite; in-process we keep them in a Map — an agent run is short-lived and
 * a process restart resetting velocity counts is acceptable (and safe: it can
 * only forget past activity, never invent it).
 *
 * `counts()` returns the window state BEFORE the current call, matching the
 * classifier's contract (thresholds compare against prior activity).
 */
export class MemorySessionStore {
  private readonly events = new Map<string, { kind: EventKind; ts: number }[]>();

  constructor(private readonly windows: SessionWindows = DEFAULT_WINDOWS) {}

  record(key: string, kind: EventKind, now: number = Date.now()): void {
    const list = this.events.get(key) ?? [];
    list.push({ kind, ts: now });
    this.events.set(key, list);
    this.prune(key, now);
  }

  counts(key: string, now: number = Date.now()): SessionCounts {
    this.prune(key, now);
    const list = this.events.get(key) ?? [];
    const windowStart = now - this.windows.windowMinutes * 60_000;
    const errorStart = now - this.windows.errorWindowMinutes * 60_000;
    let sends = 0;
    let deletes = 0;
    let recentError = false;
    for (const e of list) {
      if (e.kind === "send" && e.ts >= windowStart) sends++;
      else if (e.kind === "delete" && e.ts >= windowStart) deletes++;
      else if (e.kind === "error" && e.ts >= errorStart) recentError = true;
    }
    return { sends, deletes, recentError };
  }

  private prune(key: string, now: number): void {
    const longest = Math.max(this.windows.windowMinutes, this.windows.errorWindowMinutes);
    const cutoff = now - longest * 60_000;
    const list = this.events.get(key);
    if (!list) return;
    const kept = list.filter((e) => e.ts >= cutoff);
    if (kept.length) this.events.set(key, kept);
    else this.events.delete(key);
  }
}

/** Hash an opaque session identifier (e.g. an API key or agent id) — never store it raw. */
export function sessionKeyFrom(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex");
}
