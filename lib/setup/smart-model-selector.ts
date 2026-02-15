/**
 * smart-model-selector.ts — LLM-powered model selection for DevClaw roles.
 *
 * Uses an LLM to intelligently analyze and assign models to DevClaw roles.
 */

export type ModelAssignment = {
  dev: {
    junior: string;
    mid: string;
    senior: string;
  };
  qa: {
    junior: string;
    mid: string;
    senior: string;
  };
  architect: {
    junior: string;
    senior: string;
  };
};

/**
 * Intelligently assign available models to DevClaw roles using an LLM.
 *
 * Strategy:
 * 1. If 0 models → return null (setup should be blocked)
 * 2. If 1 model → assign it to all roles
 * 3. If multiple models → use LLM to intelligently assign
 */
export async function assignModels(
  availableModels: Array<{ model: string; provider: string; authenticated: boolean }>,
  sessionKey?: string,
): Promise<ModelAssignment | null> {
  // Filter to only authenticated models
  const authenticated = availableModels.filter((m) => m.authenticated);

  if (authenticated.length === 0) {
    return null; // No models available - setup should be blocked
  }

  // If only one model, use it for everything
  if (authenticated.length === 1) {
    const model = authenticated[0].model;
    return {
      dev: { junior: model, mid: model, senior: model },
      qa: { junior: model, mid: model, senior: model },
      architect: { junior: model, senior: model },
    };
  }

  // Multiple models: use LLM-based selection
  const { selectModelsWithLLM } = await import("./llm-model-selector.js");
  const llmResult = await selectModelsWithLLM(authenticated, sessionKey);

  if (!llmResult) {
    throw new Error("LLM-based model selection failed. Please try again or configure models manually.");
  }

  return llmResult;
}

/**
 * Format model assignment as a readable table.
 */
export function formatAssignment(assignment: ModelAssignment): string {
  const lines = [
    "| Role | Level    | Model                    |",
    "|------|----------|--------------------------|",
    `| DEV  | senior   | ${assignment.dev.senior.padEnd(24)} |`,
    `| DEV  | mid      | ${assignment.dev.mid.padEnd(24)} |`,
    `| DEV  | junior   | ${assignment.dev.junior.padEnd(24)} |`,
    `| QA   | senior   | ${assignment.qa.senior.padEnd(24)} |`,
    `| QA   | mid      | ${assignment.qa.mid.padEnd(24)} |`,
    `| QA   | junior   | ${assignment.qa.junior.padEnd(24)} |`,
    `| ARCH | senior   | ${assignment.architect.senior.padEnd(24)} |`,
    `| ARCH | junior   | ${assignment.architect.junior.padEnd(24)} |`,
  ];
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
