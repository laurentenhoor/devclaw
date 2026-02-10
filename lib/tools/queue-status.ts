/**
 * queue_status — Show task queue and worker status across projects.
 *
 * Enhanced with execution-aware task sequencing based on two-level work mode.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { readProjects, getProject, type Project } from "../projects.js";
import { type StateLabel, type Issue } from "../task-managers/task-manager.js";
import { createProvider } from "../task-managers/index.js";
import { log as auditLog } from "../audit.js";
import { detectContext, generateGuardrails } from "../context-guard.js";

/** Priority order for queue labels (higher = more urgent) */
const QUEUE_PRIORITY: Record<QueueLabel, number> = {
  "To Improve": 3,
  "To Test": 2,
  "To Do": 1,
};

type QueueLabel = "To Improve" | "To Test" | "To Do";
type Role = "dev" | "qa";

/** A task in the sequence with metadata */
interface SequencedTask {
  /** Sequence number (1-based) */
  sequence: number;
  /** Project group ID */
  projectId: string;
  /** Project name */
  projectName: string;
  /** Role (dev or qa) */
  role: Role;
  /** Issue ID */
  issueId: number;
  /** Issue title */
  title: string;
  /** Queue label */
  label: QueueLabel;
  /** Whether this task is currently active */
  active: boolean;
}

/** A track of tasks for a specific role within a project */
interface ProjectTrack {
  /** Track name */
  name: string;
  /** Role for this track */
  role: Role;
  /** Tasks in this track */
  tasks: SequencedTask[];
}

/** Execution configuration for a project */
interface ProjectExecutionConfig {
  name: string;
  groupId: string;
  roleExecution: "parallel" | "sequential";
  devActive: boolean;
  qaActive: boolean;
  devIssueId: string | null;
  qaIssueId: string | null;
}

/** Task sequence for a project in parallel mode */
interface ProjectTaskSequence {
  projectId: string;
  projectName: string;
  roleExecution: "parallel" | "sequential";
  /** For sequential: single track, for parallel: multiple tracks */
  tracks: ProjectTrack[];
}

/** Global task sequence for sequential mode */
interface GlobalTaskSequence {
  mode: "sequential";
  /** Interleaved tasks across all projects */
  tasks: SequencedTask[];
}

/** Project queues cache entry */
interface ProjectQueues {
  projectId: string;
  project: Project;
  queues: Record<QueueLabel, Issue[]>;
}

/** Result structure for the enhanced queue status */
interface QueueStatusResult {
  execution: {
    plugin: {
      projectExecution: "parallel" | "sequential";
    };
    projects: ProjectExecutionConfig[];
  };
  sequences: {
    mode: "parallel" | "sequential";
    /** For sequential mode: global task list */
    global?: GlobalTaskSequence;
    /** For parallel mode: per-project tracks */
    projects?: ProjectTaskSequence[];
  };
  projects: Array<{
    name: string;
    groupId: string;
    dev: {
      active: boolean;
      issueId: string | null;
      model: string | null;
      sessions: Record<string, string | null>;
    };
    qa: {
      active: boolean;
      issueId: string | null;
      model: string | null;
      sessions: Record<string, string | null>;
    };
    queue: {
      toImprove: Array<{ id: number; title: string; priority: number }>;
      toTest: Array<{ id: number; title: string; priority: number }>;
      toDo: Array<{ id: number; title: string; priority: number }>;
    };
  }>;
  context: {
    type: string;
    projectName?: string;
    autoFiltered?: boolean;
  };
  contextGuidance: string;
}

/** Build task priority score (higher = more urgent) */
function getTaskPriority(label: QueueLabel, issue: Issue): number {
  const basePriority = QUEUE_PRIORITY[label] * 10000;
  // Secondary sort by creation date (older = higher priority)
  // Use issue ID as proxy for creation order (lower ID = older)
  return basePriority - issue.iid;
}

/** Determine role based on queue label */
function getRoleForLabel(label: QueueLabel): Role {
  switch (label) {
    case "To Do":
    case "To Improve":
      return "dev";
    case "To Test":
      return "qa";
    default:
      return "dev";
  }
}

