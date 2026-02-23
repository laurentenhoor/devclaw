/**
 * claim_ownership — Claim issue(s) for this instance.
 *
 * Adds an `owner:{instanceName}` label to issues so this instance
 * owns them for queue scanning and dispatch. Supports claiming a
 * single issue or all unclaimed queued issues for a project.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { requireWorkspaceDir, resolveProject, resolveProvider } from "../tool-helpers.js";
import { loadConfig } from "../config/index.js";
import { loadInstanceName } from "../instance.js";
import {
  detectOwner,
  getOwnerLabel,
  OWNER_LABEL_COLOR,
  OWNER_LABEL_PREFIX,
  getAllQueueLabels,
} from "../workflow.js";

export function createClaimOwnershipTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "claim_ownership",
    label: "Claim Ownership",
    description:
      "Claim issue(s) for this instance by adding an owner label. " +
      "If issueId is given, claims that specific issue. Otherwise claims all unclaimed queued issues. " +
      "Use force to transfer ownership from another instance.",
    parameters: {
      type: "object",
      required: ["projectSlug"],
      properties: {
        projectSlug: {
          type: "string",
          description: "Project slug (e.g. 'my-webapp').",
        },
        issueId: {
          type: "number",
          description:
            "Specific issue ID to claim. If omitted, claims all unclaimed queued issues.",
        },
        force: {
          type: "boolean",
          description:
            "Override existing owner label (transfer ownership). Default: false.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const slug = params.projectSlug as string;
      const issueIdParam = params.issueId as number | undefined;
      const force = (params.force as boolean) ?? false;
      const workspaceDir = requireWorkspaceDir(ctx);

      if (!slug) throw new Error("projectSlug is required");

      const { project } = await resolveProject(workspaceDir, slug);
      const { provider } = await resolveProvider(project);
      const resolvedConfig = await loadConfig(workspaceDir, project.name);
      const instanceName = await loadInstanceName(
        workspaceDir,
        resolvedConfig.instanceName,
      );
      const ownerLabel = getOwnerLabel(instanceName);

      // Ensure the owner label exists in the issue tracker
      await provider.ensureLabel(ownerLabel, OWNER_LABEL_COLOR);

      const claimed: number[] = [];
      const skipped: Array<{ issueId: number; reason: string }> = [];

      if (issueIdParam !== undefined) {
        // Claim a single issue
        const issue = await provider.getIssue(issueIdParam);
        const currentOwner = detectOwner(issue.labels);

        if (currentOwner === instanceName) {
          skipped.push({ issueId: issueIdParam, reason: "Already owned by this instance" });
        } else if (currentOwner && !force) {
          skipped.push({
            issueId: issueIdParam,
            reason: `Owned by "${currentOwner}". Use force=true to transfer.`,
          });
        } else {
          // Remove old owner label if transferring
          if (currentOwner) {
            const oldLabel = getOwnerLabel(currentOwner);
            await provider.removeLabels(issueIdParam, [oldLabel]);
          }
          await provider.addLabel(issueIdParam, ownerLabel);
          claimed.push(issueIdParam);
        }
      } else {
        // Claim all unclaimed queued issues
        const workflow = resolvedConfig.workflow;
        const queueLabels = getAllQueueLabels(workflow);

        for (const label of queueLabels) {
          try {
            const issues = await provider.listIssuesByLabel(label);
            for (const issue of issues) {
              const currentOwner = detectOwner(issue.labels);
              if (currentOwner === instanceName) continue; // already ours
              if (currentOwner && !force) {
                skipped.push({
                  issueId: issue.iid,
                  reason: `Owned by "${currentOwner}"`,
                });
                continue;
              }
              if (currentOwner) {
                const oldLabel = getOwnerLabel(currentOwner);
                await provider.removeLabels(issue.iid, [oldLabel]);
              }
              await provider.addLabel(issue.iid, ownerLabel);
              claimed.push(issue.iid);
            }
          } catch {
            // Skip label query failures
          }
        }
      }

      return jsonResult({
        success: true,
        instanceName,
        ownerLabel,
        claimed,
        skipped,
        summary: `Claimed ${claimed.length} issue(s) for "${instanceName}"${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}`,
      });
    },
  });
}
