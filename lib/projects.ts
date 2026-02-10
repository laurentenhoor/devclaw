/**
 * Atomic projects.json read/write operations.
 * All state mutations go through this module to prevent corruption.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { TIER_MIGRATION } from "./tiers.js";

export type WorkerState = {
  active: boolean;
  issueId: string | null;
  startTime: string | null;
  tier: string | null;
  sessions: Record<string, string | null>;
};

export type Project = {
  name: string;
  repo: string;
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  /** Messaging channel for this project's group (e.g. "telegram", "whatsapp", "discord", "slack"). Stored at registration time. */
  channel?: string;
  /** Project-level role execution: parallel (DEV+QA can run simultaneously) or sequential (only one role at a time). Default: parallel */
  roleExecution?: "parallel" | "sequential";
  maxDevWorkers?: number;
  maxQaWorkers?: number;
  dev: WorkerState;
  qa: WorkerState;
};

export type ProjectsData = {
  projects: Record<string, Project>;
};

/**
 * Migrate old WorkerState schema to current format.
 *
 * Handles three migrations:
 * 1. Old sessionId field → sessions map (pre-sessions era)
 * 2. Model-alias session keys → tier-name keys (haiku→junior, sonnet→medior, etc.)
 * 3. Old "model" field name → "tier" field name
 */
function migrateWorkerState(worker: Record<string, unknown>): WorkerState {
  // Read tier from either "tier" (new) or "model" (old) field
  const rawTier = (worker.tier ?? worker.model) as string | null;

  // Migration 1: old sessionId field → sessions map
  if (!worker.sessions || typeof worker.sessions !== "object") {
    const sessionId = worker.sessionId as string | null;
    const sessions: Record<string, string | null> = {};

    if (sessionId && rawTier) {
      const tierKey = TIER_MIGRATION[rawTier] ?? rawTier;
      sessions[tierKey] = sessionId;
    }

    return {
      active: worker.active as boolean,
      issueId: worker.issueId as string | null,
      startTime: worker.startTime as string | null,
      tier: rawTier ? (TIER_MIGRATION[rawTier] ?? rawTier) : null,
      sessions,
    };
  }

  // Migration 2: model-alias session keys → tier-name keys
  const oldSessions = worker.sessions as Record<string, string | null>;
  const needsMigration = Object.keys(oldSessions).some((key) => key in TIER_MIGRATION);

  if (needsMigration) {
    const newSessions: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(oldSessions)) {
      const newKey = TIER_MIGRATION[key] ?? key;
      newSessions[newKey] = value;
    }
    return {
      active: worker.active as boolean,
      issueId: worker.issueId as string | null,
      startTime: worker.startTime as string | null,
      tier: rawTier ? (TIER_MIGRATION[rawTier] ?? rawTier) : null,
      sessions: newSessions,
    };
  }

  // Migration 3: "model" field → "tier" field (already handled by rawTier above)
  return {
    active: worker.active as boolean,
    issueId: worker.issueId as string | null,
    startTime: worker.startTime as string | null,
    tier: rawTier ? (TIER_MIGRATION[rawTier] ?? rawTier) : null,
    sessions: oldSessions,
  };
}

/**
 * Create a blank WorkerState with null sessions for given tier names.
 */
export function emptyWorkerState(tiers: string[]): WorkerState {
  const sessions: Record<string, string | null> = {};
  for (const t of tiers) {
    sessions[t] = null;
  }
  return {
    active: false,
    issueId: null,
    startTime: null,
    tier: null,
    sessions,
  };
}

/**
 * Get session key for a specific tier from a worker's sessions map.
 */
export function getSessionForTier(
  worker: WorkerState,
  tier: string,
): string | null {
  return worker.sessions[tier] ?? null;
}

function projectsPath(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", "projects.json");
}

export async function readProjects(workspaceDir: string): Promise<ProjectsData> {
  const raw = await fs.readFile(projectsPath(workspaceDir), "utf-8");
  const data = JSON.parse(raw) as ProjectsData;

  for (const project of Object.values(data.projects)) {
    project.dev = project.dev
      ? migrateWorkerState(project.dev as unknown as Record<string, unknown>)
      : emptyWorkerState([]);
    project.qa = project.qa
      ? migrateWorkerState(project.qa as unknown as Record<string, unknown>)
      : emptyWorkerState([]);
    if (!project.channel) {
      project.channel = "telegram";
    }
  }

  return data;
}

export async function writeProjects(
  workspaceDir: string,
  data: ProjectsData,
): Promise<void> {
  const filePath = projectsPath(workspaceDir);
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, filePath);
}

export function getProject(
  data: ProjectsData,
  groupId: string,
): Project | undefined {
  return data.projects[groupId];
}

export function getWorker(
  project: Project,
  role: "dev" | "qa",
): WorkerState {
  return project[role];
}

/**
 * Update worker state for a project. Only provided fields are updated.
 * Sessions are merged (not replaced) when both existing and new sessions are present.
 */
export async function updateWorker(
  workspaceDir: string,
  groupId: string,
  role: "dev" | "qa",
  updates: Partial<WorkerState>,
): Promise<ProjectsData> {
  const data = await readProjects(workspaceDir);
  const project = data.projects[groupId];
  if (!project) {
    throw new Error(`Project not found for groupId: ${groupId}`);
  }

  const worker = project[role];

  if (updates.sessions && worker.sessions) {
    updates.sessions = { ...worker.sessions, ...updates.sessions };
  }

  project[role] = { ...worker, ...updates };

  await writeProjects(workspaceDir, data);
  return data;
}

/**
 * Mark a worker as active with a new task.
 * Stores session key in sessions[tier] when a new session is spawned.
 */
export async function activateWorker(
  workspaceDir: string,
  groupId: string,
  role: "dev" | "qa",
  params: {
    issueId: string;
    tier: string;
    sessionKey?: string;
    startTime?: string;
  },
): Promise<ProjectsData> {
  const updates: Partial<WorkerState> = {
    active: true,
    issueId: params.issueId,
    tier: params.tier,
  };
  if (params.sessionKey !== undefined) {
    updates.sessions = { [params.tier]: params.sessionKey };
  }
  if (params.startTime !== undefined) {
    updates.startTime = params.startTime;
  }
  return updateWorker(workspaceDir, groupId, role, updates);
}

/**
 * Mark a worker as inactive after task completion.
 * Preserves sessions map and tier for reuse via updateWorker's spread.
 * Clears startTime to prevent stale timestamps on inactive workers.
 */
export async function deactivateWorker(
  workspaceDir: string,
  groupId: string,
  role: "dev" | "qa",
): Promise<ProjectsData> {
  return updateWorker(workspaceDir, groupId, role, {
    active: false,
    issueId: null,
    startTime: null,
  });
}

/**
 * Resolve repo path from projects.json repo field (handles ~/ expansion).
 */
export function resolveRepoPath(repoField: string): string {
  if (repoField.startsWith("~/")) {
    return repoField.replace("~", homedir());
  }
  return repoField;
}
