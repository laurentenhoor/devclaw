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

/**
 * Parse a DevClaw subagent session key to extract project name and role.
 *
 * Session key format: `agent:{agentId}:subagent:{projectName}-{role}-{level}`
 * Examples:
 *   - `agent:devclaw:subagent:my-project-dev-medior` → { projectName: "my-project", role: "dev" }
 *   - `agent:devclaw:subagent:webapp-qa-reviewer`    → { projectName: "webapp", role: "qa" }
 *
 * Note: projectName may contain hyphens, so we match role from the end.
 */
export function parseDevClawSessionKey(
  sessionKey: string,
): { projectName: string; role: "dev" | "qa" } | null {
  // Match `:subagent:` prefix, then capture everything up to the last `-dev-` or `-qa-`
  const match = sessionKey.match(/:subagent:(.+)-(dev|qa)-[^-]+$/);
  if (!match) return null;
  return { projectName: match[1], role: match[2] as "dev" | "qa" };
}

/**
 * Load role-specific instructions from workspace.
 * Tries project-specific file first, then falls back to default.
 *
 * This is the same logic previously in dispatch.ts loadRoleInstructions(),
 * now called from the bootstrap hook instead of during dispatch.
 */
export async function loadRoleInstructions(
  workspaceDir: string,
  projectName: string,
  role: "dev" | "qa",
): Promise<string> {
  const projectFile = path.join(workspaceDir, "projects", "roles", projectName, `${role}.md`);
  try {
    return await fs.readFile(projectFile, "utf-8");
  } catch {
    /* not found — try default */
  }
  const defaultFile = path.join(workspaceDir, "projects", "roles", "default", `${role}.md`);
  try {
    return await fs.readFile(defaultFile, "utf-8");
  } catch {
    /* not found */
  }
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

    const instructions = await loadRoleInstructions(
      workspaceDir,
      parsed.projectName,
      parsed.role,
    );

    if (!instructions) return;

    // Inject as a virtual bootstrap file. OpenClaw includes these in the
    // agent's system prompt automatically (via buildBootstrapContextFiles).
    bootstrapFiles.push({
      name: "WORKER_INSTRUCTIONS.md" as any,
      path: `<devclaw:${parsed.projectName}:${parsed.role}>`,
      content: instructions.trim(),
      missing: false,
    });

    api.logger.info(
      `Bootstrap hook: injected ${parsed.role} instructions for project "${parsed.projectName}"`,
    );
  });
}
