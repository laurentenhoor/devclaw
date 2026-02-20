/**
 * HTTP handler for DevClaw UI dashboard.
 * Routes /devclaw-ui/* requests to the appropriate page or API endpoint.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { generateDashboardPage } from "./dashboard.js";
import { generateSessionPage } from "./session.js";
import { generateDiffPage } from "./diff.js";
import { handleApiRequest } from "./api.js";

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

/**
 * Resolve workspace directory from the plugin API config.
 * Uses the same discovery logic as the heartbeat service.
 */
function resolveWorkspaceDir(api: any): string {
  // Try explicit agent list first
  const agents = api.config?.agents?.list || [];
  for (const a of agents) {
    if (a.workspace) return a.workspace;
  }
  // Try default workspace
  if (api.config?.agents?.defaults?.workspace) {
    return api.config.agents.defaults.workspace;
  }
  // Fallback
  return process.env.OPENCLAW_WORKSPACE ?? process.cwd();
}

export function createUiHandler(api: any) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (!pathname.startsWith("/devclaw-ui")) return false;

    const workspaceDir = resolveWorkspaceDir(api);

    // API routes
    if (pathname.startsWith("/devclaw-ui/api/")) {
      return handleApiRequest(req, res, pathname, workspaceDir);
    }

    // Dashboard
    if (pathname === "/devclaw-ui" || pathname === "/devclaw-ui/") {
      html(res, generateDashboardPage());
      return true;
    }

    // Session inspector: /devclaw-ui/session/:key
    const sessionMatch = pathname.match(/^\/devclaw-ui\/session\/(.+)$/);
    if (sessionMatch) {
      html(res, generateSessionPage(decodeURIComponent(sessionMatch[1])));
      return true;
    }

    // Diff explorer: /devclaw-ui/diff/:project/:issueId
    const diffMatch = pathname.match(/^\/devclaw-ui\/diff\/([^/]+)\/(\d+)$/);
    if (diffMatch) {
      html(res, generateDiffPage(diffMatch[1], Number(diffMatch[2])));
      return true;
    }

    // 404
    html(res, `<!DOCTYPE html><html><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;padding:40px;text-align:center"><h1>404</h1><p>Page not found</p><a href="/devclaw-ui/" style="color:#58a6ff">← Dashboard</a></body></html>`, 404);
    return true;
  };
}
