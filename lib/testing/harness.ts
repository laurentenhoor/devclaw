/**
 * Test harness — scaffolds a temporary workspace with projects.json,
 * installs a mock runCommand, and provides helpers for E2E pipeline tests.
 *
 * Usage:
 *   const h = await createTestHarness({ ... });
 *   try { ... } finally { await h.cleanup(); }
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initRunCommand } from "../run-command.js";
import { writeProjects, type ProjectsData, type Project, type RoleWorkerState } from "../projects.js";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../workflow.js";
import { registerBootstrapHook } from "../bootstrap-hook.js";
import { TestProvider } from "./test-provider.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Bootstrap file type (mirrors OpenClaw's internal type)
// ---------------------------------------------------------------------------

export type BootstrapFile = {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
};

// ---------------------------------------------------------------------------
// Command interceptor
// ---------------------------------------------------------------------------

export type CapturedCommand = {
  argv: string[];
  opts: { timeoutMs: number; cwd?: string };
  /** Extracted from gateway `agent` call params, if applicable. */
  taskMessage?: string;
  /** Extracted from gateway `sessions.patch` params, if applicable. */
  sessionPatch?: { key: string; model: string };
};

export type CommandInterceptor = {
  /** All captured commands, in order. */
  commands: CapturedCommand[];
  /** Filter commands by first argv element. */
  commandsFor(cmd: string): CapturedCommand[];
  /** Get all task messages sent via `openclaw gateway call agent`. */
  taskMessages(): string[];
  /** Get all session patches. */
  sessionPatches(): Array<{ key: string; model: string }>;
  /** Reset captured commands. */
  reset(): void;
};

