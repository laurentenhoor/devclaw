/**
 * Queue service — task sequencing and priority logic.
 *
 * Pure functions for scanning issue queues, building execution sequences,
 * and formatting output. No tool registration or I/O concerns.
 */
import type { Issue } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import type { Project } from "../projects.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueLabel = "To Improve" | "To Test" | "To Do";
export type Role = "dev" | "qa";

export interface SequencedTask {
  sequence: number;
  projectId: string;
  projectName: string;
  role: Role;
  issueId: number;
  title: string;
  label: QueueLabel;
  active: boolean;
}

export interface ProjectTrack {
  name: string;
  role: Role;
  tasks: SequencedTask[];
}

export interface ProjectExecutionConfig {
  name: string;
  groupId: string;
  roleExecution: "parallel" | "sequential";
  devActive: boolean;
  qaActive: boolean;
  devIssueId: string | null;
  qaIssueId: string | null;
}

export interface ProjectTaskSequence {
  projectId: string;
  projectName: string;
  roleExecution: "parallel" | "sequential";
  tracks: ProjectTrack[];
}

export interface GlobalTaskSequence {
  mode: "sequential";
  tasks: SequencedTask[];
}

export interface ProjectQueues {
  projectId: string;
  project: Project;
  queues: Record<QueueLabel, Issue[]>;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

export const QUEUE_PRIORITY: Record<QueueLabel, number> = {
  "To Improve": 3,
  "To Test": 2,
  "To Do": 1,
};

export function getTaskPriority(label: QueueLabel, issue: Issue): number {
  return QUEUE_PRIORITY[label] * 10000 - issue.iid;
}

export function getRoleForLabel(label: QueueLabel): Role {
  return label === "To Test" ? "qa" : "dev";
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export async function fetchProjectQueues(project: Project): Promise<Record<QueueLabel, Issue[]>> {
  const { provider } = createProvider({ repo: project.repo });
  const labels: QueueLabel[] = ["To Improve", "To Test", "To Do"];
  const queues: Record<QueueLabel, Issue[]> = { "To Improve": [], "To Test": [], "To Do": [] };

  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      queues[label] = issues.sort((a, b) => getTaskPriority(label, b) - getTaskPriority(label, a));
    } catch {
      queues[label] = [];
    }
  }
  return queues;
}

// ---------------------------------------------------------------------------
// Track building
// ---------------------------------------------------------------------------

export function buildProjectTrack(
  projectId: string, projectName: string, role: Role,
  queues: Record<QueueLabel, Issue[]>,
  isActive: boolean, activeIssueId: string | null,
  startSeq: number,
): { track: ProjectTrack; nextSequence: number } {
  const tasks: SequencedTask[] = [];
  let seq = startSeq;

  for (const label of ["To Improve", "To Test", "To Do"] as QueueLabel[]) {
    if (getRoleForLabel(label) !== role) continue;
    for (const issue of queues[label]) {
      tasks.push({
        sequence: seq++, projectId, projectName, role,
        issueId: issue.iid, title: issue.title, label,
        active: isActive && activeIssueId === String(issue.iid),
      });
    }
  }

  return { track: { name: role === "dev" ? "DEV Track" : "QA Track", role, tasks }, nextSequence: seq };
}

// ---------------------------------------------------------------------------
// Sequence building
// ---------------------------------------------------------------------------

export function buildParallelProjectSequences(projectQueues: ProjectQueues[]): ProjectTaskSequence[] {
  return projectQueues.map(({ projectId, project, queues }) => {
    const roleExecution = project.roleExecution ?? "parallel";
    const tracks: ProjectTrack[] = [];

    if (roleExecution === "sequential") {
      // Build alternating DEV/QA sequence
      const alternating = buildAlternatingTrack(projectId, project, queues);
      if (alternating.tasks.length > 0) tracks.push(alternating);
    } else {
      const dev = buildProjectTrack(projectId, project.name, "dev", queues, project.dev.active, project.dev.issueId, 1);
      const qa = buildProjectTrack(projectId, project.name, "qa", queues, project.qa.active, project.qa.issueId, 1);
      if (dev.track.tasks.length > 0) tracks.push(dev.track);
      if (qa.track.tasks.length > 0) tracks.push(qa.track);
    }

    return { projectId, projectName: project.name, roleExecution, tracks };
  });
}

