/**
 * reset-defaults — Reset workspace files to built-in defaults (nuclear option).
 *
 * Overwrites workspace docs (AGENTS.md, HEARTBEAT.md, etc.), the workflow
 * section of workflow.yaml (preserving roles/timeouts), and workspace prompts.
 * Creates .bak backups before each overwrite.
 *
 * ⚠️ WARNING: This tool is destructive and overwrites all defaults, even if
 * you've customized them. For routine plugin upgrades, use `upgrade-defaults`
 * instead, which intelligently merges new defaults while preserving your
 * customizations. Only use reset_defaults for:
 * - Hard resets / starting completely fresh
 * - Clearing corrupted state after troubleshooting
 * - Discarding extensive experimental changes
 *
 * Also clears inactive worker sessions from projects.json and deletes them
 * from the gateway, so new dispatches get fresh sessions with updated prompts.
 *
 * Warns about project-level prompts that still override workspace defaults.
 * Pass resetProjectPrompts=true to also backup+delete those.
 *
 * See AGENTS.md "Defaults Upgrade Strategy" section for detailed comparison
 * between reset_defaults and upgrade-defaults.
 */
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { requireWorkspaceDir } from "../tool-helpers.js";
import { backupAndWrite, fileExists } from "../setup/workspace.js";
import { DATA_DIR } from "../setup/migrate-layout.js";
import { readProjects, updateWorker } from "../projects.js";
import { runCommand } from "../run-command.js";
import {
  AGENTS_MD_TEMPLATE,
  HEARTBEAT_MD_TEMPLATE,
  IDENTITY_MD_TEMPLATE,
  TOOLS_MD_TEMPLATE,
  WORKFLOW_YAML_TEMPLATE,
  DEFAULT_ROLE_INSTRUCTIONS,
} from "../templates.js";

