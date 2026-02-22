/**
 * schema-migration.ts — Schema migration from groupId-keyed to project-first.
 *
 * Handles detection and migration of legacy projects.json format to new schema.
 * Separated from projects.ts to keep core logic clean.
 */
import type { ProjectsData, Channel, LegacyProject, WorkerState } from "./projects.js";
import { resolveRepoPath } from "./projects.js";
import { runCommand } from "./run-command.js";

/**
 * Detect if projects.json is in legacy format (keyed by numeric groupIds).
 */
export function isLegacySchema(data: any): boolean {
  const keys = Object.keys(data.projects || {});
  return keys.length > 0 && keys.every(k => /^-?\d+$/.test(k));
}

/**
 * Auto-populate repoRemote by reading git remote from the repo directory.
 */
export async function getRepoRemote(repoPath: string): Promise<string | undefined> {
  try {
    const resolved = resolveRepoPath(repoPath);
    const result = await runCommand(["git", "remote", "get-url", "origin"], {
      timeoutMs: 5_000,
      cwd: resolved,
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Migrate legacy groupId-keyed schema to project-first schema.
 *
 * Groups projects by name, merges their configurations, creates channels array,
 * and merges worker state (taking the most recent active worker).
 *
 * Example:
 *   Input: { "-5176490302": { name: "devclaw", ... }, "-1003843401024": { name: "devclaw", ... } }
 *   Output: { "devclaw": { slug: "devclaw", channels: [...], ... } }
 */
export async function migrateLegacySchema(data: any): Promise<ProjectsData> {
  const legacyProjects = data.projects as Record<string, LegacyProject>;
  const byName: Record<string, { groupIds: string[]; legacyProjects: LegacyProject[] }> = {};

  // Group by project name
  for (const [groupId, legacyProj] of Object.entries(legacyProjects)) {
    if (!byName[legacyProj.name]) {
      byName[legacyProj.name] = { groupIds: [], legacyProjects: [] };
    }
    byName[legacyProj.name].groupIds.push(groupId);
    byName[legacyProj.name].legacyProjects.push(legacyProj);
  }

  const newProjects: Record<string, import("./projects.js").Project> = {};

  // Convert each group to new schema
  for (const [projectName, { groupIds, legacyProjects: legacyList }] of Object.entries(byName)) {
    const slug = projectName.toLowerCase().replace(/\s+/g, "-");
    const firstProj = legacyList[0];
    const mostRecent = legacyList.reduce((a, b) =>
      (a.workers?.developer?.slots?.[0]?.startTime || "") > (b.workers?.developer?.slots?.[0]?.startTime || "") ? a : b
    );

    // Create channels: first groupId is "primary", rest are "secondary-{n}"
    const channels: Channel[] = groupIds.map((gId, idx) => ({
      groupId: gId,
      channel: (firstProj.channel ?? "telegram") as "telegram" | "whatsapp" | "discord" | "slack",
      name: idx === 0 ? "primary" : `secondary-${idx}`,
      events: ["*"],
    }));

    // Merge worker state: start with first, then overlay most recent
    const mergedWorkers = { ...firstProj.workers };
    if (mostRecent !== firstProj) {
      for (const [role, worker] of Object.entries(mostRecent.workers)) {
        if (worker.slots?.some(s => s.active)) {
          mergedWorkers[role] = worker;
        }
      }
    }

    newProjects[slug] = {
      slug,
      name: projectName,
      repo: firstProj.repo,
      repoRemote: await getRepoRemote(firstProj.repo),
      groupName: firstProj.groupName,
      deployUrl: firstProj.deployUrl,
      baseBranch: firstProj.baseBranch,
      deployBranch: firstProj.deployBranch,
      channels,
      provider: firstProj.provider,
      roleExecution: firstProj.roleExecution,
      maxDevWorkers: firstProj.maxDevWorkers,
      maxQaWorkers: firstProj.maxQaWorkers,
      workers: mergedWorkers,
    };
  }

  return { projects: newProjects };
}
