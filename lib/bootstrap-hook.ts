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
 * Version status result from comparing plugin defaults with workspace.
 */
export type VersionStatus = {
  status: "up-to-date" | "outdated" | "customizations-detected" | "unknown";
  pluginVersion: string | null;
  installedVersion: string | null;
  customizedFiles?: string[];
  outdatedFiles?: string[];
};

/**
 * Check workspace defaults version status.
 * Returns version comparison result for monitoring/diagnostics.
 * 
 * This is a best-effort check — failures return "unknown" status.
 */
export async function checkDefaultsVersion(workspaceDir: string): Promise<VersionStatus> {
  try {
    const { compareManifests } = await import("./setup/defaults-manifest.js");
    const comparison = await compareManifests(workspaceDir);
    
    if (!comparison) {
      return { status: "unknown", pluginVersion: null, installedVersion: null };
    }
    
    if (comparison.customized.length > 0) {
      return {
        status: "customizations-detected",
        pluginVersion: comparison.pluginVersion,
        installedVersion: comparison.installedVersion,
        customizedFiles: comparison.customized,
      };
    }
    
    if (comparison.outdated.length > 0) {
      return {
        status: "outdated",
        pluginVersion: comparison.pluginVersion,
        installedVersion: comparison.installedVersion,
        outdatedFiles: comparison.outdated,
      };
    }
    
    return {
      status: "up-to-date",
      pluginVersion: comparison.pluginVersion,
      installedVersion: comparison.installedVersion,
    };
  } catch {
    return { status: "unknown", pluginVersion: null, installedVersion: null };
  }
}

/**
 * Register the agent:bootstrap hook for DevClaw worker instruction injection.
 *
 * When a DevClaw worker session starts, this hook:
 * 1. Detects it's a DevClaw subagent via session key pattern
 * 2. Extracts project name and role
 * 3. Checks workspace defaults version status
 * 4. Loads role-specific instructions from workspace
 * 5. Injects them as a virtual workspace file (WORKER_INSTRUCTIONS.md)
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

    const workspaceDir = context.workspaceDir;
    if (!workspaceDir || typeof workspaceDir !== "string") {
      api.logger.warn(`Bootstrap hook: no workspaceDir in context for ${sessionKey}`);
      return;
    }

    // Check defaults version status for monitoring/diagnostics
    const versionStatus = await checkDefaultsVersion(workspaceDir);
    if (versionStatus.status !== "up-to-date" && versionStatus.status !== "unknown") {
      api.logger.info(
        `Bootstrap hook: workspace defaults status=${versionStatus.status}, ` +
        `plugin=${versionStatus.pluginVersion}, installed=${versionStatus.installedVersion}`
      );
      if (versionStatus.customizedFiles && versionStatus.customizedFiles.length > 0) {
        api.logger.debug(`Customized files: ${versionStatus.customizedFiles.join(", ")}`);
      }
      if (versionStatus.outdatedFiles && versionStatus.outdatedFiles.length > 0) {
        api.logger.debug(`Outdated files: ${versionStatus.outdatedFiles.join(", ")}`);
      }
      
      // Check if we should notify about available upgrades
      try {
        const { checkVersionStatus: checkDetailedStatus, getNotificationState, updateNotificationState } = 
          await import("./setup/version-check.js");
        const detailedStatus = await checkDetailedStatus(workspaceDir);
        
        if (detailedStatus.changesAvailable && detailedStatus.pluginVersion) {
          const notifiedVersion = await getNotificationState(workspaceDir);
          
          // Only log if not yet notified about this version
          if (notifiedVersion !== detailedStatus.pluginVersion) {
            api.logger.info(
              `⚠️ DevClaw defaults upgrade available: ${detailedStatus.installedVersion} → ${detailedStatus.pluginVersion}. ` +
              `Run 'openclaw devclaw upgrade-defaults --preview' to review changes.`
            );
            // Mark as notified
            await updateNotificationState(workspaceDir, detailedStatus.pluginVersion);
          }
        }
      } catch {
        // Best-effort - don't break bootstrap if notification fails
      }
    }

    const bootstrapFiles = context.bootstrapFiles;
    if (!Array.isArray(bootstrapFiles)) {
      api.logger.warn(`Bootstrap hook: no bootstrapFiles array in context for ${sessionKey}`);
      return;
    }

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
