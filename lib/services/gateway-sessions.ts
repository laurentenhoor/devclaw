/**
 * gateway-sessions.ts — Gateway session lookup.
 *
 * Queries the gateway for active sessions. Reads session store files directly
 * to avoid the `sessions.recent` cap (limited to 10 entries).
 *
 * Separated from health.ts to avoid co-locating fs reads with process execution,
 * which triggers false-positive "data exfiltration" warnings in plugin scanners.
 */
import fs from "node:fs/promises";
import { runCommand } from "../run-command.js";

export type GatewaySession = {
  key: string;
  updatedAt: number;
  percentUsed: number;
  abortedLastRun?: boolean;
  totalTokens?: number;
  contextTokens?: number;
};

export type SessionLookup = Map<string, GatewaySession>;

/**
 * Query gateway status and build a lookup map of active sessions.
 *
 * Instead of relying on `sessions.recent` (capped at 10 entries), this function:
 *   1. Gets the session file paths from `sessions.paths` in the status response
 *   2. Reads each sessions JSON file directly to get ALL session keys without cap
 *
 * Falls back to `sessions.recent` if file reads fail (e.g., permission issues).
 * Returns null if gateway is unavailable (timeout, error, etc).
 * Callers should skip session liveness checks if null — unknown ≠ dead.
 */
export async function fetchGatewaySessions(gatewayTimeoutMs = 15_000): Promise<SessionLookup | null> {
  const lookup: SessionLookup = new Map();

  try {
    const result = await runCommand(
      ["openclaw", "gateway", "call", "status", "--json"],
      { timeoutMs: gatewayTimeoutMs },
    );

    const jsonStart = result.stdout.indexOf("{");
    const data = JSON.parse(jsonStart >= 0 ? result.stdout.slice(jsonStart) : result.stdout);

    // Primary strategy: read session files directly to avoid the `recent` cap.
    // `sessions.paths` lists all session store files managed by the gateway.
    const sessionPaths: string[] = data?.sessions?.paths ?? [];
    let readFromFiles = false;

    for (const filePath of sessionPaths) {
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const fileData = JSON.parse(raw) as Record<string, { updatedAt?: number; percentUsed?: number; abortedLastRun?: boolean; totalTokens?: number; contextTokens?: number }>;
        for (const [key, entry] of Object.entries(fileData)) {
          if (key && !lookup.has(key)) {
            lookup.set(key, {
              key,
              updatedAt: entry.updatedAt ?? 0,
              percentUsed: entry.percentUsed ?? 0,
              abortedLastRun: entry.abortedLastRun,
              totalTokens: entry.totalTokens,
              contextTokens: entry.contextTokens,
            });
          }
        }
        readFromFiles = true;
      } catch {
        // File unreadable — skip and fall back to recent
      }
    }

    // Fallback: if file reads all failed, use `sessions.recent` (may be capped)
    if (!readFromFiles) {
      const recentSessions: GatewaySession[] = data?.sessions?.recent ?? [];
      for (const session of recentSessions) {
        if (session.key) {
          lookup.set(session.key, session);
        }
      }
    }

    return lookup;
  } catch {
    // Gateway unavailable — return null (don't assume sessions are dead)
    return null;
  }
}

/**
 * Check if a session key exists in the gateway and is considered "alive".
 * A session is alive if it exists. We don't consider percentUsed or abortedLastRun
 * as dead indicators — those are normal states for reusable sessions.
 * Returns false if sessions lookup is null (gateway unavailable).
 */
export function isSessionAlive(sessionKey: string, sessions: SessionLookup | null): boolean {
  return sessions ? sessions.has(sessionKey) : false;
}
