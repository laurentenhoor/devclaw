/**
 * model-fetcher.ts — Shared helper for fetching OpenClaw models.
 *
 * Uses the plugin SDK's runCommand to run openclaw CLI commands.
 */
import { runCommand } from "../run-command.js";

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
export async function fetchModels(allModels = true): Promise<OpenClawModelRow[]> {
  try {
    const args = allModels
      ? ["openclaw", "models", "list", "--all", "--json"]
      : ["openclaw", "models", "list", "--json"];

    const result = await runCommand(args, { timeoutMs: 10_000 });
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

/**
 * Get the set of provider names that have auth configured,
 * using `openclaw models status --json` which correctly reads auth profiles.
 */
async function getAuthenticatedProviders(): Promise<Set<string>> {
  try {
    const result = await runCommand(
      ["openclaw", "models", "status", "--json"],
      { timeoutMs: 10_000 },
    );
    const data = parseJsonFromOutput(result.stdout.trim()) as {
      auth?: {
        providers?: Array<{ provider: string }>;
      };
    } | null;

    const providers = new Set<string>();
    if (data?.auth?.providers) {
      for (const p of data.auth.providers) {
        providers.add(p.provider);
      }
    }
    return providers;
  } catch {
    return new Set();
  }
}

/**
 * Fetch only authenticated models.
 *
 * Uses `openclaw models status --json` to discover which providers have
 * auth configured, then returns all models from those providers.
 */
export async function fetchAuthenticatedModels(): Promise<OpenClawModelRow[]> {
  const [allModels, authProviders] = await Promise.all([
    fetchModels(true),
    getAuthenticatedProviders(),
  ]);

  if (authProviders.size === 0) {
    return [];
  }

  return allModels.filter((m) => {
    const provider = m.key.split("/")[0];
    return provider && authProviders.has(provider);
  });
}