function buildAlternatingTrack(
  projectId: string, project: Project, queues: Record<QueueLabel, Issue[]>,
): ProjectTrack {
  const tasks: SequencedTask[] = [];
  const added = new Set<number>();
  let seq = 1;

  const nextForRole = (role: Role): SequencedTask | null => {
    for (const label of ["To Improve", "To Test", "To Do"] as QueueLabel[]) {
      if (getRoleForLabel(label) !== role) continue;
      for (const issue of queues[label]) {
        if (added.has(issue.iid)) continue;
        const isActive =
          (role === "dev" && project.dev.active && project.dev.issueId === String(issue.iid)) ||
          (role === "qa" && project.qa.active && project.qa.issueId === String(issue.iid));
        return { sequence: 0, projectId, projectName: project.name, role, issueId: issue.iid, title: issue.title, label, active: isActive };
      }
    }
    return null;
  };

  // Start with active task
  for (const role of ["dev", "qa"] as Role[]) {
    const w = project[role];
    if (w.active && w.issueId) {
      const t = nextForRole(role);
      if (t) { t.sequence = seq++; t.active = true; tasks.push(t); added.add(t.issueId); break; }
    }
  }

  // Alternate
  let lastRole: Role | null = tasks[0]?.role ?? null;
  while (true) {
    const next = nextForRole(lastRole === "dev" ? "qa" : "dev");
    if (!next) break;
    next.sequence = seq++;
    tasks.push(next);
    added.add(next.issueId);
    lastRole = next.role;
  }

  return { name: "DEV/QA Alternating", role: "dev", tasks };
}

export function buildGlobalTaskSequence(projectQueues: ProjectQueues[]): GlobalTaskSequence {
  const all: Array<{ projectId: string; projectName: string; role: Role; label: QueueLabel; issue: Issue; priority: number }> = [];

  for (const { projectId, project, queues } of projectQueues) {
    for (const label of ["To Improve", "To Test", "To Do"] as QueueLabel[]) {
      for (const issue of queues[label]) {
        all.push({ projectId, projectName: project.name, role: getRoleForLabel(label), label, issue, priority: getTaskPriority(label, issue) });
      }
    }
  }

  all.sort((a, b) => b.priority !== a.priority ? b.priority - a.priority : a.issue.iid - b.issue.iid);

  const tasks: SequencedTask[] = [];
  const added = new Set<string>();
  let seq = 1;

  // Active task first
  const active = projectQueues.find(({ project }) => project.dev.active || project.qa.active);
  if (active) {
    const { project, projectId } = active;
    for (const [role, w] of [["dev", project.dev], ["qa", project.qa]] as const) {
      if (w.active && w.issueId) {
        const t = all.find((t) => t.projectId === projectId && t.role === role && String(t.issue.iid) === w.issueId);
        if (t) {
          const key = `${t.projectId}:${t.issue.iid}`;
          tasks.push({ sequence: seq++, projectId: t.projectId, projectName: t.projectName, role: t.role, issueId: t.issue.iid, title: t.issue.title, label: t.label, active: true });
          added.add(key);
          break;
        }
      }
    }
  }

  for (const t of all) {
    const key = `${t.projectId}:${t.issue.iid}`;
    if (added.has(key)) continue;
    tasks.push({ sequence: seq++, projectId: t.projectId, projectName: t.projectName, role: t.role, issueId: t.issue.iid, title: t.issue.title, label: t.label, active: false });
    added.add(key);
  }

  return { mode: "sequential", tasks };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatProjectQueues(queues: Record<QueueLabel, Issue[]>) {
  const fmt = (label: QueueLabel) => queues[label].map((i) => ({ id: i.iid, title: i.title, priority: QUEUE_PRIORITY[label] }));
  return { toImprove: fmt("To Improve"), toTest: fmt("To Test"), toDo: fmt("To Do") };
}
