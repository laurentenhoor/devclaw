/**
 * bootstrap-hook.ts — Agent bootstrap hook for injecting role instructions.
 *
 * Registers an `agent:bootstrap` hook that intercepts DevClaw worker session
 * startup and injects role-specific instructions as a virtual workspace file.
 *
 * This eliminates the file-read-network-send pattern in dispatch.ts that
 * triggered the security auditor's potential-exfiltration warning.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getSessionKeyRolePattern } from "./roles/index.js";
import { DATA_DIR } from "./setup/migrate-layout.js";

/**
 * Parse a DevClaw worker session key to extract project name and role.
 *
 * Session key format: `agent:{workerAgentId}:worker:{projectName}-{role}-{level}-{slotIndex}`
 * Legacy subagent: `agent:{agentId}:subagent:{projectName}-{role}-{level}-{slotIndex}`
 * Legacy (no slot): `agent:{agentId}:subagent:{projectName}-{role}-{level}`
 *
 * Examples:
 *   - `agent:devclaw-worker:worker:my-project-developer-medior-0` → { projectName: "my-project", role: "developer" }
 *   - `agent:devclaw:subagent:webapp-tester-medior-0`              → { projectName: "webapp", role: "tester" } (legacy)
 *
 * Note: projectName may contain hyphens, so we match role from the end.
 */
export function parseDevClawSessionKey(
  sessionKey: string,
): { projectName: string; role: string } | null {
  const rolePattern = getSessionKeyRolePattern();
  // Current format: agent:{id}:worker:{project}-{role}-{level}-{slot}
  const workerMatch = sessionKey.match(new RegExp(`:worker:(.+)-(${rolePattern})-[^-]+-\\d+$`));
  if (workerMatch) return { projectName: workerMatch[1], role: workerMatch[2] };
  // Legacy subagent format: agent:{id}:subagent:{project}-{role}-{level}-{slot}
  const subagentMatch = sessionKey.match(new RegExp(`:subagent:(.+)-(${rolePattern})-[^-]+-\\d+$`));
  if (subagentMatch) return { projectName: subagentMatch[1], role: subagentMatch[2] };
  // Legacy subagent format (no slot): agent:{id}:subagent:{project}-{role}-{level}
  const legacyMatch = sessionKey.match(new RegExp(`:subagent:(.+)-(${rolePattern})-[^-]+$`));
  if (legacyMatch) return { projectName: legacyMatch[1], role: legacyMatch[2] };
  return null;
}

/**
 * Extract the orchestrator agent ID from a worker session key.
 *
 * Worker keys: `agent:{orchestratorId}-worker:worker:...` → orchestratorId
 * Legacy subagent keys: `agent:{orchestratorId}:subagent:...` → orchestratorId
 */
function extractOrchestratorAgentId(sessionKey: string): string | null {
  // Worker agent format: agent:{id}-worker:worker:...
  const workerMatch = sessionKey.match(/^agent:(.+)-worker:worker:/);
  if (workerMatch) return workerMatch[1];
  // Legacy subagent format: agent:{id}:subagent:...
  const subagentMatch = sessionKey.match(/^agent:(.+):subagent:/);
  if (subagentMatch) return subagentMatch[1];
  return null;
}

/**
 * Resolve the orchestrator's workspace directory.
 *
 * Worker agents have their own workspace, but prompts live in the orchestrator's
 * workspace. This function looks up the orchestrator agent's workspace via config.
 * Falls back to the worker's own workspace if resolution fails (backward compat).
 */
function resolveOrchestratorWorkspace(
  api: OpenClawPluginApi,
  sessionKey: string,
  workerWorkspaceDir: string,
): string {
  const orchestratorId = extractOrchestratorAgentId(sessionKey);
  if (!orchestratorId) return workerWorkspaceDir;

  try {
    const config = api.runtime.config.loadConfig();
    const agent = config.agents?.list?.find(
      (a) => a.id === orchestratorId,
    );
    if (agent?.workspace) return agent.workspace;
  } catch {
    // Config lookup failed — fall back to worker workspace
  }

  return workerWorkspaceDir;
}

/**
 * Result of loading role instructions — includes the source for traceability.
 */
export type RoleInstructionsResult = {
  content: string;
  /** Which file the instructions were loaded from, or null if none found. */
  source: string | null;
};

