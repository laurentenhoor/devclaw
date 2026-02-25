/**
 * schema-migration.ts — Schema migration from channelId-keyed to project-first.
 *
 * Handles detection and migration of legacy projects.json format to new schema.
 * Separated from projects.ts to keep core logic clean.
 */
import type { ProjectsData, Channel, LegacyProject, Project } from "./types.js";
import { resolveRepoPath } from "./io.js";
import type { RunCommand } from "../context.js";

/** Get first start time from a worker state (handles both old slots and new levels format). */
function getFirstStartTime(worker: any): string | undefined {
  if (!worker) return undefined;
  // New per-level format
  if (worker.levels) {
    for (const slots of Object.values(worker.levels)) {
      if (Array.isArray(slots) && slots.length > 0 && (slots[0] as any)?.startTime) {
        return (slots[0] as any).startTime;
      }
    }
  }
  // Old slot-based format
  return worker.slots?.[0]?.startTime ?? undefined;
}

/**
 * Detect if projects.json is in legacy format (keyed by numeric channelIds).
 */
export function isLegacySchema(data: any): boolean {
  const keys = Object.keys(data.projects || {});
  return keys.length > 0 && keys.every(k => /^-?\d+$/.test(k));
}

/**
 * Auto-populate repoRemote by reading git remote from the repo directory.
 */
export async function getRepoRemote(repoPath: string, runCommand?: RunCommand): Promise<string | undefined> {
  if (!runCommand) return undefined;
  const rc = runCommand;
  try {
    const resolved = resolveRepoPath(repoPath);
    const result = await rc(["git", "remote", "get-url", "origin"], {
      timeoutMs: 5_000,
      cwd: resolved,
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Migrate legacy channelId-keyed schema to project-first schema.
 *
 * Groups projects by name, merges their configurations, creates channels array,
 * and merges worker state (taking the most recent active worker).
 *
 * Example:
 *   Input: { "-5176490302": { name: "devclaw", ... }, "-1003843401024": { name: "devclaw", ... } }
 *   Output: { "devclaw": { slug: "devclaw", channels: [...], ... } }
 */
export async function migrateLegacySchema(data: any, runCommand?: RunCommand): Promise<ProjectsData> {
  const legacyProjects = data.projects as Record<string, LegacyProject>;
  const byName: Record<string, { channelIds: string[]; legacyProjects: LegacyProject[] }> = {};

  // Group by project name
  for (const [channelId, legacyProj] of Object.entries(legacyProjects)) {
    if (!byName[legacyProj.name]) {
      byName[legacyProj.name] = { channelIds: [], legacyProjects: [] };
    }
    byName[legacyProj.name].channelIds.push(channelId);
    byName[legacyProj.name].legacyProjects.push(legacyProj);
  }

  const newProjects: Record<string, Project> = {};

  // Convert each group to new schema
  for (const [projectName, { channelIds, legacyProjects: legacyList }] of Object.entries(byName)) {
    const slug = projectName.toLowerCase().replace(/\s+/g, "-");
    const firstProj = legacyList[0];
    const mostRecent = legacyList.reduce((a, b) => {
      const aTime = getFirstStartTime(a.workers?.developer);
      const bTime = getFirstStartTime(b.workers?.developer);
      return (aTime || "") > (bTime || "") ? a : b;
    });

    // Create channels: first channelId is "primary", rest are "secondary-{n}"
    const channels: Channel[] = channelIds.map((chId, idx) => ({
      channelId: chId,
      channel: (firstProj.channel ?? "telegram") as "telegram" | "whatsapp" | "discord" | "slack",
      name: idx === 0 ? "primary" : `secondary-${idx}`,
      events: ["*"],
    }));

    // Merge worker state: start with first, then overlay most recent
    const mergedWorkers = { ...firstProj.workers };
    if (mostRecent !== firstProj) {
      for (const [role, worker] of Object.entries(mostRecent.workers)) {
        const hasActive = Object.values((worker as any).levels ?? {}).some(
          (slots: any) => Array.isArray(slots) && slots.some((s: any) => s.active),
        ) || (worker as any).slots?.some((s: any) => s.active);
        if (hasActive) {
          mergedWorkers[role] = worker;
        }
      }
    }

    newProjects[slug] = {
      slug,
      name: projectName,
      repo: firstProj.repo,
      repoRemote: await getRepoRemote(firstProj.repo, runCommand),
      groupName: firstProj.groupName,
      deployUrl: firstProj.deployUrl,
      baseBranch: firstProj.baseBranch,
      deployBranch: firstProj.deployBranch,
      channels,
      provider: firstProj.provider,
      workers: mergedWorkers,
    };
  }

  return { projects: newProjects };
}
