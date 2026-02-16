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
 * Parse a DevClaw subagent session key to extract project name and role.
 *
 * Session key format: `agent:{agentId}:subagent:{projectName}-{role}-{level}`
 * Examples:
 *   - `agent:devclaw:subagent:my-project-developer-medior` → { projectName: "my-project", role: "developer" }
 *   - `agent:devclaw:subagent:webapp-tester-medior`        → { projectName: "webapp", role: "tester" }
 *
 * Note: projectName may contain hyphens, so we match role from the end.
 */
export function parseDevClawSessionKey(
  sessionKey: string,
): { projectName: string; role: string } | null {
  // Match `:subagent:` prefix, then capture project name and role (derived from registry)
  const rolePattern = getSessionKeyRolePattern();
  const match = sessionKey.match(new RegExp(`:subagent:(.+)-(${rolePattern})-[^-]+$`));
  if (!match) return null;
  return { projectName: match[1], role: match[2] };
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
 * 1. Detects it's a DevClaw subagent via session key pattern
 * 2. Extracts project name and role
 * 3. Loads role-specific instructions from workspace
 * 4. Injects them as a virtual workspace file (WORKER_INSTRUCTIONS.md)
 *
 * OpenClaw automatically includes bootstrap files in the agent's system prompt,
 * so workers receive their instructions without any file-read in dispatch.ts.
 */
export function registerBootstrapHook(api: OpenClawPluginApi): void {
  api.registerHook("agent:bootstrap", async (event) => {
    const sessionKey = event.sessionKey;
    if (!sessionKey) return;

    const parsed = parseDevClawSessionKey(sessionKey);
    if (!parsed) return;

    const context = event.context as {
      workspaceDir?: string;
      bootstrapFiles?: Array<{
        name: string;
        path: string;
        content?: string;
        missing: boolean;
      }>;
    };

    const workspaceDir = context.workspaceDir;
    if (!workspaceDir || typeof workspaceDir !== "string") return;

    const bootstrapFiles = context.bootstrapFiles;
    if (!Array.isArray(bootstrapFiles)) return;

    const { content, source } = await loadRoleInstructions(
      workspaceDir,
      parsed.projectName,
      parsed.role,
      { withSource: true },
    );

    if (!content) return;

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
  });
}
