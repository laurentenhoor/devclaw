/**
 * cli.ts — CLI registration for `openclaw devclaw setup` and `openclaw devclaw heartbeat`.
 *
 * Uses Commander.js (provided by OpenClaw plugin SDK context).
 */
import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runSetup } from "./setup/index.js";
import { DEFAULT_MODELS } from "./tiers.js";
import { getLevelsForRole } from "./roles/index.js";

/**
 * Register the `devclaw` CLI command group on a Commander program.
 */
export function registerCli(program: Command, api: OpenClawPluginApi): void {
  const devclaw = program
    .command("devclaw")
    .description("DevClaw development pipeline tools");

  devclaw
    .command("setup")
    .description("Set up DevClaw: create agent, configure models, write workspace files")
    .option("--new-agent <name>", "Create a new agent with this name")
    .option("--agent <id>", "Use an existing agent by ID")
    .option("--workspace <path>", "Direct workspace path")
    .option("--junior <model>", `Junior dev model (default: ${DEFAULT_MODELS.dev.junior})`)
    .option("--mid <model>", `Mid dev model (default: ${DEFAULT_MODELS.dev.mid})`)
    .option("--senior <model>", `Senior dev model (default: ${DEFAULT_MODELS.dev.senior})`)
    .option("--qa-junior <model>", `QA junior model (default: ${DEFAULT_MODELS.qa.junior})`)
    .option("--qa-mid <model>", `QA mid model (default: ${DEFAULT_MODELS.qa.mid})`)
    .option("--qa-senior <model>", `QA senior model (default: ${DEFAULT_MODELS.qa.senior})`)
    .action(async (opts) => {
      const dev: Record<string, string> = {};
      const qa: Record<string, string> = {};
      if (opts.junior) dev.junior = opts.junior;
      if (opts.mid) dev.mid = opts.mid;
      if (opts.senior) dev.senior = opts.senior;
      if (opts.qaJunior) qa.junior = opts.qaJunior;
      if (opts.qaMid) qa.mid = opts.qaMid;
      if (opts.qaSenior) qa.senior = opts.qaSenior;

      const hasOverrides = Object.keys(dev).length > 0 || Object.keys(qa).length > 0;
      const models = hasOverrides
        ? { ...(Object.keys(dev).length > 0 && { dev }), ...(Object.keys(qa).length > 0 && { qa }) }
        : undefined;

      const result = await runSetup({
        api,
        newAgentName: opts.newAgent,
        agentId: opts.agent,
        workspacePath: opts.workspace,
        models,
      });

      if (result.agentCreated) {
        console.log(`Agent "${result.agentId}" created`);
      }

      console.log("Models configured:");
      for (const t of getLevelsForRole("dev")) console.log(`  dev.${t}: ${result.models.dev[t]}`);
      for (const t of getLevelsForRole("qa")) console.log(`  qa.${t}: ${result.models.qa[t]}`);
      for (const t of getLevelsForRole("architect")) console.log(`  architect.${t}: ${result.models.architect[t]}`);

      console.log("Files written:");
      for (const file of result.filesWritten) {
        console.log(`  ${file}`);
      }

      if (result.warnings.length > 0) {
        console.log("\nWarnings:");
        for (const w of result.warnings) {
          console.log(`  ${w}`);
        }
      }

      console.log("\nDone! Next steps:");
      console.log("  1. Add bot to a Telegram group");
      console.log('  2. Register a project: "Register project <name> at <repo> for group <id>"');
      console.log("  3. Create your first issue and pick it up");
    });
}
