/**
 * cli.ts — CLI registration for `openclaw devclaw setup`.
 *
 * Uses Commander.js (provided by OpenClaw plugin SDK context).
 */
import type { Command } from "commander";
import { runSetup } from "./setup/index.js";
import { DEV_LEVELS, QA_LEVELS, DEFAULT_MODELS } from "./tiers.js";

/**
 * Register the `devclaw` CLI command group on a Commander program.
 */
export function registerCli(program: Command): void {
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
    .option("--medior <model>", `Medior dev model (default: ${DEFAULT_MODELS.dev.medior})`)
    .option("--senior <model>", `Senior dev model (default: ${DEFAULT_MODELS.dev.senior})`)
    .option("--reviewer <model>", `Reviewer model (default: ${DEFAULT_MODELS.qa.reviewer})`)
    .option("--tester <model>", `Tester model (default: ${DEFAULT_MODELS.qa.tester})`)
    .action(async (opts) => {
      const dev: Record<string, string> = {};
      const qa: Record<string, string> = {};
      if (opts.junior) dev.junior = opts.junior;
      if (opts.medior) dev.medior = opts.medior;
      if (opts.senior) dev.senior = opts.senior;
      if (opts.reviewer) qa.reviewer = opts.reviewer;
      if (opts.tester) qa.tester = opts.tester;

      const hasOverrides = Object.keys(dev).length > 0 || Object.keys(qa).length > 0;
      const models = hasOverrides
        ? { ...(Object.keys(dev).length > 0 && { dev }), ...(Object.keys(qa).length > 0 && { qa }) }
        : undefined;

      const result = await runSetup({
        newAgentName: opts.newAgent,
        agentId: opts.agent,
        workspacePath: opts.workspace,
        models,
      });

      if (result.agentCreated) {
        console.log(`Agent "${result.agentId}" created`);
      }

      console.log("Models configured:");
      for (const t of DEV_LEVELS) console.log(`  dev.${t}: ${result.models.dev[t]}`);
      for (const t of QA_LEVELS) console.log(`  qa.${t}: ${result.models.qa[t]}`);

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
