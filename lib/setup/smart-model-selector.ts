/**
 * smart-model-selector.ts — LLM-powered model selection for DevClaw roles.
 *
 * Uses an LLM to intelligently analyze and assign models to DevClaw roles.
 */
import { getAllRoleIds, getLevelsForRole } from "../roles/index.js";
import { ROLE_REGISTRY } from "../roles/index.js";
import { runCommand } from "../run-command.js";

/** Model assignment: role → level → model ID. Derived from registry structure. */
export type ModelAssignment = Record<string, Record<string, string>>;

/**
 * Build a ModelAssignment where every role/level maps to the same model.
 */
function singleModelAssignment(model: string): ModelAssignment {
  const result: ModelAssignment = {};
  for (const [roleId, config] of Object.entries(ROLE_REGISTRY)) {
    result[roleId] = {};
    for (const level of config.levels) {
      result[roleId][level] = model;
    }
  }
  return result;
}

/**
 * Assign available models to DevClaw roles.
 *
 * Strategy:
 * 1. If 0 models → return null (setup should be blocked)
 * 2. If 1 model → assign it to all roles
 * 3. If multiple → LLM selection, falling back to registry defaults
 */
export async function assignModels(
  availableModels: Array<{
    model: string;
    provider: string;
    authenticated: boolean;
  }>,
  sessionKey?: string,
): Promise<ModelAssignment | null> {
  const authenticated = availableModels.filter((m) => m.authenticated);

  if (authenticated.length === 0) {
    return null;
  }

  if (authenticated.length === 1) {
    return singleModelAssignment(authenticated[0].model);
  }

  // Multiple models: try LLM, fall back to registry defaults
  try {
    const { selectModelsWithLLM } = await import("./llm-model-selector.js");
    const llmResult = await selectModelsWithLLM(authenticated, sessionKey, runCommand);
    if (llmResult) return llmResult;
  } catch (err) {
    console.warn("LLM model selection failed, using registry defaults:", (err as Error).message);
  }

  // Heuristic fallback: use registry defaults if they're in the authenticated set
  const modelSet = new Set(authenticated.map((m) => m.model));
  const result: ModelAssignment = {};
  const fallback = authenticated[0].model;

  for (const [roleId, config] of Object.entries(ROLE_REGISTRY)) {
    result[roleId] = {};
    for (const level of config.levels) {
      const registryDefault = config.models[level];
      result[roleId][level] = registryDefault && modelSet.has(registryDefault)
        ? registryDefault
        : fallback;
    }
  }

  return result;
}

/**
 * Format model assignment as a readable table.
 */
export function formatAssignment(assignment: ModelAssignment): string {
  const lines = [
    "| Role      | Level    | Model                    |",
    "|-----------|----------|--------------------------|",
  ];
  for (const roleId of getAllRoleIds()) {
    const roleModels = assignment[roleId];
    if (!roleModels) continue;
    const displayName =
      ROLE_REGISTRY[roleId]?.displayName ?? roleId.toUpperCase();
    for (const level of getLevelsForRole(roleId)) {
      const model = roleModels[level] ?? "";
      lines.push(
        `| ${displayName.padEnd(9)} | ${level.padEnd(8)} | ${model.padEnd(24)} |`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Generate setup instructions when no models are available.
 */
export function generateSetupInstructions(): string {
  return `❌ No authenticated models found. DevClaw needs at least one model to work.

To configure model authentication:

**For Anthropic Claude:**
  export ANTHROPIC_API_KEY=your-api-key
  # or: openclaw auth add --provider anthropic

**For OpenAI:**
  export OPENAI_API_KEY=your-api-key
  # or: openclaw auth add --provider openai

**For other providers:**
  openclaw auth add --provider <provider>

**Verify authentication:**
  openclaw models list
  (Look for "Auth: yes" in the output)

Once you see authenticated models, re-run: onboard`;
}
