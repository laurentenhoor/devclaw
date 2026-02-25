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
 *   - orphaned_label: active label but no worker tracking it
 *
 * Read-only by default (surfaces issues). Pass fix=true to apply fixes.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { readProjects, getProject } from "../../projects/index.js";
import { log as auditLog } from "../../audit.js";
import { checkWorkerHealth, scanOrphanedLabels, fetchGatewaySessions, type HealthFix } from "../../services/heartbeat/health.js";
import { requireWorkspaceDir, resolveProvider } from "../helpers.js";

export function createHealthTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "health",
    label: "Health",
    description: `Scan worker health across projects. Detects zombies, stale workers, orphaned state. Pass fix=true to auto-fix. Context-aware: auto-filters in group chats.`,
    parameters: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Channel ID identifying the project. Omit for all." },
        fix: { type: "boolean", description: "Apply fixes for detected issues. Default: false (read-only)." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const fix = (params.fix as boolean) ?? false;

      const slugOrChannelId = params.channelId as string | undefined;

      const data = await readProjects(workspaceDir);

      // Resolve slug from slugOrChannelId
      let slugs = Object.keys(data.projects);
      if (slugOrChannelId) {
        const project = getProject(data, slugOrChannelId);
        const slug = project ?
          (data.projects[slugOrChannelId] ? slugOrChannelId :
            Object.keys(data.projects).find(s => data.projects[s].channels.some(ch => ch.channelId === slugOrChannelId)))
          : undefined;
        slugs = slug ? [slug] : [];
      }

      // Fetch gateway sessions once for all projects
      const sessions = await fetchGatewaySessions(undefined, ctx.runCommand);

      const issues: Array<HealthFix & { project: string; role: string }> = [];

      for (const slug of slugs) {
        const project = data.projects[slug];
        if (!project) continue;
        const { provider } = await resolveProvider(project, ctx.runCommand);
        for (const role of Object.keys(project.workers)) {
          // Worker health check (session liveness, label consistency, etc)
          const healthFixes = await checkWorkerHealth({
            workspaceDir,
            projectSlug: slug,
            project,
            role,
            sessions,
            autoFix: fix,
            provider,
          });
          issues.push(...healthFixes.map((f) => ({ ...f, project: project.name, role })));

          // Orphaned label scan (active labels with no tracking worker)
          const orphanFixes = await scanOrphanedLabels({
            workspaceDir,
            projectSlug: slug,
            project,
            role,
            autoFix: fix,
            provider,
          });
          issues.push(...orphanFixes.map((f) => ({ ...f, project: project.name, role })));
        }
      }

      await auditLog(workspaceDir, "health", {
        projectCount: slugs.length,
        fix,
        issuesFound: issues.length,
        issuesFixed: issues.filter((i) => i.fixed).length,
        sessionsCached: sessions?.size ?? 0,
      });

      return jsonResult({
        success: true,
        fix,
        projectsScanned: slugs.length,
        sessionsQueried: sessions?.size ?? 0,
        issues,
      });
    },
  });
}
