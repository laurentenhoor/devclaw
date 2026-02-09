/**
 * task_pickup — Atomically pick up a task from the issue queue.
 *
 * Auto-detects:
 * - projectGroupId: from message context (group chat)
 * - role: from issue label (To Do/To Improve → dev, To Test → qa)
 * - model: from tier labels on issue → heuristics → default
 * - issueId: if omitted, picks next by priority (To Improve > To Test > To Do)
 *
 * Handles: validation, model selection, then delegates to dispatchTask()
 * for label transition, session creation/reuse, task dispatch, state update,
 * and audit logging.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { dispatchTask } from "../dispatch.js";
import { type Issue, type StateLabel } from "../task-managers/task-manager.js";
import { createProvider } from "../task-managers/index.js";
import { selectModel } from "../model-selector.js";
import { getProject, getWorker, readProjects } from "../projects.js";
import type { ToolContext } from "../types.js";
import { detectContext, generateGuardrails } from "../context-guard.js";
import { isDevTier, isTier, type Tier } from "../tiers.js";
import { notify, getNotificationConfig } from "../notify.js";

/** Labels that map to DEV role */
const DEV_LABELS: StateLabel[] = ["To Do", "To Improve"];

/** Labels that map to QA role */
const QA_LABELS: StateLabel[] = ["To Test"];

/** All pickable labels, in priority order (highest first) */
const PRIORITY_ORDER: StateLabel[] = ["To Improve", "To Test", "To Do"];

/** Tier labels that can appear on issues */
const TIER_LABELS: Tier[] = ["junior", "medior", "senior", "qa"];

/**
 * Detect role from issue's current state label.
 */
function detectRoleFromLabel(label: StateLabel): "dev" | "qa" | null {
  if (DEV_LABELS.includes(label)) return "dev";
  if (QA_LABELS.includes(label)) return "qa";
  return null;
}

/**
 * Detect tier from issue labels (e.g., "junior", "senior").
 */
function detectTierFromLabels(labels: string[]): Tier | null {
  const lowerLabels = labels.map((l) => l.toLowerCase());
  for (const tier of TIER_LABELS) {
    if (lowerLabels.includes(tier)) {
      return tier;
    }
  }
  return null;
}

/**
 * Find the next issue to pick up by priority.
 * Priority: To Improve > To Test > To Do
 */
async function findNextIssue(
  provider: { listIssuesByLabel(label: StateLabel): Promise<Issue[]> },
  role?: "dev" | "qa",
): Promise<{ issue: Issue; label: StateLabel } | null> {
  // Filter priority order by role if specified
  let labelsToCheck = PRIORITY_ORDER;
  if (role === "dev") {
    labelsToCheck = PRIORITY_ORDER.filter((l) => DEV_LABELS.includes(l));
  } else if (role === "qa") {
    labelsToCheck = PRIORITY_ORDER.filter((l) => QA_LABELS.includes(l));
  }

  for (const label of labelsToCheck) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      if (issues.length > 0) {
        // Return oldest issue first (FIFO)
        const oldest = issues[issues.length - 1];
        return { issue: oldest, label };
      }
    } catch {
      // Continue to next label on error
    }
  }
  return null;
}

