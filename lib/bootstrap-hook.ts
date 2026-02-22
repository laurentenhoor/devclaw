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
 * Session key format (new): `agent:{agentId}:subagent:{projectName}-{role}-{level}-{slotIndex}`
 * Session key format (legacy): `agent:{agentId}:subagent:{projectName}-{role}-{level}`
 * Examples:
 *   - `agent:devclaw:subagent:my-project-developer-medior-0` → { projectName: "my-project", role: "developer" }
 *   - `agent:devclaw:subagent:webapp-tester-medior`          → { projectName: "webapp", role: "tester" } (legacy)
 *
 * Note: projectName may contain hyphens, so we match role from the end.
 */
export function parseDevClawSessionKey(
  sessionKey: string,
): { projectName: string; role: string } | null {
  const rolePattern = getSessionKeyRolePattern();
  // New format: ...-{role}-{level}-{slotIndex}
  const newMatch = sessionKey.match(new RegExp(`:subagent:(.+)-(${rolePattern})-[^-]+-\\d+$`));
  if (newMatch) return { projectName: newMatch[1], role: newMatch[2] };
  // Legacy format fallback: ...-{role}-{level} (for in-flight sessions during migration)
  const legacyMatch = sessionKey.match(new RegExp(`:subagent:(.+)-(${rolePattern})-[^-]+$`));
  if (legacyMatch) return { projectName: legacyMatch[1], role: legacyMatch[2] };
  return null;
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
 * 4. Replaces AGENTS.md content with role instructions (workers don't need orchestrator AGENTS.md)
 *
 * OpenClaw automatically includes AGENTS.md in the agent's system prompt (even for subagents),
 * so replacing its content is all we need — no extra virtual files.
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

    const workspaceDir = context.workspaceDir;
    if (!workspaceDir || typeof workspaceDir !== "string") {
      api.logger.warn(`Bootstrap hook: no workspaceDir in context for ${sessionKey}`);
      return;
    }

    const bootstrapFiles = context.bootstrapFiles;
    if (!Array.isArray(bootstrapFiles)) {
      api.logger.warn(`Bootstrap hook: no bootstrapFiles array in context for ${sessionKey}`);
      return;
    }

    const agentsEntry = bootstrapFiles.find((f) => f.name === "AGENTS.md");
    if (!agentsEntry) {
      api.logger.warn(`Bootstrap hook: no AGENTS.md entry in bootstrapFiles for ${sessionKey}`);
      return;
    }

    // Load role-specific instructions and inject as AGENTS.md content
    const { content, source } = await loadRoleInstructions(
      workspaceDir,
      parsed.projectName,
      parsed.role,
      { withSource: true },
    );

    if (content) {
      agentsEntry.content = content.trim();
      api.logger.info(
        `Bootstrap hook: replaced AGENTS.md with ${parsed.role} instructions for project "${parsed.projectName}" from ${source}`,
      );
    } else {
      // No role instructions found — strip AGENTS.md so worker doesn't see orchestrator content
      agentsEntry.content = "";
      agentsEntry.missing = true;
      api.logger.warn(`Bootstrap hook: no role instructions found for ${parsed.role} in project "${parsed.projectName}" — AGENTS.md stripped`);
    }
  }, { name: "devclaw-worker-instructions", description: "Injects role-specific instructions into DevClaw worker sessions" } as any);
}
