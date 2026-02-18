/**
 * API endpoints for the DevClaw UI dashboard.
 * Returns JSON data for the dashboard, session inspector, and diff explorer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readProjects, resolveRepoPath } from "../projects.js";
import { fetchGatewaySessions } from "../services/gateway-sessions.js";
import { createProvider } from "../providers/index.js";
import type { Project, WorkerState } from "../projects.js";
import type { GatewaySession } from "../services/gateway-sessions.js";

export type DashboardProject = {
  slug: string;
  name: string;
  repo: string;
  baseBranch: string;
  provider?: string;
  workers: Record<string, WorkerState & { sessionData?: GatewaySession | null }>;
};

export type DashboardData = {
  projects: DashboardProject[];
  sessions: Record<string, GatewaySession>;
  queue: { toDo: number; toImprove: number; toReview: number; toTest: number };
  timestamp: number;
};

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, msg: string, status = 500): void {
  json(res, { error: msg }, status);
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  workspaceDir: string,
): Promise<boolean> {
  if (!pathname.startsWith("/devclaw-ui/api/")) return false;

  const route = pathname.slice("/devclaw-ui/api".length);

  try {
    if (route === "/status" && req.method === "GET") {
      return await handleStatus(res, workspaceDir);
    }

    // /diff/:project/:issueId
    const diffMatch = route.match(/^\/diff\/([^/]+)\/(\d+)$/);
    if (diffMatch && req.method === "GET") {
      return await handleDiff(res, workspaceDir, diffMatch[1], Number(diffMatch[2]));
    }

    error(res, "Not found", 404);
    return true;
  } catch (err) {
    error(res, (err as Error).message);
    return true;
  }
}

async function handleStatus(res: ServerResponse, workspaceDir: string): Promise<boolean> {
  const [projectsData, sessionLookup] = await Promise.all([
    readProjects(workspaceDir),
    fetchGatewaySessions(),
  ]);

  const sessions: Record<string, GatewaySession> = {};
  if (sessionLookup) {
    for (const [key, sess] of sessionLookup) {
      sessions[key] = sess;
    }
  }

  const queue = { toDo: 0, toImprove: 0, toReview: 0, toTest: 0 };
  const projects: DashboardProject[] = [];

  for (const [slug, project] of Object.entries(projectsData.projects)) {
    // Count queue items by querying the provider
    try {
      const { provider } = await createProvider({ repo: project.repo, provider: project.provider });
      const [todoIssues, improveIssues, reviewIssues, testIssues] = await Promise.all([
        provider.listIssuesByLabel("To Do").catch(() => []),
        provider.listIssuesByLabel("To Improve").catch(() => []),
        provider.listIssuesByLabel("To Review").catch(() => []),
        provider.listIssuesByLabel("To Test").catch(() => []),
      ]);
      queue.toDo += todoIssues.length;
      queue.toImprove += improveIssues.length;
      queue.toReview += reviewIssues.length;
      queue.toTest += testIssues.length;
    } catch {
      // Provider unavailable — skip queue count
    }

    const workers: DashboardProject["workers"] = {};
    for (const [role, worker] of Object.entries(project.workers)) {
      const sessionKey = worker.level ? worker.sessions[worker.level] : null;
      workers[role] = {
        ...worker,
        sessionData: sessionKey && sessionLookup ? sessionLookup.get(sessionKey) ?? null : null,
      };
    }

    projects.push({
      slug,
      name: project.name ?? slug,
      repo: project.repo,
      baseBranch: project.baseBranch,
      provider: project.provider,
      workers,
    });
  }

  const data: DashboardData = { projects, sessions, queue, timestamp: Date.now() };
  json(res, data);
  return true;
}

async function handleDiff(
  res: ServerResponse,
  workspaceDir: string,
  projectSlug: string,
  issueId: number,
): Promise<boolean> {
  const projectsData = await readProjects(workspaceDir);
  const project = projectsData.projects[projectSlug];
  if (!project) {
    error(res, `Project not found: ${projectSlug}`, 404);
    return true;
  }

  const { provider } = await createProvider({ repo: project.repo, provider: project.provider });
  const diff = await provider.getPrDiff(issueId);

  if (diff === null) {
    error(res, `No PR found for issue #${issueId}`, 404);
    return true;
  }

  json(res, { diff, issueId, project: projectSlug });
  return true;
}