function createCommandInterceptor(): {
  interceptor: CommandInterceptor;
  handler: (argv: string[], opts: number | { timeoutMs: number; cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number | null; signal: null; killed: false }>;
} {
  const commands: CapturedCommand[] = [];

  const handler = async (
    argv: string[],
    optsOrTimeout: number | { timeoutMs: number; cwd?: string },
  ) => {
    const opts = typeof optsOrTimeout === "number"
      ? { timeoutMs: optsOrTimeout }
      : optsOrTimeout;

    const captured: CapturedCommand = { argv, opts };

    // Parse gateway agent calls to extract task message
    if (argv[0] === "openclaw" && argv[1] === "gateway" && argv[2] === "call") {
      const rpcMethod = argv[3];
      const paramsIdx = argv.indexOf("--params");
      if (paramsIdx !== -1 && argv[paramsIdx + 1]) {
        try {
          const params = JSON.parse(argv[paramsIdx + 1]);
          if (rpcMethod === "agent" && params.message) {
            captured.taskMessage = params.message;
          }
          if (rpcMethod === "sessions.patch") {
            captured.sessionPatch = { key: params.key, model: params.model };
          }
        } catch { /* ignore parse errors */ }
      }
    }

    commands.push(captured);

    return { stdout: "{}", stderr: "", code: 0, signal: null as null, killed: false as const };
  };

  const interceptor: CommandInterceptor = {
    commands,
    commandsFor(cmd: string) {
      return commands.filter((c) => c.argv[0] === cmd);
    },
    taskMessages() {
      return commands
        .filter((c) => c.taskMessage !== undefined)
        .map((c) => c.taskMessage!);
    },
    sessionPatches() {
      return commands
        .filter((c) => c.sessionPatch !== undefined)
        .map((c) => c.sessionPatch!);
    },
    reset() {
      commands.length = 0;
    },
  };

  return { interceptor, handler };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

export type TestHarness = {
  /** Temporary workspace directory. */
  workspaceDir: string;
  /** In-memory issue provider. */
  provider: TestProvider;
  /** Command interceptor — captures all runCommand calls. */
  commands: CommandInterceptor;
  /** The project group ID used for test data. */
  groupId: string;
  /** The project data. */
  project: Project;
  /** Workflow config. */
  workflow: WorkflowConfig;
  /** Write updated projects data to disk. */
  writeProjects(data: ProjectsData): Promise<void>;
  /** Read current projects data from disk. */
  readProjects(): Promise<ProjectsData>;
  /**
   * Write a role prompt file to the workspace.
   * @param role - Role name (e.g. "developer", "tester")
   * @param content - Prompt file content
   * @param projectName - If provided, writes project-specific prompt; otherwise writes default.
   */
  writePrompt(role: string, content: string, projectName?: string): Promise<void>;
  /**
   * Simulate the agent:bootstrap hook firing for a session key.
   * Registers the real hook with a mock API, fires it, returns the injected bootstrap files.
   * This tests the full hook chain: session key → parse → load instructions → inject.
   */
  simulateBootstrap(sessionKey: string): Promise<BootstrapFile[]>;
  /** Clean up temp directory. */
  cleanup(): Promise<void>;
};

export type HarnessOptions = {
  /** Project name (default: "test-project"). */
  projectName?: string;
  /** Group ID (default: "-1234567890"). */
  groupId?: string;
  /** Repo path (default: "/tmp/test-repo"). */
  repo?: string;
  /** Base branch (default: "main"). */
  baseBranch?: string;
  /** Workflow config (default: DEFAULT_WORKFLOW). */
  workflow?: WorkflowConfig;
  /** Initial worker state overrides (level + slot fields). */
  workers?: Record<string, { level?: string; active?: boolean; issueId?: string | null; sessionKey?: string | null; startTime?: string | null; previousLabel?: string | null }>;
  /** Additional projects to seed. */
  extraProjects?: Record<string, Project>;
};

export async function createTestHarness(opts?: HarnessOptions): Promise<TestHarness> {
  const {
    projectName = "test-project",
    groupId = "-1234567890",
    repo = "/tmp/test-repo",
    baseBranch = "main",
    workflow = DEFAULT_WORKFLOW,
    workers: workerOverrides,
    extraProjects,
  } = opts ?? {};

  // Create temp workspace
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-e2e-"));
  const dataDir = path.join(workspaceDir, "devclaw");
  const logDir = path.join(dataDir, "log");
  await fs.mkdir(logDir, { recursive: true });

  // Build project — empty per-level workers
  const emptyRW = (): RoleWorkerState => ({ levels: {} });
  const defaultWorkers: Record<string, RoleWorkerState> = {
    developer: emptyRW(),
    tester: emptyRW(),
    architect: emptyRW(),
    reviewer: emptyRW(),
  };

  // Apply worker overrides: places override into levels[level][0]
  if (workerOverrides) {
    for (const [role, overrides] of Object.entries(workerOverrides)) {
      const level = overrides.level ?? "senior";
      const rw = defaultWorkers[role] ?? emptyRW();
      rw.levels[level] = [{
        active: overrides.active ?? false,
        issueId: overrides.issueId ?? null,
        sessionKey: overrides.sessionKey ?? null,
        startTime: overrides.startTime ?? null,
        previousLabel: overrides.previousLabel ?? null,
      }];
      defaultWorkers[role] = rw;
    }
  }

  const project: Project = {
    slug: projectName,
    name: projectName,
    repo,
    groupName: "Test Group",
    deployUrl: "",
    baseBranch,
    deployBranch: baseBranch,
    channels: [{ groupId, channel: "telegram", name: "primary", events: ["*"] }],
    provider: "github",
    workers: defaultWorkers,
  };

  const projectsData: ProjectsData = {
    projects: {
      [projectName]: project,  // New schema: keyed by slug (projectName), not groupId
      ...extraProjects,
    },
  };

  await writeProjects(workspaceDir, projectsData);

  // Install mock runCommand
  const { interceptor, handler } = createCommandInterceptor();
  initRunCommand({
    runtime: {
      system: { runCommandWithTimeout: handler },
    },
  } as unknown as OpenClawPluginApi);

  // Create test provider
  const provider = new TestProvider({ workflow });

  return {
    workspaceDir,
    provider,
    commands: interceptor,
    groupId,
    project,
    workflow,
    async writeProjects(data: ProjectsData) {
      await writeProjects(workspaceDir, data);
    },
    async readProjects() {
      const { readProjects } = await import("../projects.js");
      return readProjects(workspaceDir);
    },
    async writePrompt(role: string, content: string, forProject?: string) {
      const dir = forProject
        ? path.join(dataDir, "projects", forProject, "prompts")
        : path.join(dataDir, "prompts");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${role}.md`), content, "utf-8");
    },
    async simulateBootstrap(sessionKey: string) {
      // Capture the hook callback by mocking api.registerHook
      let hookCallback: ((event: any) => Promise<void>) | null = null;
      const mockApi = {
        registerHook(_name: string, cb: (event: any) => Promise<void>) {
          hookCallback = cb;
        },
        logger: {
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
      } as unknown as OpenClawPluginApi;

      registerBootstrapHook(mockApi);
      if (!hookCallback) throw new Error("registerBootstrapHook did not register a callback");

      // Build a bootstrap event matching what OpenClaw sends
      const bootstrapFiles: BootstrapFile[] = [];
      await hookCallback({
        sessionKey,
        context: {
          workspaceDir,
          bootstrapFiles,
        },
      });

      return bootstrapFiles;
    },
    async cleanup() {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}
