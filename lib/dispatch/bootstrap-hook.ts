/**
 * bootstrap-hook.ts — Bootstrap support for DevClaw worker sessions.
 *
 * Provides:
 *   1. agent:bootstrap (internal hook) — replaces the orchestrator's AGENTS.md
 *      with role-specific instructions so the worker sees its own prompt on
 *      every turn. Requires hooks.internal.enabled in config.
 *   2. loadRoleInstructions() — loads role-specific prompt files from workspace.
 *      Used by both the bootstrap hook (persistent per-turn injection) and
 *      dispatch.ts (extraSystemPrompt fallback for the dispatch turn).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { getSessionKeyRolePattern } from "../roles/index.js";
import { DATA_DIR } from "../setup/migrate-layout.js";
import { DEFAULT_ROLE_INSTRUCTIONS } from "../setup/templates.js";

/**
 * Parse a DevClaw subagent session key to extract project name and role.
 *
 * Session key format (named): `agent:{agentId}:subagent:{projectName}-{role}-{level}-{name}` (name is lowercase)
 * Session key format (numeric): `agent:{agentId}:subagent:{projectName}-{role}-{level}-{slotIndex}`
 * Session key format (legacy): `agent:{agentId}:subagent:{projectName}-{role}-{level}`
 * Examples:
 *   - `agent:devclaw:subagent:my-project-developer-medior-ada`  → { projectName: "my-project", role: "developer" }
 *   - `agent:devclaw:subagent:my-project-developer-medior-0`    → { projectName: "my-project", role: "developer" }
 *   - `agent:devclaw:subagent:webapp-tester-medior`              → { projectName: "webapp", role: "tester" } (legacy)
 *
 * Note: projectName may contain hyphens, so we match role from the end.
 */
export function parseDevClawSessionKey(
  sessionKey: string,
): { projectName: string; role: string } | null {
  const rolePattern = getSessionKeyRolePattern();
  // Named/numeric format: ...-{role}-{level}-{nameOrIndex}
  const newMatch = sessionKey.match(
    new RegExp(`:subagent:(.+)-(${rolePattern})-[^-]+-[^-]+$`),
  );
  if (newMatch) return { projectName: newMatch[1], role: newMatch[2] };
  // Legacy format fallback: ...-{role}-{level} (for in-flight sessions during migration)
  const legacyMatch = sessionKey.match(
    new RegExp(`:subagent:(.+)-(${rolePattern})-[^-]+$`),
  );
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
 * Tries project-specific file first, then workspace default, then package default.
 * Returns both the content and the source path for logging/traceability.
 *
 * Resolution order:
 *   1. devclaw/projects/<project>/prompts/<role>.md  (project-specific override)
 *   2. projects/roles/<project>/<role>.md             (old project-specific)
 *   3. devclaw/prompts/<role>.md                      (workspace default)
 *   4. projects/roles/default/<role>.md               (old default)
 *   5. Package default from templates.ts              (in-memory fallback)
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
    } catch {
      /* not found, try next */
    }
  }

  // Final fallback: package defaults (in-memory, always available)
  const packageDefault = DEFAULT_ROLE_INSTRUCTIONS[role];
  if (packageDefault) {
    if (opts?.withSource) return { content: packageDefault, source: "package-default" };
    return packageDefault;
  }

  if (opts?.withSource) return { content: "", source: null };
  return "";
}

/**
 * Register the agent:bootstrap hook for DevClaw worker sessions.
 *
 * Replaces the orchestrator's AGENTS.md with role-specific instructions
 * loaded from the workspace. This ensures workers see their own prompt on
 * every turn — not just the dispatch turn (where extraSystemPrompt is used).
 *
 * If role instructions are found, AGENTS.md content is replaced entirely.
 * If none are found, AGENTS.md is still stripped to avoid orchestrator bleed.
 *
 * Requires hooks.internal.enabled in config. If the hook doesn't fire,
 * dispatch.ts still passes instructions via extraSystemPrompt (single-turn).
 */
export function registerBootstrapHook(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.registerHook(
    "agent:bootstrap",
    async (event) => {
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

      const bootstrapFiles = context.bootstrapFiles;
      if (!Array.isArray(bootstrapFiles)) return;

      const agentsEntry = bootstrapFiles.find((f) => f.name === "AGENTS.md");
      if (!agentsEntry) return;

      // Load role instructions from workspace (project-specific → default fallback)
      const workspaceDir = context.workspaceDir;
      if (!workspaceDir) {
        agentsEntry.content = "";
        agentsEntry.missing = true;
        ctx.logger.info(
          `agent:bootstrap: stripped AGENTS.md for ${parsed.role} worker in "${parsed.projectName}" (no workspaceDir)`,
        );
        return;
      }

      const { content, source } = await loadRoleInstructions(
        workspaceDir,
        parsed.projectName,
        parsed.role,
        { withSource: true },
      );

      if (content.trim()) {
        agentsEntry.content = content;
        agentsEntry.missing = false;
        ctx.logger.info(
          `agent:bootstrap: injected ${parsed.role} instructions for "${parsed.projectName}" from ${source}`,
        );
      } else {
        agentsEntry.content = "";
        agentsEntry.missing = true;
        ctx.logger.info(
          `agent:bootstrap: stripped AGENTS.md for ${parsed.role} worker in "${parsed.projectName}" (no role instructions found)`,
        );
      }
    },
    {
      name: "devclaw-bootstrap-role-instructions",
      description:
        "Replaces orchestrator AGENTS.md with role-specific instructions for DevClaw workers",
    } as any,
  );
}