export function createTaskPickupTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_pickup",
    label: "Task Pickup",
    description: `Pick up a task from the issue queue. Context-aware: ONLY works in project group chats, not in DMs or during setup. Handles label transition, tier assignment, session creation, task dispatch, and audit logging. Returns an announcement for posting in the group.`,
    parameters: {
      type: "object",
      required: [],
      properties: {
        issueId: {
          type: "number",
          description:
            "Issue ID to pick up. If omitted, picks next by priority (To Improve > To Test > To Do).",
        },
        role: {
          type: "string",
          enum: ["dev", "qa"],
          description:
            "Worker role: dev or qa. If omitted, auto-detected from issue label (To Do/To Improve → dev, To Test → qa).",
        },
        projectGroupId: {
          type: "string",
          description:
            "Telegram/WhatsApp group ID (key in projects.json). If omitted, auto-detected from current group chat context.",
        },
        model: {
          type: "string",
          description:
            "Developer tier (junior, medior, senior, qa). If omitted, detected from issue tier labels, then heuristics.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const issueIdParam = params.issueId as number | undefined;
      const roleParam = params.role as "dev" | "qa" | undefined;
      const groupIdParam = params.projectGroupId as string | undefined;
      const modelParam = params.model as string | undefined;
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // --- Context detection ---
      const devClawAgentIds =
        ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as
          | string[]
          | undefined) ?? [];
      const context = await detectContext(ctx, devClawAgentIds);

      // ONLY allow in group context
      if (context.type !== "group") {
        return jsonResult({
          success: false,
          error: "task_pickup can only be used in project group chats.",
          recommendation:
            context.type === "via-agent"
              ? "If you're setting up DevClaw, use devclaw_onboard instead."
              : "To pick up tasks, please use the relevant project's Telegram/WhatsApp group.",
          contextGuidance: generateGuardrails(context),
        });
      }

      // 1. Auto-detect projectGroupId from context if not provided
      const groupId = groupIdParam ?? context.groupId;

      // 2. Resolve project
      const data = await readProjects(workspaceDir);
      const project = getProject(data, groupId);
      if (!project) {
        throw new Error(
          `Project not found for groupId: ${groupId}. Available: ${Object.keys(data.projects).join(", ")}`,
        );
      }

      // 3. Create provider for issue operations
      const { provider } = createProvider({
        repo: project.repo,
      });

      // 4. Find issue (by ID or auto-pick)
      let issue: Issue;
      let currentLabel: StateLabel;

      if (issueIdParam !== undefined) {
        // Explicit issue ID provided
        issue = await provider.getIssue(issueIdParam);
        const label = provider.getCurrentStateLabel(issue);
        if (!label) {
          throw new Error(
            `Issue #${issueIdParam} has no recognized state label. Expected one of: ${PRIORITY_ORDER.join(", ")}`,
          );
        }
        currentLabel = label;
      } else {
        // Auto-pick next issue by priority
        const next = await findNextIssue(provider, roleParam);
        if (!next) {
          const roleFilter = roleParam ? ` for ${roleParam.toUpperCase()}` : "";
          return jsonResult({
            success: false,
            error: `No issues available${roleFilter}. Queue is empty.`,
            checkedLabels: roleParam
              ? PRIORITY_ORDER.filter((l) =>
                  roleParam === "dev"
                    ? DEV_LABELS.includes(l)
                    : QA_LABELS.includes(l),
                )
              : PRIORITY_ORDER,
          });
        }
        issue = next.issue;
        currentLabel = next.label;
      }

      // 5. Auto-detect role from issue label if not provided
      const detectedRole = detectRoleFromLabel(currentLabel);
      if (!detectedRole) {
        throw new Error(
          `Issue #${issue.iid} has label "${currentLabel}" which doesn't map to dev or qa. Expected: ${[...DEV_LABELS, ...QA_LABELS].join(", ")}`,
        );
      }

      const role = roleParam ?? detectedRole;

      // Verify role matches label (if role was explicitly provided)
      if (roleParam && roleParam !== detectedRole) {
        throw new Error(
          `Role mismatch: issue #${issue.iid} has label "${currentLabel}" (${detectedRole.toUpperCase()}) but role "${roleParam}" was requested.`,
        );
      }

      // 6. Check no active worker for this role
      const worker = getWorker(project, role);
      if (worker.active) {
        throw new Error(
          `${role.toUpperCase()} worker already active on ${project.name} (issue: ${worker.issueId}). Complete current task first.`,
        );
      }

      // 6b. Check project-level roleExecution
      const roleExecution = project.roleExecution ?? "parallel";
      if (roleExecution === "sequential") {
        const otherRole = role === "dev" ? "qa" : "dev";
        const otherWorker = getWorker(project, otherRole);
        if (otherWorker.active) {
          throw new Error(
            `Project "${project.name}" has sequential roleExecution: ${otherRole.toUpperCase()} worker is active (issue: ${otherWorker.issueId}). Wait for it to complete first.`,
          );
        }
      }

      // 7. Select model (priority: param > tier label > heuristic)
      const targetLabel: StateLabel = role === "dev" ? "Doing" : "Testing";
      let modelAlias: string;
      let modelReason: string;
      let modelSource: string;

      if (modelParam) {
        // Explicit model param
        modelAlias = modelParam;
        modelReason = "LLM-selected by orchestrator";
        modelSource = "llm";
      } else {
        // Check for tier labels on the issue
        const tierFromLabels = detectTierFromLabels(issue.labels);

        if (tierFromLabels) {
          // Validate tier matches role
          if (role === "qa" && tierFromLabels !== "qa") {
            // QA role should use qa tier, ignore dev tier labels
            modelAlias = "qa";
            modelReason = `QA role overrides tier label "${tierFromLabels}"`;
            modelSource = "role-override";
          } else if (role === "dev" && tierFromLabels === "qa") {
            // Dev role shouldn't use qa tier, fall back to heuristic
            const selected = selectModel(
              issue.title,
              issue.description ?? "",
              role,
            );
            modelAlias = selected.tier;
            modelReason = `Ignored "qa" tier label for DEV role; ${selected.reason}`;
            modelSource = "heuristic";
          } else {
            modelAlias = tierFromLabels;
            modelReason = `Tier label found on issue: "${tierFromLabels}"`;
            modelSource = "label";
          }
        } else {
          // Fall back to keyword heuristic
          const selected = selectModel(
            issue.title,
            issue.description ?? "",
            role,
          );
          modelAlias = selected.tier;
          modelReason = selected.reason;
          modelSource = "heuristic";
        }
      }

      // 8. Dispatch via shared logic
      const pluginConfig = api.pluginConfig as
        | Record<string, unknown>
        | undefined;
      const dispatchResult = await dispatchTask({
        workspaceDir,
        agentId: ctx.agentId,
        groupId,
        project,
        issueId: issue.iid,
        issueTitle: issue.title,
        issueDescription: issue.description ?? "",
        issueUrl: issue.web_url,
        role,
        modelAlias,
        fromLabel: currentLabel,
        toLabel: targetLabel,
        transitionLabel: (id, from, to) =>
          provider.transitionLabel(id, from as StateLabel, to as StateLabel),
        pluginConfig,
      });

      // 9. Send notification to project group
      const notifyConfig = getNotificationConfig(pluginConfig);
      await notify(
        {
          type: "workerStart",
          project: project.name,
          groupId,
          issueId: issue.iid,
          issueTitle: issue.title,
          role,
          model: dispatchResult.modelAlias,
          sessionAction: dispatchResult.sessionAction,
        },
        {
          workspaceDir,
          config: notifyConfig,
          groupId,
          channel: context.channel,
        },
      );

      // 10. Build result
      const result: Record<string, unknown> = {
        success: true,
        project: project.name,
        groupId,
        issueId: issue.iid,
        issueTitle: issue.title,
        role,
        model: dispatchResult.modelAlias,
        fullModel: dispatchResult.fullModel,
        sessionAction: dispatchResult.sessionAction,
        announcement: dispatchResult.announcement,
        labelTransition: `${currentLabel} → ${targetLabel}`,
        modelReason,
        modelSource,
        autoDetected: {
          projectGroupId: !groupIdParam,
          role: !roleParam,
          issueId: issueIdParam === undefined,
          model: !modelParam,
        },
      };

      if (dispatchResult.sessionAction === "send") {
        result.tokensSavedEstimate = "~50K (session reuse)";
      }

      return jsonResult(result);
    },
  });
}
