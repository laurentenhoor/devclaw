/**
 * Atomic projects.json read/write operations.
 * All state mutations go through this module to prevent corruption.
 *
 * Uses file-level locking to prevent concurrent read-modify-write races.
 *
 * Schema: Project-first with channels array. Legacy groupId-keyed projects are
 * auto-migrated to the new schema on first read via schema-migration.ts.
 *
 * New schema:
 * {
 *   "projects": {
 *     "devclaw": {
 *       "slug": "devclaw",
 *       "repo": "~/git/devclaw",
 *       "repoRemote": "https://github.com/laurentenhoor/devclaw.git",
 *       "baseBranch": "main",
 *       "channels": [
 *         { "groupId": "-5176490302", "channel": "telegram", "name": "primary", "events": ["*"] }
 *       ],
 *       "workers": { ... }
 *     }
 *   }
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { migrateProject } from "./migrations.js";
import { ensureWorkspaceMigrated, DATA_DIR } from "./setup/migrate-layout.js";
import { isLegacySchema, migrateLegacySchema } from "./schema-migration.js";
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
  /** Label the issue had before being transitioned to the active (Doing/Testing) state. Used by health check to revert to the correct queue label. */
  previousLabel?: string | null;
  /** Number of tasks completed on the current session. Reset when session is cleared. */
  taskCount?: number;
};

/**
 * Channel registration: maps a groupId to messaging endpoint with event filters.
 */
export type Channel = {
  groupId: string;
  channel: "telegram" | "whatsapp" | "discord" | "slack";
  name: string; // e.g. "primary", "dev-chat"
  events: string[]; // e.g. ["*"] for all, ["workerComplete"] for filtered
};

/**
 * Project configuration in the new project-first schema.
 */
export type Project = {
  slug: string;
  name: string;
  repo: string;
  repoRemote?: string; // Git remote URL (e.g., https://github.com/.../repo.git)
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  /** Channels registered for this project (notification endpoints). */
  channels: Channel[];
  /** Issue tracker provider type (github or gitlab). Auto-detected at registration, stored for reuse. */
  provider?: "github" | "gitlab";
  /** Project-level role execution: parallel (DEVELOPER+TESTER can run simultaneously) or sequential (only one role at a time). Default: parallel */
  roleExecution?: ExecutionMode;
  maxDevWorkers?: number;
  maxQaWorkers?: number;
  /** Worker state per role (developer, tester, architect, or custom roles). Shared across all channels. */
  workers: Record<string, WorkerState>;
};

/**
 * Legacy Project format (groupId-keyed). Used only during migration.
 */
export type LegacyProject = {
  name: string;
  repo: string;
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  channel?: string;
  provider?: "github" | "gitlab";
  roleExecution?: ExecutionMode;
  maxDevWorkers?: number;
  maxQaWorkers?: number;
  workers: Record<string, WorkerState>;
};

export type ProjectsData = {
  projects: Record<string, Project>; // Keyed by slug (new schema)
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
  let data = JSON.parse(raw) as any;

  // Auto-migrate legacy schema to new schema
  if (isLegacySchema(data)) {
    data = await migrateLegacySchema(data);
    // Write migrated schema back to disk
    await writeProjects(workspaceDir, data as ProjectsData);
  }

  const typedData = data as ProjectsData;

  // Apply per-project migrations
  for (const project of Object.values(typedData.projects)) {
    migrateProject(project as any);
  }

  return typedData;
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

/**
 * Resolve a project by slug or groupId (for backward compatibility).
 * Returns the slug of the found project.
 */
export function resolveProjectSlug(
  data: ProjectsData,
  slugOrGroupId: string,
): string | undefined {
  // Direct lookup by slug
  if (data.projects[slugOrGroupId]) {
    return slugOrGroupId;
  }

  // Reverse lookup by groupId in channels
  for (const [slug, project] of Object.entries(data.projects)) {
    if (project.channels.some(ch => ch.groupId === slugOrGroupId)) {
      return slug;
    }
  }

  return undefined;
}

/**
 * Get a project by slug or groupId (dual-mode resolution).
 */
export function getProject(
  data: ProjectsData,
  slugOrGroupId: string,
): Project | undefined {
  const slug = resolveProjectSlug(data, slugOrGroupId);
  return slug ? data.projects[slug] : undefined;
}

export function getWorker(
  project: Project,
  role: string,
): WorkerState {
  return project.workers[role] ?? emptyWorkerState([]);
}

/**
 * Update worker state for a project. Accepts slug or groupId (dual-mode).
 * Only provided fields are updated.
 * Sessions are merged (not replaced) when both existing and new sessions are present.
 * Uses file locking to prevent concurrent read-modify-write races.
 */
export async function updateWorker(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
  updates: Partial<WorkerState>,
): Promise<ProjectsData> {
  await acquireLock(workspaceDir);
  try {
    const data = await readProjects(workspaceDir);
    const slug = resolveProjectSlug(data, slugOrGroupId);
    if (!slug) {
      throw new Error(`Project not found for slug or groupId: ${slugOrGroupId}`);
    }

    const project = data.projects[slug];
    if (!project) {
      throw new Error(`Project not found for slug: ${slug}`);
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
 * Stores previousLabel so health check can revert to the correct queue state.
 * Accepts slug or groupId (dual-mode).
 */
export async function activateWorker(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
  params: {
    issueId: string;
    level: string;
    sessionKey?: string;
    startTime?: string;
    /** Label the issue had before transitioning to the active state (e.g. "To Do", "To Improve"). */
    previousLabel?: string;
    /** Task count for context budget tracking. */
    taskCount?: number;
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
  if (params.previousLabel !== undefined) {
    updates.previousLabel = params.previousLabel;
  }
  if (params.taskCount !== undefined) {
    updates.taskCount = params.taskCount;
  }
  return updateWorker(workspaceDir, slugOrGroupId, role, updates);
}

/**
 * Mark a worker as inactive after task completion.
 * Preserves sessions map and level for reuse via updateWorker's spread.
 * Clears startTime to prevent stale state on inactive workers.
 * Accepts slug or groupId (dual-mode).
 */
export async function deactivateWorker(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
): Promise<ProjectsData> {
  return updateWorker(workspaceDir, slugOrGroupId, role, {
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
