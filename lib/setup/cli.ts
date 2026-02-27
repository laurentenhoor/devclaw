/**
 * cli.ts — CLI registration for `openclaw devclaw setup` and `openclaw devclaw heartbeat`.
 *
 * Uses Commander.js (provided by OpenClaw plugin SDK context).
 */
import type { Command } from "commander";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { runSetup } from "./index.js";
import { getAllDefaultModels, getAllRoleIds, getLevelsForRole } from "../roles/index.js";
import { readProjects, writeProjects, type Channel } from "../projects/index.js";
import { log as auditLog } from "../audit.js";

/**
 * Get the default workspace directory from the OpenClaw config.
 */
function getDefaultWorkspaceDir(runtime: PluginRuntime): string | undefined {
  try {
    const config = runtime.config.loadConfig();
    return (config as any).agents?.defaults?.workspace ?? undefined;
  } catch {
    return undefined;
  }
}

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

  // Channel management commands
  const channel = devclaw
    .command("channel")
    .description("Manage project channels (register, deregister, list)");

  // Register (link) a channel to a project
  channel
    .command("register")
    .description("Register/link a channel to a project")
    .requiredOption("-p, --project <name>", "Project name or slug")
    .requiredOption("-c, --channel-id <id>", "Channel ID (e.g., Telegram group ID)")
    .option("-t, --type <type>", "Channel type (telegram, discord, slack, whatsapp)", "telegram")
    .option("-n, --name <name>", "Display name for this channel")
    .option("-w, --workspace <path>", "Workspace directory (defaults to agent defaults.workspace)")
    .action(async (opts) => {
      const workspaceDir = opts.workspace ?? getDefaultWorkspaceDir(ctx.runtime);
      if (!workspaceDir) {
        console.error("Error: workspace directory not found. Use --workspace or configure agent defaults.workspace");
        process.exit(1);
      }

      try {
        const data = await readProjects(workspaceDir);

        // Resolve project
        const slug = opts.project.toLowerCase().replace(/\s+/g, "-");
        const project =
          data.projects[slug] ??
          Object.values(data.projects).find((p) => p.name.toLowerCase() === opts.project.toLowerCase());

        if (!project) {
          const available = Object.values(data.projects).map((p) => p.name).join(", ");
          console.error(
            `Error: Project "${opts.project}" not found. Available: ${available || "none"}`
          );
          process.exit(1);
        }

        // Check if already registered
        const existing = project.channels.find((ch) => ch.channelId === opts.channelId);
        if (existing) {
          console.log(`Channel ${opts.channelId} already registered to project "${project.name}"`);
          return;
        }

        // Auto-detach from other projects
        let detachedFrom: string | null = null;
        for (const p of Object.values(data.projects)) {
          const idx = p.channels.findIndex((ch) => ch.channelId === opts.channelId);
          if (idx !== -1) {
            detachedFrom = p.name;
            p.channels.splice(idx, 1);
            break;
          }
        }

        // Add channel
        const newChannel: Channel = {
          channelId: opts.channelId,
          channel: opts.type as Channel["channel"],
          name: opts.name ?? `channel-${project.channels.length + 1}`,
          events: ["*"],
        };
        project.channels.push(newChannel);

        await writeProjects(workspaceDir, data);
        await auditLog(workspaceDir, "channel_register_cli", {
          project: project.name,
          channelId: opts.channelId,
          channelType: opts.type,
          channelName: newChannel.name,
          detachedFrom,
        });

        const detachNote = detachedFrom ? ` (detached from "${detachedFrom}")` : "";
        console.log(`✓ Channel registered to "${project.name}"${detachNote}`);
        console.log(`  Channel ID: ${opts.channelId}`);
        console.log(`  Channel type: ${opts.type}`);
        console.log(`  Channel name: ${newChannel.name}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // Deregister (unlink) a channel from a project
  channel
    .command("deregister")
    .description("Deregister/unlink a channel from a project")
    .requiredOption("-p, --project <name>", "Project name or slug")
    .requiredOption("-c, --channel-id <id>", "Channel ID to remove")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("-w, --workspace <path>", "Workspace directory (defaults to agent defaults.workspace)")
    .action(async (opts) => {
      const workspaceDir = opts.workspace ?? getDefaultWorkspaceDir(ctx.runtime);
      if (!workspaceDir) {
        console.error("Error: workspace directory not found. Use --workspace or configure agent defaults.workspace");
        process.exit(1);
      }

      try {
        const data = await readProjects(workspaceDir);

        // Resolve project
        const slug = opts.project.toLowerCase().replace(/\s+/g, "-");
        const project =
          data.projects[slug] ??
          Object.values(data.projects).find((p) => p.name.toLowerCase() === opts.project.toLowerCase());

        if (!project) {
          const available = Object.values(data.projects).map((p) => p.name).join(", ");
          console.error(
            `Error: Project "${opts.project}" not found. Available: ${available || "none"}`
          );
          process.exit(1);
        }

        // Find channel
        const idx = project.channels.findIndex((ch) => ch.channelId === opts.channelId);
        if (idx === -1) {
          console.error(`Error: Channel ${opts.channelId} not found in project "${project.name}"`);
          process.exit(1);
        }

        // Prevent removing last channel
        if (project.channels.length === 1) {
          console.error(
            `Error: Cannot remove the last channel from project "${project.name}". Projects must have at least one channel.`
          );
          process.exit(1);
        }

        const channel = project.channels[idx];

        // Confirmation prompt (unless --yes)
        if (!opts.yes) {
          const readline = await import("node:readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(
              `Remove channel "${channel.name}" (${channel.channelId}) from project "${project.name}"? [y/N] `,
              resolve
            );
          });
          rl.close();

          if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
            console.log("Cancelled.");
            return;
          }
        }

        // Remove channel
        project.channels.splice(idx, 1);

        await writeProjects(workspaceDir, data);
        await auditLog(workspaceDir, "channel_deregister_cli", {
          project: project.name,
          channelId: opts.channelId,
          channelName: channel.name,
        });

        console.log(`✓ Channel deregistered from "${project.name}"`);
        console.log(`  Removed: ${channel.name} (${opts.channelId})`);
        console.log(`  Remaining channels: ${project.channels.length}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // List channels for a project (or all projects)
  channel
    .command("list")
    .description("List channels for a project (or all projects)")
    .option("-p, --project <name>", "Project name or slug (omit to list all)")
    .option("-w, --workspace <path>", "Workspace directory (defaults to agent defaults.workspace)")
    .action(async (opts) => {
      const workspaceDir = opts.workspace ?? getDefaultWorkspaceDir(ctx.runtime);
      if (!workspaceDir) {
        console.error("Error: workspace directory not found. Use --workspace or configure agent defaults.workspace");
        process.exit(1);
      }

      try {
        const data = await readProjects(workspaceDir);

        if (opts.project) {
          // Show channels for a specific project
          const slug = opts.project.toLowerCase().replace(/\s+/g, "-");
          const project =
            data.projects[slug] ??
            Object.values(data.projects).find((p) => p.name.toLowerCase() === opts.project.toLowerCase());

          if (!project) {
            const available = Object.values(data.projects).map((p) => p.name).join(", ");
            console.error(
              `Error: Project "${opts.project}" not found. Available: ${available || "none"}`
            );
            process.exit(1);
          }

          console.log(`Channels for project "${project.name}":`);
          if (project.channels.length === 0) {
            console.log("  (none)");
          } else {
            for (const ch of project.channels) {
              console.log(`  • ${ch.name} (${ch.channel})`);
              console.log(`    ID: ${ch.channelId}`);
              console.log(`    Events: ${ch.events.join(", ")}`);
              if (ch.accountId) console.log(`    Account: ${ch.accountId}`);
            }
          }
        } else {
          // Show all channels for all projects
          const projects = Object.values(data.projects);
          if (projects.length === 0) {
            console.log("No projects registered.");
            return;
          }

          for (const project of projects) {
            console.log(`\n${project.name} (${project.slug}):`);
            if (project.channels.length === 0) {
              console.log("  (no channels)");
            } else {
              for (const ch of project.channels) {
                console.log(`  • ${ch.name} (${ch.channel}) — ${ch.channelId}`);
              }
            }
          }
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
