/**
 * Atomic projects.json read/write operations.
 * All state mutations go through this module to prevent corruption.
 */
import fs from "node:fs/promises";
import path from "node:path";

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
  dev: WorkerState;
  qa: WorkerState;
};

export type ProjectsData = {
  projects: Record<string, Project>;
};

/**
 * Migrate old WorkerState schema (sessionId field) to new sessions map.
 * Called transparently on read — old data is converted in memory,
 * persisted on next write.
 */
function migrateWorkerState(worker: Record<string, unknown>): WorkerState {
  // Already migrated — has sessions map
  if (worker.sessions && typeof worker.sessions === "object") {
    return worker as unknown as WorkerState;
  }

  // Old schema: { sessionId, model, ... }
  const sessionId = worker.sessionId as string | null;
  const model = worker.model as string | null;
  const sessions: Record<string, string | null> = {};

  if (sessionId && model) {
    sessions[model] = sessionId;
  }

  return {
    active: worker.active as boolean,
    issueId: worker.issueId as string | null,
    startTime: worker.startTime as string | null,
    model,
    sessions,
  };
}

/**
 * Create a blank WorkerState with null sessions for given model aliases.
 */
export function emptyWorkerState(aliases: string[]): WorkerState {
  const sessions: Record<string, string | null> = {};
  for (const alias of aliases) {
    sessions[alias] = null;
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
 * Get session key for a specific model alias from a worker's sessions map.
 */
export function getSessionForModel(
  worker: WorkerState,
  modelAlias: string,
): string | null {
  return worker.sessions[modelAlias] ?? null;
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
 * Sets active=true, issueId, model. Stores session key in sessions[model].
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
  // Store session key in the sessions map for this model
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
