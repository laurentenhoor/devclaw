/**
 * llm-model-selector.ts — LLM-powered intelligent model selection.
 *
 * Uses an LLM to understand model capabilities and assign optimal models to DevClaw roles.
 */
import type { RunCommand } from "../context.js";
import { ROLE_REGISTRY } from "./index.js";
import type { ModelAssignment } from "./smart-model-selector.js";

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
 * Build the JSON format example for the LLM prompt, derived from registry.
 */
function buildJsonExample(): string {
  const obj: Record<string, Record<string, string>> = {};
  for (const [roleId, config] of Object.entries(ROLE_REGISTRY)) {
    obj[roleId] = {};
    for (const level of config.levels) {
      obj[roleId][level] = "provider/model-name";
    }
  }
  return JSON.stringify(obj, null, 2);
}

/**
 * Validate that a parsed assignment has all required roles and levels.
 */
function validateAssignment(
  assignment: Record<string, unknown>,
  fallbackModel: string,
): ModelAssignment | null {
  const result: ModelAssignment = {};
  for (const [roleId, config] of Object.entries(ROLE_REGISTRY)) {
    const roleData = assignment[roleId] as Record<string, string> | undefined;
    if (!roleData) {
      // Backfill missing roles from the first available role or fallback
      result[roleId] = {};
      for (const level of config.levels) {
        result[roleId][level] = fallbackModel;
      }
      continue;
    }
    result[roleId] = {};
    for (const level of config.levels) {
      if (!roleData[level]) {
        console.error(`Missing ${roleId}.${level} in LLM assignment`);
        return null;
      }
      result[roleId][level] = roleData[level];
    }
  }
  return result;
}

/**
 * Use an LLM to intelligently select and assign models to DevClaw roles.
 */
export async function selectModelsWithLLM(
  availableModels: Array<{ model: string; provider: string }>,
  _sessionKey?: string,
  execCommand?: RunCommand,
): Promise<ModelAssignment | null> {
  if (availableModels.length === 0) {
    return null;
  }

  // If only one model, assign it to all roles
  if (availableModels.length === 1) {
    return singleModelAssignment(availableModels[0].model);
  }

  // Create a prompt for the LLM
  const modelList = availableModels.map((m) => m.model).join("\n");
  const jsonExample = buildJsonExample();

  const prompt = `You are an AI model expert. Analyze the following authenticated AI models and assign them to DevClaw development roles based on their capabilities.

Available models:
${modelList}

All roles use the same level scheme based on task complexity:
- **senior** (most capable): Complex architecture, refactoring, critical decisions
- **medior** (balanced): Features, bug fixes, code review, standard tasks
- **junior** (fast/efficient): Simple fixes, routine tasks

Rules:
1. Prefer same provider for consistency
2. Assign most capable model to senior
3. Assign mid-tier model to medior
4. Assign fastest/cheapest model to junior
5. Consider model version numbers (higher = newer/better)
6. Stable versions (no date) > snapshot versions (with date like 20250514)

Return ONLY a JSON object in this exact format (no markdown, no explanation):
${jsonExample}`;

  try {
    const sessionId = "devclaw-model-selection";

    if (!execCommand) {
      throw new Error("execCommand is required for LLM model selection");
    }

    const result = await execCommand(
      [
        "openclaw",
        "agent",
        "--session-id",
        sessionId,
        "--message",
        prompt,
        "--json",
      ],
      { timeoutMs: 30_000 },
    );

    const output = result.stdout.trim();

    // Parse the response from openclaw agent --json
    const lines = output.split("\n");
    const jsonStartIndex = lines.findIndex((line) =>
      line.trim().startsWith("{"),
    );

    if (jsonStartIndex === -1) {
      throw new Error("No JSON found in LLM response");
    }

    const jsonString = lines.slice(jsonStartIndex).join("\n");

    // openclaw agent --json returns: { result: { payloads: [{ text: "..." }] }, ... }
    const response = JSON.parse(jsonString);
    const payloads = response.result?.payloads ?? response.payloads;

    if (!Array.isArray(payloads) || payloads.length === 0) {
      throw new Error(
        "Invalid openclaw agent response structure - missing payloads",
      );
    }

    const textContent = payloads[0].text;
    if (!textContent) {
      throw new Error("Empty text content in openclaw agent payload");
    }

    // Strip markdown code blocks (```json and ```)
    const cleanJson = textContent
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    // Parse the actual model assignment JSON
    const assignment = JSON.parse(cleanJson);

    // Log what we got for debugging
    console.log("LLM returned:", JSON.stringify(assignment, null, 2));

    // Validate and backfill
    const validated = validateAssignment(assignment, availableModels[0].model);
    if (!validated) {
      console.error("Invalid assignment structure. Got:", assignment);
      throw new Error(
        `Invalid assignment structure from LLM. Missing fields in: ${JSON.stringify(Object.keys(assignment))}`,
      );
    }

    return validated;
  } catch (err) {
    console.error("LLM model selection failed:", (err as Error).message);
    return null;
  }
}
