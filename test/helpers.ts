/**
 * helpers.ts — Shared utilities for DevClaw integration tests.
 *
 * Provides: gateway RPC wrapper, GitHub issue helpers, session verification,
 * mock context factories, and automatic test resource cleanup.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolContext } from "../lib/types.js";
import { type ProjectsData, writeProjects } from "../lib/projects.js";

const execFileAsync = promisify(execFile);

// ── Constants ───────────────────────────────────────────────────────────────

/** Prefix for all test session keys — used for cleanup sweeps */
export const TEST_SESSION_PREFIX = "agent:devclaw:subagent:test-";

/** Group ID used for the test project in projects.json.
 *  Uses the real DevClaw Telegram group so notifications are visible in the channel. */
export const TEST_GROUP_ID = "-5239235162";

/** Repo path for test issues (devclaw repo) */
export const TEST_REPO = "laurentenhoor/devclaw";

/** Project name used in test workspaces. Prefixed with "test-" so session keys
 *  (agent:devclaw:subagent:test-devclaw-dev-junior) don't collide with production
 *  and match TEST_SESSION_PREFIX for cleanup sweeps. */
export const TEST_PROJECT_NAME = "test-devclaw";

// ── Gateway RPC ─────────────────────────────────────────────────────────────

/**
 * Call an OpenClaw gateway method. Returns parsed JSON response.
 * Throws on gateway error or timeout.
 */
