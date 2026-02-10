/**
 * task_complete — Atomically complete a task (DEV done, QA pass/fail/refine).
 *
 * Handles: validation, label transition, projects.json state update,
 * issue close/reopen, audit logging, and optional auto-chaining.
 *
 * When project.autoChain is true:
 *   - DEV "done" → automatically dispatches QA (qa tier)
 *   - QA "fail" → automatically dispatches DEV fix (reuses previous DEV tier)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { log as auditLog } from "../audit.js";
import { dispatchTask } from "../dispatch.js";
import { type StateLabel } from "../task-managers/task-manager.js";
import { createProvider } from "../task-managers/index.js";
import { resolveRepoPath } from "../projects.js";
import {
  deactivateWorker,
  getProject,
  getSessionForModel,
  getWorker,
  readProjects,
} from "../projects.js";
import type { ToolContext } from "../types.js";
import { notify, getNotificationConfig } from "../notify.js";

const execFileAsync = promisify(execFile);

export function createTaskCompleteTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_complete",
    label: "Task Complete",
    description: `Complete a task: DEV done/blocked, QA pass/fail/refine/blocked. Atomically handles: label transition, projects.json update, issue close/reopen, and audit logging. If the project has autoChain enabled, automatically dispatches the next step (DEV done → QA, QA fail → DEV fix). Use "blocked" when the worker cannot complete the task (errors, missing info, etc.).`,
    parameters: {
      type: "object",
      required: ["role", "result", "projectGroupId"],
      properties: {
        role: {
          type: "string",
          enum: ["dev", "qa"],
          description: "Worker role completing the task",
        },
        result: {
          type: "string",
          enum: ["done", "pass", "fail", "refine", "blocked"],
          description:
            'Completion result: "done" (DEV finished), "pass" (QA approved), "fail" (QA found issues), "refine" (needs human input), "blocked" (cannot complete, needs escalation)',
        },
        projectGroupId: {
          type: "string",
          description: "Telegram/WhatsApp group ID (key in projects.json)",
        },
        summary: {
          type: "string",
          description: "Brief summary for group announcement",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const role = params.role as "dev" | "qa";
      const result = params.result as "done" | "pass" | "fail" | "refine" | "blocked";
      const groupId = params.projectGroupId as string;
      const summary = params.summary as string | undefined;
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // Validate result matches role
      if (role === "dev" && result !== "done" && result !== "blocked") {
        throw new Error(
          `DEV can only complete with "done" or "blocked", got "${result}"`,
        );
      }
      if (role === "qa" && result === "done") {
        throw new Error(
          `QA cannot use result "done". Use "pass", "fail", "refine", or "blocked".`,
        );
      }

      // Resolve project
      const data = await readProjects(workspaceDir);
      const project = getProject(data, groupId);
      if (!project) {
        throw new Error(`Project not found for groupId: ${groupId}`);
      }

      const worker = getWorker(project, role);
      if (!worker.active) {
        throw new Error(
          `${role.toUpperCase()} worker is not active on ${project.name}. Nothing to complete.`,
        );
      }

      const issueId = worker.issueId
        ? Number(worker.issueId.split(",")[0])
        : null;
      if (!issueId) {
        throw new Error(
          `No issueId found for active ${role.toUpperCase()} worker on ${project.name}`,
        );
      }

      const { provider } = createProvider({
        repo: project.repo,
      });

      const repoPath = resolveRepoPath(project.repo);

      const output: Record<string, unknown> = {
        success: true,
        project: project.name,
        groupId,
        issueId,
        role,
        result,
      };

      // === DEV DONE ===
      if (role === "dev" && result === "done") {
        try {
          await execFileAsync("git", ["pull"], {
            cwd: repoPath,
            timeout: 30_000,
          });
          output.gitPull = "success";
        } catch (err) {
          output.gitPull = `warning: ${(err as Error).message}`;
        }

        await deactivateWorker(workspaceDir, groupId, "dev");
        await provider.transitionLabel(issueId, "Doing", "To Test");

        output.labelTransition = "Doing → To Test";
        output.announcement = `✅ DEV done #${issueId}${summary ? ` — ${summary}` : ""}. Moved to QA queue.`;

        if (project.autoChain) {
          try {
            const pluginConfig = api.pluginConfig as
              | Record<string, unknown>
              | undefined;
            const issue = await provider.getIssue(issueId);
            const chainResult = await dispatchTask({
              workspaceDir,
              agentId: ctx.agentId,
              groupId,
              project,
              issueId,
              issueTitle: issue.title,
              issueDescription: issue.description ?? "",
              issueUrl: issue.web_url,
              role: "qa",
              modelAlias: "qa",
              fromLabel: "To Test",
              toLabel: "Testing",
              transitionLabel: (id, from, to) =>
                provider.transitionLabel(
                  id,
                  from as StateLabel,
                  to as StateLabel,
                ),
              pluginConfig,
              sessionKey: ctx.sessionKey,
            });
            output.autoChain = {
              dispatched: true,
              role: "qa",
              model: chainResult.modelAlias,
              sessionAction: chainResult.sessionAction,
              announcement: chainResult.announcement,
            };
          } catch (err) {
            output.autoChain = {
              dispatched: false,
              error: (err as Error).message,
            };
          }
        } else {
          output.nextAction = "qa_pickup";
        }
      }

      // === QA PASS ===
      if (role === "qa" && result === "pass") {
        await deactivateWorker(workspaceDir, groupId, "qa");
        await provider.transitionLabel(issueId, "Testing", "Done");
        await provider.closeIssue(issueId);

        output.labelTransition = "Testing → Done";
        output.issueClosed = true;
        output.announcement = `🎉 QA PASS #${issueId}${summary ? ` — ${summary}` : ""}. Issue closed.`;
      }

      // === QA FAIL ===
      if (role === "qa" && result === "fail") {
        await deactivateWorker(workspaceDir, groupId, "qa");
        await provider.transitionLabel(issueId, "Testing", "To Improve");
        await provider.reopenIssue(issueId);

        const devWorker = getWorker(project, "dev");
        const devModel = devWorker.model;
        const devSessionKey = devModel
          ? getSessionForModel(devWorker, devModel)
          : null;

        output.labelTransition = "Testing → To Improve";
        output.issueReopened = true;
        output.announcement = `❌ QA FAIL #${issueId}${summary ? ` — ${summary}` : ""}. Sent back to DEV.`;
        output.devSessionAvailable = !!devSessionKey;
        if (devModel) output.devModel = devModel;

        if (project.autoChain && devModel) {
          try {
            const pluginConfig = api.pluginConfig as
              | Record<string, unknown>
              | undefined;
            const issue = await provider.getIssue(issueId);
            const chainResult = await dispatchTask({
              workspaceDir,
              agentId: ctx.agentId,
              groupId,
              project,
              issueId,
              issueTitle: issue.title,
              issueDescription: issue.description ?? "",
              issueUrl: issue.web_url,
              role: "dev",
              modelAlias: devModel,
              fromLabel: "To Improve",
              toLabel: "Doing",
              transitionLabel: (id, from, to) =>
                provider.transitionLabel(
                  id,
                  from as StateLabel,
                  to as StateLabel,
                ),
              pluginConfig,
              sessionKey: ctx.sessionKey,
            });
            output.autoChain = {
              dispatched: true,
              role: "dev",
              model: chainResult.modelAlias,
              sessionAction: chainResult.sessionAction,
              announcement: chainResult.announcement,
            };
          } catch (err) {
            output.autoChain = {
              dispatched: false,
              error: (err as Error).message,
            };
          }
        } else {
          output.nextAction = "dev_fix";
        }
      }

      // === QA REFINE ===
      if (role === "qa" && result === "refine") {
        await deactivateWorker(workspaceDir, groupId, "qa");
        await provider.transitionLabel(issueId, "Testing", "Refining");

        output.labelTransition = "Testing → Refining";
        output.announcement = `🤔 QA REFINE #${issueId}${summary ? ` — ${summary}` : ""}. Awaiting human decision.`;
      }

      // === DEV BLOCKED ===
      if (role === "dev" && result === "blocked") {
        await deactivateWorker(workspaceDir, groupId, "dev");
        await provider.transitionLabel(issueId, "Doing", "To Do");

        output.labelTransition = "Doing → To Do";
        output.announcement = `🚫 DEV BLOCKED #${issueId}${summary ? ` — ${summary}` : ""}. Returned to queue.`;
      }

      // === QA BLOCKED ===
      if (role === "qa" && result === "blocked") {
        await deactivateWorker(workspaceDir, groupId, "qa");
        await provider.transitionLabel(issueId, "Testing", "To Test");

        output.labelTransition = "Testing → To Test";
        output.announcement = `🚫 QA BLOCKED #${issueId}${summary ? ` — ${summary}` : ""}. Returned to QA queue.`;
      }

      // Send notification to project group
      const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
      const notifyConfig = getNotificationConfig(pluginConfig);
      
      // Determine next state for the notification
      let nextState: string | undefined;
      if (role === "dev" && result === "done") {
        nextState = "QA queue";
      } else if (role === "dev" && result === "blocked") {
        nextState = "returned to queue";
      } else if (role === "qa" && result === "pass") {
        nextState = "Done!";
      } else if (role === "qa" && result === "fail") {
        nextState = "back to DEV";
      } else if (role === "qa" && result === "refine") {
        nextState = "awaiting human decision";
      } else if (role === "qa" && result === "blocked") {
        nextState = "returned to QA queue";
      }

      await notify(
        {
          type: "workerComplete",
          project: project.name,
          groupId,
          issueId,
          role,
          result,
          summary,
          nextState,
        },
        {
          workspaceDir,
          config: notifyConfig,
          groupId,
          channel: project.channel ?? "telegram",
        },
      );

      // Audit log
      await auditLog(workspaceDir, "task_complete", {
        project: project.name,
        groupId,
        issue: issueId,
        role,
        result,
        summary: summary ?? null,
        labelTransition: output.labelTransition,
        autoChain: output.autoChain ?? null,
      });

      return jsonResult(output);
    },
  });
}
