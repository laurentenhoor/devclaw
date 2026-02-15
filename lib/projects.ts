/**
 * Atomic projects.json read/write operations.
 * All state mutations go through this module to prevent corruption.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { migrateProject } from "./migrations.js";
import { ensureWorkspaceMigrated, DATA_DIR } from "./setup/migrate-layout.js";

export type WorkerState = {
  active: boolean;
  issueId: string | null;
  startTime: string | null;
  level: string | null;
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
  /** Issue tracker provider type (github or gitlab). Auto-detected at registration, stored for reuse. */
  provider?: "github" | "gitlab";
  /** Project-level role execution: parallel (DEVELOPER+TESTER can run simultaneously) or sequential (only one role at a time). Default: parallel */
  roleExecution?: "parallel" | "sequential";
  maxDevWorkers?: number;
  maxQaWorkers?: number;
  /** Worker state per role (developer, tester, architect, or custom roles). */
  workers: Record<string, WorkerState>;
};

export type ProjectsData = {
  projects: Record<string, Project>;
};

/**
 * Create a blank WorkerState with null sessions for given level names.
 */
export function emptyWorkerState(levels: string[]): WorkerState {
  const sessions: Record<string, string | null> = {};
  for (const l of levels) {
    sessions[l] = null;
  }
  return {
    active: false,
    issueId: null,
    startTime: null,
    level: null,
    sessions,
  };
}

/**
 * Get session key for a specific level from a worker's sessions map.
 */
export function getSessionForLevel(
  worker: WorkerState,
  level: string,
): string | null {
  return worker.sessions[level] ?? null;
}

function projectsPath(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, "projects.json");
}

export async function readProjects(workspaceDir: string): Promise<ProjectsData> {
  await ensureWorkspaceMigrated(workspaceDir);
  const raw = await fs.readFile(projectsPath(workspaceDir), "utf-8");
  const data = JSON.parse(raw) as ProjectsData;

  for (const project of Object.values(data.projects)) {
    migrateProject(project);
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
  role: string,
): WorkerState {
  return project.workers[role] ?? emptyWorkerState([]);
}

/**
 * Update worker state for a project. Only provided fields are updated.
 * Sessions are merged (not replaced) when both existing and new sessions are present.
 */
export async function updateWorker(
  workspaceDir: string,
  groupId: string,
  role: string,
  updates: Partial<WorkerState>,
): Promise<ProjectsData> {
  const data = await readProjects(workspaceDir);
  const project = data.projects[groupId];
  if (!project) {
    throw new Error(`Project not found for groupId: ${groupId}`);
  }

  const worker = project.workers[role] ?? emptyWorkerState([]);

  if (updates.sessions && worker.sessions) {
    updates.sessions = { ...worker.sessions, ...updates.sessions };
  }

  project.workers[role] = { ...worker, ...updates };

  await writeProjects(workspaceDir, data);
  return data;
}

/**
 * Mark a worker as active with a new task.
 * Stores session key in sessions[level] when a new session is spawned.
 */
export async function activateWorker(
  workspaceDir: string,
  groupId: string,
  role: string,
  params: {
    issueId: string;
    level: string;
    sessionKey?: string;
    startTime?: string;
  },
): Promise<ProjectsData> {
  const updates: Partial<WorkerState> = {
    active: true,
    issueId: params.issueId,
    level: params.level,
  };
  if (params.sessionKey !== undefined) {
    updates.sessions = { [params.level]: params.sessionKey };
  }
  if (params.startTime !== undefined) {
    updates.startTime = params.startTime;
  }
  return updateWorker(workspaceDir, groupId, role, updates);
}

/**
 * Mark a worker as inactive after task completion.
 * Preserves sessions map and level for reuse via updateWorker's spread.
 * Clears startTime to prevent stale timestamps on inactive workers.
 */
export async function deactivateWorker(
  workspaceDir: string,
  groupId: string,
  role: string,
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