/** Fetch and sort all queueable issues for a project */
async function fetchProjectQueues(
  project: Project,
): Promise<Record<QueueLabel, Issue[]>> {
  const { provider } = createProvider({
    repo: project.repo,
  });

  const queueLabels: QueueLabel[] = ["To Improve", "To Test", "To Do"];
  const queues: Record<QueueLabel, Issue[]> = {
    "To Improve": [],
    "To Test": [],
    "To Do": [],
  };

  for (const label of queueLabels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      // Sort by priority (higher first) then by ID (lower first = older first)
      queues[label] = issues.sort((a, b) => {
        const priorityA = getTaskPriority(label, a);
        const priorityB = getTaskPriority(label, b);
        return priorityB - priorityA;
      });
    } catch {
      queues[label] = [];
    }
  }

  return queues;
}

/** Build a project track for a specific role */
function buildProjectTrack(
  projectId: string,
  projectName: string,
  role: Role,
  queues: Record<QueueLabel, Issue[]>,
  isActive: boolean,
  activeIssueId: string | null,
  startingSequence: number,
): { track: ProjectTrack; nextSequence: number } {
  const tasks: SequencedTask[] = [];
  let sequence = startingSequence;

  // Helper to add tasks from a queue for this role
  const addTasksFromQueue = (label: QueueLabel, issues: Issue[]) => {
    // Only add tasks that match this role
    if (getRoleForLabel(label) !== role) return;

    for (const issue of issues) {
      const taskActive = isActive && activeIssueId === String(issue.iid);
      tasks.push({
        sequence: sequence++,
        projectId,
        projectName,
        role,
        issueId: issue.iid,
        title: issue.title,
        label,
        active: taskActive,
      });
    }
  };

  // Add in priority order
  addTasksFromQueue("To Improve", queues["To Improve"]);
  addTasksFromQueue("To Test", queues["To Test"]);
  addTasksFromQueue("To Do", queues["To Do"]);

  return {
    track: {
      name: role === "dev" ? "DEV Track" : "QA Track",
      role,
      tasks,
    },
    nextSequence: sequence,
  };
}

/** Build project sequences for parallel mode */
function buildParallelProjectSequences(
  projectQueues: ProjectQueues[],
): ProjectTaskSequence[] {
  const sequences: ProjectTaskSequence[] = [];

  for (const { projectId, project, queues } of projectQueues) {
    const roleExecution = project.roleExecution ?? "parallel";
    const tracks: ProjectTrack[] = [];

    if (roleExecution === "sequential") {
      // Sequential within project: show alternating DEV/QA sequence
      const devActive = project.dev.active;
      const qaActive = project.qa.active;
      const alternatingTasks: SequencedTask[] = [];
      let sequence = 1;

      // Get next task for each role
      const getNextTaskForRole = (role: Role): SequencedTask | null => {
        for (const label of ["To Improve", "To Test", "To Do"] as QueueLabel[]) {
          if (getRoleForLabel(label) !== role) continue;
          const issues = queues[label];
          for (const issue of issues) {
            // Check if already added
            if (alternatingTasks.some((t) => t.issueId === issue.iid)) continue;
            const isActive =
              (role === "dev" && devActive && project.dev.issueId === String(issue.iid)) ||
              (role === "qa" && qaActive && project.qa.issueId === String(issue.iid));
            return {
              sequence: 0, // Will be set later
              projectId,
              projectName: project.name,
              role,
              issueId: issue.iid,
              title: issue.title,
              label,
              active: isActive,
            };
          }
        }
        return null;
      };

      // Build alternating sequence
      let lastRole: Role | null = null;
      if (devActive && !qaActive) lastRole = "dev";
      else if (qaActive && !devActive) lastRole = "qa";

      // Add active task first if any
      if (devActive && project.dev.issueId) {
        const activeDevTask = getNextTaskForRole("dev");
        if (activeDevTask) {
          activeDevTask.sequence = sequence++;
          activeDevTask.active = true;
          alternatingTasks.push(activeDevTask);
        }
      } else if (qaActive && project.qa.issueId) {
        const activeQaTask = getNextTaskForRole("qa");
        if (activeQaTask) {
          activeQaTask.sequence = sequence++;
          activeQaTask.active = true;
          alternatingTasks.push(activeQaTask);
        }
      }

      // Build future alternating sequence
      while (true) {
        const nextRole: Role = lastRole === "dev" ? "qa" : "dev";
        const task = getNextTaskForRole(nextRole);
        if (!task) break;
        task.sequence = sequence++;
        alternatingTasks.push(task);
        lastRole = nextRole;
      }

      if (alternatingTasks.length > 0) {
        tracks.push({
          name: "DEV/QA Alternating",
          role: "dev", // Mixed track
          tasks: alternatingTasks,
        });
      }
    } else {
      // Parallel within project: separate tracks for DEV and QA
      const devTrack = buildProjectTrack(
        projectId,
        project.name,
        "dev",
        queues,
        project.dev.active,
        project.dev.issueId,
        1,
      );
      const qaTrack = buildProjectTrack(
        projectId,
        project.name,
        "qa",
        queues,
        project.qa.active,
        project.qa.issueId,
        1,
      );

      if (devTrack.track.tasks.length > 0) {
        tracks.push(devTrack.track);
      }
      if (qaTrack.track.tasks.length > 0) {
        tracks.push(qaTrack.track);
      }
    }

    sequences.push({
      projectId,
      projectName: project.name,
      roleExecution,
      tracks,
    });
  }

  return sequences;
}