export async function gateway(
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    "openclaw",
    [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
    ],
    { timeout: 30_000 },
  );

  // openclaw may output plugin registration lines before JSON
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`No JSON in gateway response for ${method}: ${stdout}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

// ── Session helpers ─────────────────────────────────────────────────────────

/** Check if a session exists in the gateway */
export async function sessionExists(key: string): Promise<boolean> {
  try {
    const result = await gateway("sessions.list", {
      limit: 200,
      agentId: "devclaw",
    });
    const sessions = result.sessions as Array<{ key: string }>;
    return sessions.some((s) => s.key === key);
  } catch {
    return false;
  }
}

/** Get token count for a session (0 = never started) */
export async function getSessionTokens(
  key: string,
): Promise<number | null> {
  try {
    const result = await gateway("sessions.list", {
      limit: 200,
      agentId: "devclaw",
    });
    const sessions = result.sessions as Array<{
      key: string;
      totalTokens?: number;
    }>;
    const session = sessions.find((s) => s.key === key);
    return session ? (session.totalTokens ?? 0) : null;
  } catch {
    return null;
  }
}

// ── GitHub issue helpers ────────────────────────────────────────────────────

/** Get current labels on a GitHub issue */
export async function getIssueLabels(
  repo: string,
  issueId: number,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["issue", "view", String(issueId), "--repo", repo, "--json", "labels"],
    { timeout: 15_000 },
  );
  const data = JSON.parse(stdout) as { labels: Array<{ name: string }> };
  return data.labels.map((l) => l.name);
}

/** Get current state of a GitHub issue (OPEN/CLOSED) */
export async function getIssueState(
  repo: string,
  issueId: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "gh",
    ["issue", "view", String(issueId), "--repo", repo, "--json", "state"],
    { timeout: 15_000 },
  );
  const data = JSON.parse(stdout) as { state: string };
  return data.state;
}

/** Close a GitHub issue (best-effort) */
export async function closeIssue(
  repo: string,
  issueId: number,
): Promise<void> {
  try {
    await execFileAsync(
      "gh",
      ["issue", "close", String(issueId), "--repo", repo],
      { timeout: 15_000 },
    );
  } catch {
    // best-effort
  }
}

// ── Cleanup registry ────────────────────────────────────────────────────────

/**
 * Tracks all test resources (sessions + issues) for guaranteed cleanup.
 *
 * Usage:
 *   const cleanup = new TestCleanup();
 *   cleanup.trackSession("agent:devclaw:subagent:test-xxx");
 *   cleanup.trackIssue("laurentenhoor/devclaw", 42);
 *   await cleanup.cleanAll(); // in after() hook
 */
export class TestCleanup {
  private sessions = new Set<string>();
  private issues: Array<{ repo: string; id: number }> = [];

  trackSession(key: string): void {
    this.sessions.add(key);
  }

  trackIssue(repo: string, id: number): void {
    this.issues.push({ repo, id });
  }

  async cleanAll(): Promise<void> {
    // Delete tracked sessions
    for (const key of this.sessions) {
      try {
        await gateway("sessions.delete", {
          key,
          deleteTranscript: true,
        });
      } catch {
        // best-effort
      }
    }
    this.sessions.clear();

    // Close tracked issues
    for (const { repo, id } of this.issues) {
      await closeIssue(repo, id);
    }
    this.issues.length = 0;
  }
}

/**
 * Safety sweep: find and delete any test sessions from previous failed runs.
 * Scans sessions.list for keys matching TEST_SESSION_PREFIX.
 */
export async function sweepTestSessions(): Promise<number> {
  let cleaned = 0;
  try {
    const result = await gateway("sessions.list", {
      limit: 200,
      agentId: "devclaw",
    });
    const sessions = result.sessions as Array<{ key: string }>;
    for (const session of sessions) {
      if (session.key.startsWith(TEST_SESSION_PREFIX)) {
        try {
          await gateway("sessions.delete", {
            key: session.key,
            deleteTranscript: true,
          });
          cleaned++;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return cleaned;
}

// ── Mock factories ──────────────────────────────────────────────────────────

/**
 * Create a mock ToolContext simulating a group chat for the test project.
 */
export function makeTestContext(
  groupId: string,
  workspaceDir: string,
): ToolContext {
  return {
    config: {},
    workspaceDir,
    agentDir: "/tmp/devclaw-test-agent",
    agentId: "devclaw",
    sessionKey: `agent:devclaw:telegram:group:${groupId}`,
    messageChannel: "telegram",
    sandboxed: false,
  };
}

/**
 * Create a minimal mock OpenClawPluginApi for testing.
 * Only provides the fields tools actually use: pluginConfig, logger, resolvePath.
 */
export function makeTestApi(pluginConfig?: Record<string, unknown>): any {
  return {
    id: "devclaw",
    name: "DevClaw",
    source: "test",
    config: {},
    pluginConfig: pluginConfig ?? {
      devClawAgentIds: ["devclaw"],
      models: {
        junior: "anthropic/claude-haiku-4-5",
        medior: "anthropic/claude-sonnet-4-5",
        senior: "anthropic/claude-opus-4-5",
        qa: "anthropic/claude-sonnet-4-5",
      },
      projectExecution: "parallel",
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    runtime: {},
    registerTool: () => {},
    registerHook: () => {},
    registerHttpHandler: () => {},
    registerHttpRoute: () => {},
    registerChannel: () => {},
    registerGatewayMethod: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    resolvePath: (input: string) => input.replace("~", os.homedir()),
    on: () => {},
  };
}

// ── Workspace helpers ───────────────────────────────────────────────────────

/**
 * Create a temp workspace directory with initial projects.json and role files.
 * Returns the workspace path. Caller must clean up via fs.rm().
 */
export async function createTestWorkspace(opts?: {
  groupId?: string;
  autoChain?: boolean;
}): Promise<string> {
  const groupId = opts?.groupId ?? TEST_GROUP_ID;
  const autoChain = opts?.autoChain ?? false;

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "devclaw-scenario-test-"),
  );

  // Create required directories
  await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "roles", "default"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "roles", TEST_PROJECT_NAME), {
    recursive: true,
  });

  // Write initial projects.json
  const initialData: ProjectsData = {
    projects: {
      [groupId]: {
        name: TEST_PROJECT_NAME,
        repo: `~/.openclaw/extensions/devclaw`,
        groupName: "DevClaw - Test",
        deployUrl: "",
        baseBranch: "main",
        deployBranch: "main",
        autoChain,
        channel: "telegram",
        dev: {
          active: false,
          issueId: null,
          startTime: null,
          model: null,
          sessions: { junior: null, medior: null, senior: null },
        },
        qa: {
          active: false,
          issueId: null,
          startTime: null,
          model: null,
          sessions: { qa: null },
        },
      },
    },
  };
  await writeProjects(tempDir, initialData);

  // Write minimal role files
  await fs.writeFile(
    path.join(tempDir, "roles", "default", "dev.md"),
    "# DEV Worker Instructions\n\nThis is a test worker. Just acknowledge the task.\n",
  );
  await fs.writeFile(
    path.join(tempDir, "roles", "default", "qa.md"),
    "# QA Worker Instructions\n\nThis is a test QA worker. Just acknowledge the task.\n",
  );

  return tempDir;
}

// ── Result parser ───────────────────────────────────────────────────────────

/**
 * Parse the result from a tool's execute() call.
 * Tools return jsonResult() which wraps the payload in AgentToolResult format.
 */
export function parseToolResult(result: unknown): Record<string, unknown> {
  // jsonResult returns [{ type: "text", text: JSON.stringify(payload) }]
  // or { content: [{ type: "text", text: "..." }] }
  if (Array.isArray(result)) {
    const first = result[0];
    if (first && typeof first === "object" && "text" in first) {
      return JSON.parse(first.text as string);
    }
  }
  if (
    result &&
    typeof result === "object" &&
    "content" in result
  ) {
    const content = (result as any).content;
    if (Array.isArray(content) && content[0]?.text) {
      return JSON.parse(content[0].text);
    }
  }
  throw new Error(`Cannot parse tool result: ${JSON.stringify(result)}`);
}
