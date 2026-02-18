/**
 * work_finish — Complete a task (DEV done, QA pass/fail/refine/blocked, architect done/blocked).
 *
 * Delegates side-effects to pipeline service: label transition, state update,
 * issue close/reopen, notifications, and audit logging.
 *
 * All roles (including architect) use the standard pipeline via executeCompletion.
 * Architect workflow: Researching → Planning (done), Researching → Refining (blocked).
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { getWorker, resolveRepoPath } from "../projects.js";
import { executeCompletion, getRule } from "../services/pipeline.js";
import { log as auditLog } from "../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, getPluginConfig } from "../tool-helpers.js";
import { getAllRoleIds, isValidResult, getCompletionResults } from "../roles/index.js";
import { loadWorkflow } from "../workflow.js";
import { runCommand } from "../run-command.js";
import { PrState } from "../providers/provider.js";

/**
 * Get the current git branch name.
 */
async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await runCommand(["git", "branch", "--show-current"], {
    timeoutMs: 5_000,
    cwd: repoPath,
  });
  return result.stdout.trim();
}

/**
 * Validate that a developer has created a PR for their work.
 * Throws an error if no open PR is found for the issue.
 */
async function validatePrExistsForDeveloper(
  issueId: number,
  repoPath: string,
  provider: Awaited<ReturnType<typeof resolveProvider>>["provider"],
): Promise<void> {
  try {
    const prStatus = await provider.getPrStatus(issueId);
    
    // Check if there's an open PR
    if (prStatus.state === PrState.CLOSED) {
      // Get current branch for helpful error message
      let branchName = "current-branch";
      try {
        branchName = await getCurrentBranch(repoPath);
      } catch {
        // Fall back to generic branch name
      }

      throw new Error(
        `Cannot mark work_finish(done) without an open PR.\n\n` +
        `✗ No PR found for issue #${issueId}\n\n` +
        `Please create a PR first:\n` +
        `  gh pr create --base main --head ${branchName} --title "..." --body "..."\n\n` +
        `Then call work_finish again.`,
      );
    }

    // If PR exists, validate that it references the issue
    // (getPrStatus already validates this by looking for linked PRs)
    // If prStatus is not CLOSED, the PR exists and is linked to the issue
  } catch (err) {
    // If the error is our validation error, rethrow it
    if (err instanceof Error && err.message.includes("Cannot mark work_finish(done)")) {
      throw err;
    }
    // For other errors (e.g., API connectivity), log but don't block
    // This is defensive: we don't want to prevent work_finish due to API issues
    console.warn(`PR validation warning for issue #${issueId}:`, err);
  }
}

export function createWorkFinishTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "work_finish",
    label: "Work Finish",
    description: `Complete a task: Developer done (PR created, goes to review) or blocked. Tester pass/fail/refine/blocked. Reviewer approve/reject/blocked. Architect done/blocked. Handles label transition, state update, issue close/reopen, notifications, and audit logging.`,
    parameters: {
      type: "object",
      required: ["role", "result", "projectSlug"],
      properties: {
        role: { type: "string", enum: getAllRoleIds(), description: "Worker role" },
        result: { type: "string", enum: ["done", "pass", "fail", "refine", "blocked", "approve", "reject"], description: "Completion result" },
        projectSlug: { type: "string", description: "Project slug (e.g. 'my-webapp')" },
        summary: { type: "string", description: "Brief summary" },
        prUrl: { type: "string", description: "PR/MR URL (auto-detected if omitted)" },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const role = params.role as string;
      const result = params.result as string;
      const slug = (params.projectSlug ?? params.projectGroupId) as string;
      const summary = params.summary as string | undefined;
      const prUrl = params.prUrl as string | undefined;
      const workspaceDir = requireWorkspaceDir(ctx);

      // Validate role:result using registry
      if (!isValidResult(role, result)) {
        const valid = getCompletionResults(role);
        throw new Error(`${role.toUpperCase()} cannot complete with "${result}". Valid results: ${valid.join(", ")}`);
      }

      // Resolve project + worker
      const { project } = await resolveProject(workspaceDir, slug);
      const worker = getWorker(project, role);
      if (!worker.active) throw new Error(`${role.toUpperCase()} worker not active on ${project.name}`);

      const issueId = worker.issueId ? Number(worker.issueId.split(",")[0]) : null;
      if (!issueId) throw new Error(`No issueId for active ${role.toUpperCase()} on ${project.name}`);

      const { provider } = await resolveProvider(project);
      const workflow = await loadWorkflow(workspaceDir, project.name);

      if (!getRule(role, result, workflow))
        throw new Error(`Invalid completion: ${role}:${result}`);

      const repoPath = resolveRepoPath(project.repo);
      const pluginConfig = getPluginConfig(api);

      // For developers marking work as done, validate that a PR exists
      if (role === "developer" && result === "done") {
        await validatePrExistsForDeveloper(issueId, repoPath, provider);
      }

      const completion = await executeCompletion({
        workspaceDir, projectSlug: project.slug, role, result, issueId, summary, prUrl, provider, repoPath,
        projectName: project.name,
        channels: project.channels,
        pluginConfig,
        runtime: api.runtime,
        workflow,
      });

      await auditLog(workspaceDir, "work_finish", {
        project: project.name, issue: issueId, role, result,
        summary: summary ?? null, labelTransition: completion.labelTransition,
      });

      return jsonResult({
        success: true, project: project.name, projectSlug: project.slug, issueId, role, result,
        ...completion,
      });
    },
  });
}