/** Build global task sequence for sequential mode */
function buildGlobalTaskSequence(
  projectQueues: ProjectQueues[],
): GlobalTaskSequence {
  const allTasks: Array<{
    projectId: string;
    projectName: string;
    role: Role;
    label: QueueLabel;
    issue: Issue;
    priority: number;
  }> = [];

  // Collect all tasks from all projects
  for (const { projectId, project, queues } of projectQueues) {
    for (const label of ["To Improve", "To Test", "To Do"] as QueueLabel[]) {
      for (const issue of queues[label]) {
        allTasks.push({
          projectId,
          projectName: project.name,
          role: getRoleForLabel(label),
          label,
          issue,
          priority: getTaskPriority(label, issue),
        });
      }
    }
  }

  // Sort by priority (higher first), then by project order, then by ID
  allTasks.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.issue.iid - b.issue.iid;
  });

  // For global sequential mode, we need to interleave based on active workers
  // Find which project has an active worker
  const activeProject = projectQueues.find(
    ({ project }) => project.dev.active || project.qa.active,
  );

  const sequencedTasks: SequencedTask[] = [];
  let sequence = 1;

  if (activeProject) {
    // If there's an active project, start with its active task
    const { project, projectId } = activeProject;
    if (project.dev.active && project.dev.issueId) {
      const task = allTasks.find(
        (t) =>
          t.projectId === projectId &&
          t.role === "dev" &&
          String(t.issue.iid) === project.dev.issueId,
      );
      if (task) {
        sequencedTasks.push({
          sequence: sequence++,
          projectId: task.projectId,
          projectName: task.projectName,
          role: task.role,
          issueId: task.issue.iid,
          title: task.issue.title,
          label: task.label,
          active: true,
        });
      }
    } else if (project.qa.active && project.qa.issueId) {
      const task = allTasks.find(
        (t) =>
          t.projectId === projectId &&
          t.role === "qa" &&
          String(t.issue.iid) === project.qa.issueId,
      );
      if (task) {
        sequencedTasks.push({
          sequence: sequence++,
          projectId: task.projectId,
          projectName: task.projectName,
          role: task.role,
          issueId: task.issue.iid,
          title: task.issue.title,
          label: task.label,
          active: true,
        });
      }
    }
  }

  // Add remaining tasks in priority order
  for (const task of allTasks) {
    // Skip if already added
    if (
      sequencedTasks.some(
        (t) => t.projectId === task.projectId && t.issueId === task.issue.iid,
      )
    ) {
      continue;
    }
    sequencedTasks.push({
      sequence: sequence++,
      projectId: task.projectId,
      projectName: task.projectName,
      role: task.role,
      issueId: task.issue.iid,
      title: task.issue.title,
      label: task.label,
      active: false,
    });
  }

  return {
    mode: "sequential",
    tasks: sequencedTasks,
  };
}

/** Convert project queues to the output format */
function formatProjectQueues(
  queues: Record<QueueLabel, Issue[]>,
): QueueStatusResult["projects"][0]["queue"] {
  return {
    toImprove: queues["To Improve"].map((i) => ({
      id: i.iid,
      title: i.title,
      priority: QUEUE_PRIORITY["To Improve"],
    })),
    toTest: queues["To Test"].map((i) => ({
      id: i.iid,
      title: i.title,
      priority: QUEUE_PRIORITY["To Test"],
    })),
    toDo: queues["To Do"].map((i) => ({
      id: i.iid,
      title: i.title,
      priority: QUEUE_PRIORITY["To Do"],
    })),
  };
}

