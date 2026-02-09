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
  model: string | null;
  sessions: Record<string, string | null>;
};

export type Project = {
  name: string;
  repo: string;
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  autoChain: boolean;
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
 * Handles two migrations:
 * 1. Old sessionId field → sessions map (pre-sessions era)
 * 2. Model-alias session keys → tier-name keys (haiku→junior, sonnet→medior, etc.)
 */
function migrateWorkerState(worker: Record<string, unknown>): WorkerState {
  // Migration 1: old sessionId field → sessions map
  if (!worker.sessions || typeof worker.sessions !== "object") {
    const sessionId = worker.sessionId as string | null;
    const model = worker.model as string | null;
    const sessions: Record<string, string | null> = {};

    if (sessionId && model) {
      // Apply tier migration to the model key too
      const tierKey = TIER_MIGRATION[model] ?? model;
      sessions[tierKey] = sessionId;
    }

    return {
      active: worker.active as boolean,
      issueId: worker.issueId as string | null,
      startTime: worker.startTime as string | null,
      model: model ? (TIER_MIGRATION[model] ?? model) : null,
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
    const model = worker.model as string | null;
    return {
      active: worker.active as boolean,
      issueId: worker.issueId as string | null,
      startTime: worker.startTime as string | null,
      model: model ? (TIER_MIGRATION[model] ?? model) : null,
      sessions: newSessions,
    };
  }

  return worker as unknown as WorkerState;
}

/**
 * Create a blank WorkerState with null sessions for given tier names.
 */
export function emptyWorkerState(tiers: string[]): WorkerState {
  const sessions: Record<string, string | null> = {};
  for (const tier of tiers) {
    sessions[tier] = null;
  }
  return {
    active: false,
    issueId: null,
    startTime: null,
    model: null,
    sessions,
  };
}

/**
 * Get session key for a specific tier from a worker's sessions map.
 */
export function getSessionForModel(
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

  // Migrate any old-schema or missing fields transparently
  for (const project of Object.values(data.projects)) {
    project.dev = project.dev
      ? migrateWorkerState(project.dev as unknown as Record<string, unknown>)
      : emptyWorkerState([]);
    project.qa = project.qa
      ? migrateWorkerState(project.qa as unknown as Record<string, unknown>)
      : emptyWorkerState([]);
    if (project.autoChain === undefined) {
      project.autoChain = false;
    }
  }

  return data;
}

export async function writeProjects(
  workspaceDir: string,
  data: ProjectsData,
): Promise<void> {
  const filePath = projectsPath(workspaceDir);
  // Write to temp file first, then rename for atomicity
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
 * This prevents accidentally nulling out fields that should be preserved.
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
  // Merge sessions maps if both exist
  if (updates.sessions && worker.sessions) {
    updates.sessions = { ...worker.sessions, ...updates.sessions };
  }
  project[role] = { ...worker, ...updates };

  await writeProjects(workspaceDir, data);
  return data;
}

/**
 * Mark a worker as active with a new task.
 * Sets active=true, issueId, model (tier). Stores session key in sessions[tier].
 */
export async function activateWorker(
  workspaceDir: string,
  groupId: string,
  role: "dev" | "qa",
  params: {
    issueId: string;
    model: string;
    sessionKey?: string;
    startTime?: string;
  },
): Promise<ProjectsData> {
  const updates: Partial<WorkerState> = {
    active: true,
    issueId: params.issueId,
    model: params.model,
  };
  // Store session key in the sessions map for this tier
  if (params.sessionKey !== undefined) {
    updates.sessions = { [params.model]: params.sessionKey };
  }
  if (params.startTime !== undefined) {
    updates.startTime = params.startTime;
  }
  return updateWorker(workspaceDir, groupId, role, updates);
}

/**
 * Mark a worker as inactive after task completion.
 * Clears issueId and active, PRESERVES sessions map, model, startTime for reuse.
 */
export async function deactivateWorker(
  workspaceDir: string,
  groupId: string,
  role: "dev" | "qa",
): Promise<ProjectsData> {
  return updateWorker(workspaceDir, groupId, role, {
    active: false,
    issueId: null,
  });
}

/**
 * Resolve repo path from projects.json repo field (handles ~/ expansion).
 * Uses os.homedir() for cross-platform home directory resolution.
 */
export function resolveRepoPath(repoField: string): string {
  if (repoField.startsWith("~/")) {
    return repoField.replace("~", homedir());
  }
  return repoField;
}
