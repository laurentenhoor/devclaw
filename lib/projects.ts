/**
 * Atomic projects.json read/write operations.
 * All state mutations go through this module to prevent corruption.
 *
 * Uses file-level locking to prevent concurrent read-modify-write races.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { migrateProject } from "./migrations.js";
import { ensureWorkspaceMigrated, DATA_DIR } from "./setup/migrate-layout.js";
import type { ExecutionMode } from "./workflow.js";

// ---------------------------------------------------------------------------
// File locking — prevents concurrent read-modify-write races
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

function lockPath(workspaceDir: string): string {
  return projectsPath(workspaceDir) + ".lock";
}

async function acquireLock(workspaceDir: string): Promise<void> {
  const lock = lockPath(workspaceDir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      // Check for stale lock
      try {
        const content = await fs.readFile(lock, "utf-8");
        const lockTime = Number(content);
        if (Date.now() - lockTime > LOCK_STALE_MS) {
          try { await fs.unlink(lock); } catch { /* race */ }
          continue;
        }
      } catch { /* lock disappeared — retry */ }

      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  // Last resort: force remove potentially stale lock
  try { await fs.unlink(lockPath(workspaceDir)); } catch { /* ignore */ }
  await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
}

async function releaseLock(workspaceDir: string): Promise<void> {
  try { await fs.unlink(lockPath(workspaceDir)); } catch { /* already removed */ }
}

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
  roleExecution?: ExecutionMode;
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
 * Uses file locking to prevent concurrent read-modify-write races.
 */
export async function updateWorker(
  workspaceDir: string,
  groupId: string,
  role: string,
  updates: Partial<WorkerState>,
): Promise<ProjectsData> {
  await acquireLock(workspaceDir);
  try {
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
  } finally {
    await releaseLock(workspaceDir);
  }
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