export function createQueueStatusTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "queue_status",
    label: "Queue Status",
    description: `Show task queue and worker status with execution-aware task sequencing. Context-aware: In group chats, auto-filters to that project. In direct messages, shows all projects. Best for status checks, not during setup.`,
    parameters: {
      type: "object",
      properties: {
        projectGroupId: {
          type: "string",
          description: "Specific project group ID to check. Omit to check all projects.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
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

      // If via another agent (setup mode), suggest devclaw_onboard instead
      if (context.type === "via-agent") {
        return jsonResult({
          success: false,
          warning: "queue_status is for operational use, not setup.",
          recommendation: "If you're setting up DevClaw, use devclaw_onboard instead.",
          contextGuidance: generateGuardrails(context),
        });
      }

      // Auto-filter to current project in group context
      let groupId = params.projectGroupId as string | undefined;
      if (context.type === "group" && !groupId) {
        groupId = context.groupId;
      }

      // Get plugin-level execution setting
      const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
      const projectExecution = (pluginConfig?.projectExecution as "parallel" | "sequential") ?? "parallel";

      const data = await readProjects(workspaceDir);
      const projectIds = groupId
        ? [groupId]
        : Object.keys(data.projects);

      // Build execution configs and fetch all project data
      const executionConfigs: ProjectExecutionConfig[] = [];
      const projectList: Array<{ id: string; project: Project }> = [];

      for (const pid of projectIds) {
        const project = getProject(data, pid);
        if (!project) continue;

        projectList.push({ id: pid, project });
        executionConfigs.push({
          name: project.name,
          groupId: pid,
          roleExecution: project.roleExecution ?? "parallel",
          devActive: project.dev.active,
          qaActive: project.qa.active,
          devIssueId: project.dev.issueId,
          qaIssueId: project.qa.issueId,
        });
      }

      // Fetch all queues in parallel
      const projectQueues: ProjectQueues[] = await Promise.all(
        projectList.map(async ({ id, project }) => ({
          projectId: id,
          project,
          queues: await fetchProjectQueues(project),
        })),
      );

      // Build sequences based on execution mode
      let sequences: QueueStatusResult["sequences"];

      if (projectExecution === "sequential") {
        const globalSequence = buildGlobalTaskSequence(projectQueues);
        sequences = {
          mode: "sequential",
          global: globalSequence,
        };
      } else {
        const projectSequences = buildParallelProjectSequences(projectQueues);
        sequences = {
          mode: "parallel",
          projects: projectSequences,
        };
      }

      // Build project details with queues
      const projects: QueueStatusResult["projects"] = projectQueues.map(
        ({ projectId, project, queues }) => ({
          name: project.name,
          groupId: projectId,
          dev: {
            active: project.dev.active,
            issueId: project.dev.issueId,
            model: project.dev.model,
            sessions: project.dev.sessions,
          },
          qa: {
            active: project.qa.active,
            issueId: project.qa.issueId,
            model: project.qa.model,
            sessions: project.qa.sessions,
          },
          queue: formatProjectQueues(queues),
        }),
      );

      // Audit log
      await auditLog(workspaceDir, "queue_status", {
        projectCount: projects.length,
        totalToImprove: projects.reduce(
          (sum, p) => sum + p.queue.toImprove.length,
          0,
        ),
        totalToTest: projects.reduce(
          (sum, p) => sum + p.queue.toTest.length,
          0,
        ),
        totalToDo: projects.reduce(
          (sum, p) => sum + p.queue.toDo.length,
          0,
        ),
        projectExecution,
      });

      const result: QueueStatusResult = {
        execution: {
          plugin: {
            projectExecution,
          },
          projects: executionConfigs,
        },
        sequences,
        projects,
        context: {
          type: context.type,
          ...(context.type === "group" && {
            projectName: context.projectName,
            autoFiltered: !params.projectGroupId,
          }),
        },
        contextGuidance: generateGuardrails(context),
      };

      return jsonResult(result);
    },
  });
}
