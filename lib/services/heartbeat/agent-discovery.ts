/**
 * Agent discovery — scan workspaces to find active DevClaw agents.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../setup/migrate-layout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Agent = {
  agentId: string;
  workspace: string;
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover DevClaw agents by scanning which agent workspaces have projects.
 * Self-discovering: any agent whose workspace contains projects.json is processed.
 * Also checks the default workspace (agents.defaults.workspace) for projects.
 */
export function discoverAgents(config: {
  agents?: {
    list?: Array<{ id: string; workspace?: string }>;
    defaults?: { workspace?: string };
  };
}): Agent[] {
  const seen = new Set<string>();
  const agents: Agent[] = [];

  // Check explicit agent list
  for (const a of config.agents?.list || []) {
    if (!a.workspace) continue;
    try {
      if (hasProjects(a.workspace)) {
        agents.push({ agentId: a.id, workspace: a.workspace });
        seen.add(a.workspace);
      }
    } catch {
      /* skip */
    }
  }

  // Check default workspace (used when no explicit agents are registered)
  const defaultWorkspace = config.agents?.defaults?.workspace;
  if (defaultWorkspace && !seen.has(defaultWorkspace)) {
    try {
      if (hasProjects(defaultWorkspace)) {
        agents.push({ agentId: "main", workspace: defaultWorkspace });
      }
    } catch {
      /* skip */
    }
  }

  return agents;
}

/** Check if a workspace has a projects.json (new or old locations). */
export function hasProjects(workspace: string): boolean {
  return (
    fs.existsSync(path.join(workspace, DATA_DIR, "projects.json")) ||
    fs.existsSync(path.join(workspace, "projects.json")) ||
    fs.existsSync(path.join(workspace, "projects", "projects.json"))
  );
}
