/**
 * health — Worker health scan with optional auto-fix.
 *
 * Triangulates projects.json, issue labels, and session state to detect:
 *   - session_dead: active worker but session missing in gateway
 *   - label_mismatch: active worker but issue not in expected label
 *   - stale_worker: active for >2h
 *   - stuck_label: inactive but issue has Doing/Testing label
 *   - orphan_issue_id: inactive but issueId set
 *   - issue_gone: active but issue deleted/closed
 *
 * Read-only by default (surfaces issues). Pass fix=true to apply fixes.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { readProjects, getProject } from "../projects.js";
import { log as auditLog } from "../audit.js";
import { checkWorkerHealth, fetchGatewaySessions, type HealthFix } from "../services/health.js";
import { requireWorkspaceDir, resolveProvider } from "../tool-helpers.js";

export function createHealthTool() {
  return (ctx: ToolContext) => ({
    name: "health",
    label: "Health",
    description: `Scan worker health across projects. Detects zombies, stale workers, orphaned state. Pass fix=true to auto-fix. Context-aware: auto-filters in group chats.`,
    parameters: {
      type: "object",
      properties: {
        projectGroupId: { type: "string", description: "Filter to specific project. Omit for all." },
        fix: { type: "boolean", description: "Apply fixes for detected issues. Default: false (read-only)." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);
      const fix = (params.fix as boolean) ?? false;

      const groupId = params.projectGroupId as string | undefined;

      const data = await readProjects(workspaceDir);
      const projectIds = groupId ? [groupId] : Object.keys(data.projects);

      // Fetch gateway sessions once for all projects
      const sessions = await fetchGatewaySessions();

      const issues: Array<HealthFix & { project: string; role: string }> = [];

      for (const pid of projectIds) {
        const project = getProject(data, pid);
        if (!project) continue;
        const { provider } = await resolveProvider(project);

        for (const role of ["dev", "qa"] as const) {
          const fixes = await checkWorkerHealth({
            workspaceDir,
            groupId: pid,
            project,
            role,
            sessions,
            autoFix: fix,
            provider,
          });
          issues.push(...fixes.map((f) => ({ ...f, project: project.name, role })));
        }
      }

      await auditLog(workspaceDir, "health", {
        projectCount: projectIds.length,
        fix,
        issuesFound: issues.length,
        issuesFixed: issues.filter((i) => i.fixed).length,
        sessionsCached: sessions.size,
      });

      return jsonResult({
        success: true,
        fix,
        projectsScanned: projectIds.length,
        sessionsQueried: sessions.size,
        issues,
      });
    },
  });
}