/**
 * Load role-specific instructions from workspace.
 * Tries project-specific file first, then falls back to default.
 * Returns both the content and the source path for logging/traceability.
 *
 * Resolution order:
 *   1. devclaw/projects/<project>/prompts/<role>.md  (project-specific)
 *   2. projects/roles/<project>/<role>.md             (old project-specific)
 *   3. devclaw/prompts/<role>.md                      (workspace default)
 *   4. projects/roles/default/<role>.md               (old default)
 */
export async function loadRoleInstructions(
  workspaceDir: string,
  projectName: string,
  role: string,
): Promise<string>;
export async function loadRoleInstructions(
  workspaceDir: string,
  projectName: string,
  role: string,
  opts: { withSource: true },
): Promise<RoleInstructionsResult>;
export async function loadRoleInstructions(
  workspaceDir: string,
  projectName: string,
  role: string,
  opts?: { withSource: true },
): Promise<string | RoleInstructionsResult> {
  const dataDir = path.join(workspaceDir, DATA_DIR);

  const candidates = [
    path.join(dataDir, "projects", projectName, "prompts", `${role}.md`),
    path.join(workspaceDir, "projects", "roles", projectName, `${role}.md`),
    path.join(dataDir, "prompts", `${role}.md`),
    path.join(workspaceDir, "projects", "roles", "default", `${role}.md`),
  ];

  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      if (opts?.withSource) return { content, source: filePath };
      return content;
    } catch { /* not found, try next */ }
  }

  if (opts?.withSource) return { content: "", source: null };
  return "";
}

/**
 * Register the agent:bootstrap hook for DevClaw worker instruction injection.
 *
 * When a DevClaw worker session starts, this hook:
 * 1. Detects it's a DevClaw worker via session key pattern
 * 2. Extracts project name and role
 * 3. Loads role-specific instructions from the orchestrator's workspace
 * 4. Injects them as a virtual workspace file (WORKER_INSTRUCTIONS.md)
 *
 * OpenClaw automatically includes bootstrap files in the agent's system prompt,
 * so workers receive their instructions without any file-read in dispatch.ts.
 */
export function registerBootstrapHook(api: OpenClawPluginApi): void {
  api.registerHook("agent:bootstrap", async (event) => {
    const sessionKey = event.sessionKey;
    api.logger.debug(`Bootstrap hook fired: sessionKey=${sessionKey ?? "undefined"}, event keys=${Object.keys(event).join(",")}`);
    if (!sessionKey) return;

    const parsed = parseDevClawSessionKey(sessionKey);
    if (!parsed) {
      api.logger.debug(`Bootstrap hook: not a DevClaw session key: ${sessionKey}`);
      return;
    }

    const context = event.context as {
      workspaceDir?: string;
      bootstrapFiles?: Array<{
        name: string;
        path: string;
        content?: string;
        missing: boolean;
      }>;
    };

    const workerWorkspaceDir = context.workspaceDir;
    if (!workerWorkspaceDir || typeof workerWorkspaceDir !== "string") {
      api.logger.warn(`Bootstrap hook: no workspaceDir in context for ${sessionKey}`);
      return;
    }

    const bootstrapFiles = context.bootstrapFiles;
    if (!Array.isArray(bootstrapFiles)) {
      api.logger.warn(`Bootstrap hook: no bootstrapFiles array in context for ${sessionKey}`);
      return;
    }

    // Prompts live in the orchestrator's workspace, not the worker's
    const workspaceDir = resolveOrchestratorWorkspace(api, sessionKey, workerWorkspaceDir);

    const { content, source } = await loadRoleInstructions(
      workspaceDir,
      parsed.projectName,
      parsed.role,
      { withSource: true },
    );

    if (!content) {
      api.logger.warn(`Bootstrap hook: no content found for ${parsed.role} in project "${parsed.projectName}" (workspace: ${workspaceDir})`);
      return;
    }

    // Inject as a virtual bootstrap file. OpenClaw includes these in the
    // agent's system prompt automatically (via buildBootstrapContextFiles).
    bootstrapFiles.push({
      name: "WORKER_INSTRUCTIONS.md" as any,
      path: `<devclaw:${parsed.projectName}:${parsed.role}>`,
      content: content.trim(),
      missing: false,
    });

    api.logger.info(
      `Bootstrap hook: injected ${parsed.role} instructions for project "${parsed.projectName}" from ${source}`,
    );
  }, { name: "devclaw-worker-instructions", description: "Injects role-specific instructions into DevClaw worker sessions" } as any);
}
