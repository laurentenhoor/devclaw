/**
 * cli.ts — CLI registration for `openclaw devclaw setup` and `openclaw devclaw heartbeat`.
 *
 * Uses Commander.js (provided by OpenClaw plugin SDK context).
 */
import type { Command } from "commander";
import type { PluginContext } from "../context.js";
import { runSetup } from "./index.js";
import { getAllDefaultModels, getAllRoleIds, getLevelsForRole } from "../roles/index.js";

/**
 * Register the `devclaw` CLI command group on a Commander program.
 */
export function registerCli(program: Command, ctx: PluginContext): void {
  const devclaw = program
    .command("devclaw")
    .description("DevClaw development pipeline tools");

  const setupCmd = devclaw
    .command("setup")
    .description("Set up DevClaw: create agent, configure models, write workspace files")
    .option("--new-agent <name>", "Create a new agent with this name")
    .option("--agent <id>", "Use an existing agent by ID")
    .option("--workspace <path>", "Direct workspace path");

  // Register dynamic --<role>-<level> options from registry
  const defaults = getAllDefaultModels();
  for (const role of getAllRoleIds()) {
    for (const level of getLevelsForRole(role)) {
      const flag = `--${role}-${level}`;
      setupCmd.option(`${flag} <model>`, `${role.toUpperCase()} ${level} model (default: ${defaults[role]?.[level] ?? "auto"})`);
    }
  }

  setupCmd.action(async (opts) => {
      // Build model overrides from CLI flags dynamically
      const models: Record<string, Record<string, string>> = {};
      for (const role of getAllRoleIds()) {
        const roleModels: Record<string, string> = {};
        for (const level of getLevelsForRole(role)) {
          // camelCase key: "testerJunior" for --tester-junior, "developerMedior" for --developer-medior
          const key = `${role}${level.charAt(0).toUpperCase()}${level.slice(1)}`;
          if (opts[key]) roleModels[level] = opts[key];
        }
        if (Object.keys(roleModels).length > 0) models[role] = roleModels;
      }

      const result = await runSetup({
        runtime: ctx.runtime,
        newAgentName: opts.newAgent,
        agentId: opts.agent,
        workspacePath: opts.workspace,
        models: Object.keys(models).length > 0 ? models : undefined,
        runCommand: ctx.runCommand,
      });

      if (result.agentCreated) {
        console.log(`Agent "${result.agentId}" created`);
      }

      console.log("Models configured:");
      for (const [role, levels] of Object.entries(result.models)) {
        for (const [level, model] of Object.entries(levels)) {
          console.log(`  ${role}.${level}: ${model}`);
        }
      }

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
