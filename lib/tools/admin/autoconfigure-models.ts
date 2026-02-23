/**
 * autoconfigure-models.ts — Tool for automatically configuring model assignments.
 *
 * Queries available authenticated models and intelligently assigns them to DevClaw roles.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext, RunCommand } from "../../context.js";
import {
  assignModels,
  formatAssignment,
  generateSetupInstructions,
  type ModelAssignment,
} from "../../roles/smart-model-selector.js";
import { fetchAuthenticatedModels } from "../../roles/model-fetcher.js";

/**
 * Get available authenticated models from OpenClaw.
 */
async function getAuthenticatedModels(runCommand: RunCommand): Promise<Array<{ model: string; provider: string; authenticated: boolean }>> {
  try {
    const models = await fetchAuthenticatedModels(runCommand);

    // Map to the format expected by assignModels()
    return models.map((m) => {
      // Extract provider from key (format: provider/model-name)
      const provider = m.key.split("/")[0] || "unknown";
      return {
        model: m.key,
        provider,
        authenticated: true,
      };
    });
  } catch (err) {
    throw new Error(`Failed to get authenticated models: ${(err as Error).message}`);
  }
}

/**
 * Create the autoconfigure_models tool.
 */
export function createAutoConfigureModelsTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "autoconfigure_models",
    label: "Auto-Configure Models",
    description:
      "Automatically discover authenticated models and intelligently assign them to DevClaw roles based on capability tiers",
    parameters: {
      type: "object",
      properties: {
        preferProvider: {
          type: "string",
          description:
            "Optional: Prefer models from this provider (e.g., 'anthropic', 'openai')",
        },
      },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        // Get all authenticated models
        let authenticatedModels = await getAuthenticatedModels(ctx.runCommand);

        // Filter by preferred provider if specified
        const preferProvider = params?.preferProvider as string | undefined;
        if (preferProvider) {
          const filtered = authenticatedModels.filter(
            (m) => m.provider.toLowerCase() === preferProvider.toLowerCase(),
          );
          if (filtered.length === 0) {
            return jsonResult({
              success: false,
              error: `No authenticated models found for provider: ${preferProvider}`,
              message: `❌ No authenticated models found for provider "${preferProvider}".\n\nAvailable providers: ${[...new Set(authenticatedModels.map((m) => m.provider))].join(", ")}`,
            });
          }
          authenticatedModels = filtered;
        }

        // Intelligently assign models using current session context
        const assignment = await assignModels(authenticatedModels, ctx.runCommand, toolCtx.sessionKey);

        if (!assignment) {
          // No models available
          const instructions = generateSetupInstructions();
          return jsonResult({
            success: false,
            modelCount: 0,
            message: instructions,
          });
        }

        // Format the assignment
        const table = formatAssignment(assignment);
        const modelCount = authenticatedModels.length;

        let message = `✅ Auto-configured models based on ${modelCount} authenticated model${modelCount === 1 ? "" : "s"}:\n\n`;
        message += table;
        message += "\n\n";

        if (modelCount === 1) {
          message += "ℹ️  Only one authenticated model found — assigned to all roles.";
        } else {
          message += "ℹ️  Models assigned by capability tier (Tier 1 → senior, Tier 2 → mid, Tier 3 → junior).";
        }

        if (preferProvider) {
          message += `\n📌 Filtered to provider: ${preferProvider}`;
        }

        message += "\n\n**Next step:** Pass this configuration to `setup` tool:\n";
        message += "```javascript\n";
        message += "setup({ models: <this-configuration> })\n";
        message += "```";

        return jsonResult({
          success: true,
          modelCount,
          assignment,
          models: assignment,
          provider: preferProvider || "auto",
          message,
        });
      } catch (err) {
        const errorMsg = (err as Error).message;
        ctx.logger.error(`Auto-configure models error: ${errorMsg}`);
        return jsonResult({
          success: false,
          error: errorMsg,
          message: `❌ Failed to auto-configure models: ${errorMsg}`,
        });
      }
    },
  });
}
