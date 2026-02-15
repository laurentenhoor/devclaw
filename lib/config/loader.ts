/**
 * config/loader.ts — Three-layer config loading.
 *
 * Resolution order:
 *   1. Built-in defaults (ROLE_REGISTRY + DEFAULT_WORKFLOW)
 *   2. Workspace: <workspace>/devclaw/workflow.yaml
 *   3. Project:   <workspace>/devclaw/projects/<project>/workflow.yaml
 *
 * Also supports legacy config.yaml and workflow.json for backward compat.
 */
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ROLE_REGISTRY } from "../roles/registry.js";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../workflow.js";
import { mergeConfig } from "./merge.js";
import type { DevClawConfig, ResolvedConfig, ResolvedRoleConfig, RoleOverride } from "./types.js";
import { DATA_DIR } from "../setup/migrate-layout.js";

/**
 * Load and resolve the full DevClaw config for a project.
 *
 * Merges: built-in → workspace workflow.yaml → project workflow.yaml.
 */
export async function loadConfig(
  workspaceDir: string,
  projectName?: string,
): Promise<ResolvedConfig> {
  const dataDir = path.join(workspaceDir, DATA_DIR);
  const projectsDir = path.join(dataDir, "projects");

  // Layer 1: built-in defaults
  const builtIn = buildDefaultConfig();

  // Layer 2: workspace workflow.yaml (in devclaw/ data dir)
  let merged = builtIn;
  const workspaceConfig =
    await readWorkflowFile(dataDir) ??
    await readLegacyConfigFile(path.join(workspaceDir, "projects"));
  if (workspaceConfig) {
    merged = mergeConfig(merged, workspaceConfig);
  }

  // Legacy: standalone workflow.json (only if no workflow section found)
  if (!workspaceConfig?.workflow) {
    const legacyWorkflow = await readLegacyWorkflowJson(projectsDir);
    if (legacyWorkflow) {
      merged = mergeConfig(merged, { workflow: legacyWorkflow });
    }
  }

  // Layer 3: project workflow.yaml
  if (projectName) {
    const projectDir = path.join(projectsDir, projectName);
    const projectConfig =
      await readWorkflowFile(projectDir) ??
      await readLegacyConfigFile(projectDir);
    if (projectConfig) {
      merged = mergeConfig(merged, projectConfig);
    }

    if (!projectConfig?.workflow) {
      const legacyWorkflow = await readLegacyWorkflowJson(projectDir);
      if (legacyWorkflow) {
        merged = mergeConfig(merged, { workflow: legacyWorkflow });
      }
    }
  }

  return resolve(merged);
}

/**
 * Build the default config from the built-in ROLE_REGISTRY and DEFAULT_WORKFLOW.
 */
function buildDefaultConfig(): DevClawConfig {
  const roles: Record<string, RoleOverride> = {};
  for (const [id, reg] of Object.entries(ROLE_REGISTRY)) {
    roles[id] = {
      levels: [...reg.levels],
      defaultLevel: reg.defaultLevel,
      models: { ...reg.models },
      emoji: { ...reg.emoji },
      completionResults: [...reg.completionResults],
    };
  }
  return { roles, workflow: DEFAULT_WORKFLOW };
}

/**
 * Resolve a merged DevClawConfig into a fully-typed ResolvedConfig.
 */
function resolve(config: DevClawConfig): ResolvedConfig {
  const roles: Record<string, ResolvedRoleConfig> = {};

  if (config.roles) {
    for (const [id, override] of Object.entries(config.roles)) {
      if (override === false) {
        // Disabled role — include with enabled: false for visibility
        const reg = ROLE_REGISTRY[id];
        roles[id] = {
          levels: reg ? [...reg.levels] : [],
          defaultLevel: reg?.defaultLevel ?? "",
          models: reg ? { ...reg.models } : {},
          emoji: reg ? { ...reg.emoji } : {},
          completionResults: reg ? [...reg.completionResults] : [],
          enabled: false,
        };
        continue;
      }

      const reg = ROLE_REGISTRY[id];
      roles[id] = {
        levels: override.levels ?? (reg ? [...reg.levels] : []),
        defaultLevel: override.defaultLevel ?? reg?.defaultLevel ?? "",
        models: { ...(reg?.models ?? {}), ...(override.models ?? {}) },
        emoji: { ...(reg?.emoji ?? {}), ...(override.emoji ?? {}) },
        completionResults: override.completionResults ?? (reg ? [...reg.completionResults] : []),
        enabled: true,
      };
    }
  }

  // Ensure all built-in roles exist even if not in config
  for (const [id, reg] of Object.entries(ROLE_REGISTRY)) {
    if (!roles[id]) {
      roles[id] = {
        levels: [...reg.levels],
        defaultLevel: reg.defaultLevel,
        models: { ...reg.models },
        emoji: { ...reg.emoji },
        completionResults: [...reg.completionResults],
        enabled: true,
      };
    }
  }

  const workflow: WorkflowConfig = {
    initial: config.workflow?.initial ?? DEFAULT_WORKFLOW.initial,
    states: { ...DEFAULT_WORKFLOW.states, ...config.workflow?.states },
  };

  return { roles, workflow };
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

/** Read workflow.yaml (new primary config file). */
async function readWorkflowFile(dir: string): Promise<DevClawConfig | null> {
  try {
    const content = await fs.readFile(path.join(dir, "workflow.yaml"), "utf-8");
    return YAML.parse(content) as DevClawConfig;
  } catch { /* not found */ }
  return null;
}

/** Read config.yaml (old name, fallback for unmigrated workspaces). */
async function readLegacyConfigFile(dir: string): Promise<DevClawConfig | null> {
  try {
    const content = await fs.readFile(path.join(dir, "config.yaml"), "utf-8");
    return YAML.parse(content) as DevClawConfig;
  } catch { /* not found */ }
  return null;
}

/** Read legacy workflow.json (standalone workflow section only). */
async function readLegacyWorkflowJson(dir: string): Promise<Partial<WorkflowConfig> | null> {
  try {
    const content = await fs.readFile(path.join(dir, "workflow.json"), "utf-8");
    const parsed = JSON.parse(content) as
      | Partial<WorkflowConfig>
      | { workflow?: Partial<WorkflowConfig> };
    return (parsed as any).workflow ?? parsed;
  } catch { /* not found */ }
  return null;
}
