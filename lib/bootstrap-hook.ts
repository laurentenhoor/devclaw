/**
 * bootstrap-hook.ts — Bootstrap support for DevClaw worker sessions.
 *
 * Provides:
 *   1. agent:bootstrap (internal hook) — strips orchestrator AGENTS.md so
 *      the worker doesn't see the orchestrator's instructions. Requires
 *      hooks.internal.enabled in config. If unavailable, workers still
 *      receive role instructions via extraSystemPrompt (just also see AGENTS.md).
 *   2. loadRoleInstructions() — loads role-specific prompt files from workspace.
 *      Used by dispatch.ts to pass instructions as extraSystemPrompt in the
 *      gateway agent call, which injects them into the worker's system prompt.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getSessionKeyRolePattern } from "./roles/index.js";
import { DATA_DIR } from "./setup/migrate-layout.js";


/**
 * Parse a DevClaw subagent session key to extract project name and role.
 *
 * Session key format (named): `agent:{agentId}:subagent:{projectName}-{role}-{level}-{slotName}`
 * Session key format (numeric): `agent:{agentId}:subagent:{projectName}-{role}-{level}-{slotIndex}`
 * Session key format (legacy): `agent:{agentId}:subagent:{projectName}-{role}-{level}`
 * Examples:
 *   - `agent:devclaw:subagent:my-project-developer-medior-Ada` → { projectName: "my-project", role: "developer" }
 *   - `agent:devclaw:subagent:my-project-developer-medior-0`   → { projectName: "my-project", role: "developer" }
 *   - `agent:devclaw:subagent:webapp-tester-medior`             → { projectName: "webapp", role: "tester" } (legacy)
 *
 * Note: projectName may contain hyphens, so we match role from the end.
 */
export function parseDevClawSessionKey(
  sessionKey: string,
): { projectName: string; role: string } | null {
  const rolePattern = getSessionKeyRolePattern();
  // Named/numeric format: ...-{role}-{level}-{slotNameOrIndex}
  const newMatch = sessionKey.match(new RegExp(`:subagent:(.+)-(${rolePattern})-[^-]+-[^-]+$`));
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
 * Register the agent:bootstrap hook for DevClaw worker sessions.
 *
 * Strips AGENTS.md content so the worker doesn't see orchestrator instructions.
 * Requires hooks.internal.enabled in config. If it doesn't fire, the worker
 * still gets role instructions via extraSystemPrompt — just also sees AGENTS.md.
 *
 * Role instruction injection is handled by dispatch.ts via the gateway's
 * extraSystemPrompt parameter (injected into the worker's system prompt).
 */
export function registerBootstrapHook(api: OpenClawPluginApi): void {
  api.registerHook("agent:bootstrap", async (event) => {
    const sessionKey = event.sessionKey;
    if (!sessionKey) return;

    const parsed = parseDevClawSessionKey(sessionKey);
    if (!parsed) return;

    const context = event.context as {
      bootstrapFiles?: Array<{
        name: string;
        path: string;
        content?: string;
        missing: boolean;
      }>;
    };

    const bootstrapFiles = context.bootstrapFiles;
    if (!Array.isArray(bootstrapFiles)) return;

    const agentsEntry = bootstrapFiles.find((f) => f.name === "AGENTS.md");
    if (agentsEntry) {
      agentsEntry.content = "";
      agentsEntry.missing = true;
      api.logger.info(`agent:bootstrap: stripped AGENTS.md for ${parsed.role} worker in "${parsed.projectName}"`);
    }
  }, { name: "devclaw-strip-agents-md", description: "Strips orchestrator AGENTS.md from DevClaw worker sessions" } as any);
}
