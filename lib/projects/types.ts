/**
 * projects/types.ts — Type definitions for the projects module.
 */

// ---------------------------------------------------------------------------
// Per-level worker model — each level gets its own slot array
// ---------------------------------------------------------------------------

/** Slot state. Level is structural (implied by position in the levels map). */
export type SlotState = {
  active: boolean;
  issueId: string | null;
  sessionKey: string | null;
  startTime: string | null;
  previousLabel?: string | null;
  /** Deterministic fun name for this slot (e.g. "Ada", "Grace"). */
  name?: string;
};

/** Per-level worker state: levels map instead of flat slots array. */
export type RoleWorkerState = {
  levels: Record<string, SlotState[]>;
};

/**
 * Channel registration: maps a channelId to messaging endpoint with event filters.
 */
export type Channel = {
  channelId: string;
  channel: "telegram" | "whatsapp" | "discord" | "slack";
  name: string; // e.g. "primary", "dev-chat"
  events: string[]; // e.g. ["*"] for all, ["workerComplete"] for filtered
  accountId?: string; // Optional account ID for multi-account setups
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
  /** Worker state per role (developer, tester, architect, or custom roles). Shared across all channels. */
  workers: Record<string, RoleWorkerState>;
};

/**
 * Legacy Project format (channelId-keyed). Used only during migration.
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
  workers: Record<string, RoleWorkerState>;
};

export type ProjectsData = {
  projects: Record<string, Project>; // Keyed by slug (new schema)
};