export function createResetDefaultsTool() {
  return (ctx: ToolContext) => ({
    name: "reset_defaults",
    label: "Reset Defaults",
    description:
      "⚠️ Nuclear option: Reset workspace files to built-in defaults (overwrites all customizations). Use `upgrade-defaults` for safe incremental updates. Resets: docs (AGENTS.md, HEARTBEAT.md, IDENTITY.md, TOOLS.md), workflow states (preserves models/timeouts), role prompts. Creates .bak backups. Only use for hard resets or clearing corrupted state.",
    parameters: {
      type: "object",
      properties: {
        resetProjectPrompts: {
          type: "boolean",
          description:
            "Also backup and delete project-level prompt overrides. Default: false (warn only).",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);
      const resetProjectPrompts = (params.resetProjectPrompts as boolean) ?? false;
      const dataDir = path.join(workspaceDir, DATA_DIR);

      const reset: string[] = [];
      const backedUp: string[] = [];
      const warnings: string[] = [];

      // --- Workspace docs ---------------------------------------------------

      const docs: Array<[string, string]> = [
        ["AGENTS.md", AGENTS_MD_TEMPLATE],
        ["HEARTBEAT.md", HEARTBEAT_MD_TEMPLATE],
        ["IDENTITY.md", IDENTITY_MD_TEMPLATE],
        ["TOOLS.md", TOOLS_MD_TEMPLATE],
      ];

      for (const [name, template] of docs) {
        const filePath = path.join(workspaceDir, name);
        if (await fileExists(filePath)) backedUp.push(name + ".bak");
        await backupAndWrite(filePath, template);
        reset.push(name);
      }

      // --- Workflow YAML (reset workflow section only) -----------------------

      const workflowPath = path.join(dataDir, "workflow.yaml");

      if (await fileExists(workflowPath)) {
        backedUp.push("devclaw/workflow.yaml.bak");
        const existing = YAML.parse(await fs.readFile(workflowPath, "utf-8")) as Record<string, unknown>;
        // Start from template document (preserves comments), graft user's roles/timeouts onto it
        const doc = YAML.parseDocument(WORKFLOW_YAML_TEMPLATE);
        if (existing.roles) doc.set("roles", existing.roles);
        if (existing.timeouts) doc.set("timeouts", existing.timeouts);
        await fs.copyFile(workflowPath, workflowPath + ".bak");
        await fs.writeFile(workflowPath, doc.toString(), "utf-8");
      } else {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(workflowPath, WORKFLOW_YAML_TEMPLATE, "utf-8");
      }
      reset.push("devclaw/workflow.yaml (workflow section only)");

      // --- Workspace prompts -------------------------------------------------

      const promptsDir = path.join(dataDir, "prompts");
      await fs.mkdir(promptsDir, { recursive: true });

      for (const [role, content] of Object.entries(DEFAULT_ROLE_INSTRUCTIONS)) {
        const filePath = path.join(promptsDir, `${role}.md`);
        if (await fileExists(filePath)) backedUp.push(`devclaw/prompts/${role}.md.bak`);
        await backupAndWrite(filePath, content);
        reset.push(`devclaw/prompts/${role}.md`);
      }

      // --- Project-level prompt scan -----------------------------------------

      const projectsDir = path.join(dataDir, "projects");
      let projectDirs: string[] = [];
      try {
        projectDirs = await fs.readdir(projectsDir);
      } catch { /* no projects dir */ }

      const projectPromptFiles: string[] = [];
      for (const projectName of projectDirs) {
        const projPromptsDir = path.join(projectsDir, projectName, "prompts");
        let files: string[] = [];
        try {
          files = (await fs.readdir(projPromptsDir)).filter((f) => f.endsWith(".md"));
        } catch { /* no prompts dir */ }

        for (const file of files) {
          projectPromptFiles.push(`devclaw/projects/${projectName}/prompts/${file}`);
        }
      }

      if (projectPromptFiles.length > 0) {
        if (resetProjectPrompts) {
          for (const relPath of projectPromptFiles) {
            const absPath = path.join(workspaceDir, relPath);
            await fs.copyFile(absPath, absPath + ".bak");
            await fs.unlink(absPath);
            backedUp.push(relPath + ".bak");
            reset.push(relPath + " (deleted)");
          }
        } else {
          for (const relPath of projectPromptFiles) {
            warnings.push(
              `${relPath} still overrides workspace defaults. Pass resetProjectPrompts=true to also reset.`,
            );
          }
        }
      }

      // --- Clear inactive sessions --------------------------------------------

      const sessionsCleared: string[] = [];
      const sessionsSkipped: string[] = [];

      try {
        const data = await readProjects(workspaceDir);

        for (const [slug, project] of Object.entries(data.projects)) {
          for (const [role, worker] of Object.entries(project.workers)) {
            if (worker.active) {
              // Never touch active workers
              for (const [level, key] of Object.entries(worker.sessions)) {
                if (key) sessionsSkipped.push(`${slug}/${role}:${level} (active)`);
              }
              continue;
            }

            const keysToDelete: string[] = [];
            const nulledSessions: Record<string, null> = {};

            for (const [level, key] of Object.entries(worker.sessions)) {
              if (!key) continue;
              keysToDelete.push(key);
              nulledSessions[level] = null;
            }

            if (Object.keys(nulledSessions).length === 0) continue;

            // Clear session references in projects.json
            await updateWorker(workspaceDir, slug, role, { sessions: nulledSessions });

            // Delete sessions from gateway
            for (const key of keysToDelete) {
              try {
                await runCommand(
                  ["openclaw", "gateway", "call", "sessions.delete", "--params", JSON.stringify({ key })],
                  { timeoutMs: 10_000 },
                );
              } catch { /* gateway may be down — session ref already cleared */ }
              sessionsCleared.push(key);
            }
          }
        }
      } catch { /* projects.json unreadable — skip session cleanup */ }

      return jsonResult({
        success: true,
        reset,
        backedUp,
        sessionsCleared: sessionsCleared.length > 0 ? sessionsCleared : undefined,
        sessionsSkipped: sessionsSkipped.length > 0 ? sessionsSkipped : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        nextStep: "Run /new to restart your own session so you pick up the updated workspace files.",
      });
    },
  });
}
