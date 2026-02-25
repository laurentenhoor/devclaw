/**
 * model-fetcher.ts — Shared helper for fetching OpenClaw models.
 *
 * Uses the plugin SDK's runCommand to run openclaw CLI commands.
 */
import type { RunCommand } from "../context.js";

export type OpenClawModelRow = {
  key: string;
  name?: string;
  input: string;
  contextWindow: number | null;
  local: boolean;
  available: boolean;
  tags: string[];
  missing?: boolean;
};

/**
 * Fetch all models from OpenClaw.
 *
 * @param allModels - If true, fetches all models (--all flag). If false, only authenticated models.
 * @returns Array of model objects from OpenClaw's model registry
 */
export async function fetchModels(allModels = true, runCommand: RunCommand): Promise<OpenClawModelRow[]> {
  const rc = runCommand;
  try {
    const args = allModels
      ? ["openclaw", "models", "list", "--all", "--json"]
      : ["openclaw", "models", "list", "--json"];

    const result = await rc(args, { timeoutMs: 10_000 });
    const output = result.stdout.trim();

    if (!output) {
      throw new Error("Empty output from openclaw models list");
    }

    // Parse JSON (skip any log lines like "[plugins] ...")
    const lines = output.split("\n");

    // Find the first line that starts with { (the beginning of JSON)
    const jsonStartIndex = lines.findIndex((line: string) => {
      const trimmed = line.trim();
      return trimmed.startsWith("{");
    });

    if (jsonStartIndex === -1) {
      throw new Error(
        `No JSON object found in output. Got: ${output.substring(0, 200)}...`,
      );
    }

    // Join all lines from the JSON start to the end
    const jsonString = lines.slice(jsonStartIndex).join("\n");

    const data = JSON.parse(jsonString);
    const models = data.models as OpenClawModelRow[];

    if (!Array.isArray(models)) {
      throw new Error(`Expected array of models, got: ${typeof models}`);
    }

    return models;
  } catch (err) {
    throw new Error(`Failed to fetch models: ${(err as Error).message}`);
  }
}

/**
 * Parse JSON from CLI output, skipping any log/plugin lines.
 */
function parseJsonFromOutput(output: string): unknown {
  const lines = output.split("\n");
  const jsonStartIndex = lines.findIndex((line: string) => {
    const trimmed = line.trim();
    return trimmed.startsWith("{");
  });
  if (jsonStartIndex === -1) return null;
  return JSON.parse(lines.slice(jsonStartIndex).join("\n"));
}

type ModelStatus = {
  auth?: {
    providers?: Array<{ provider: string }>;
  };
};

/**
 * Fetch model status from `openclaw models status --json`.
 * Returns the default model and authenticated providers.
 */
async function fetchModelStatus(runCommand: RunCommand): Promise<ModelStatus> {
  const rc = runCommand;
  try {
    const result = await rc(
      ["openclaw", "models", "status", "--json"],
      { timeoutMs: 10_000 },
    );
    return (parseJsonFromOutput(result.stdout.trim()) as ModelStatus) ?? {};
  } catch {
    return {};
  }
}

/**
 * Fetch only authenticated models.
 *
 * Uses `openclaw models status --json` as the source of truth for the
 * configured default model and authenticated providers.
 */
export async function fetchAuthenticatedModels(runCommand: RunCommand): Promise<OpenClawModelRow[]> {
  const [allModels, status] = await Promise.all([
    fetchModels(true, runCommand),
    fetchModelStatus(runCommand),
  ]);

  const authProviders = new Set(
    status.auth?.providers?.map((p) => p.provider) ?? [],
  );

  if (authProviders.size === 0) {
    return [];
  }

  return allModels.filter((m) => {
    const provider = m.key.split("/")[0];
    return provider && authProviders.has(provider);
  });
}
