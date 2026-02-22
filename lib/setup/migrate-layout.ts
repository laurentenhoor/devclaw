/**
 * setup/migrate-layout.ts — One-time workspace layout migration.
 *
 * Migrates from old layouts to the current devclaw/ data directory:
 *
 * Very old layout (pre-restructure):
 *   projects/projects.json          → devclaw/projects.json
 *   projects/config.yaml            → devclaw/workflow.yaml
 *   projects/roles/default/*        → devclaw/prompts/* (with dev.md→developer.md, qa.md→tester.md)
 *   projects/roles/<project>/*      → devclaw/projects/<project>/prompts/*
 *   projects/<project>/config.yaml  → devclaw/projects/<project>/workflow.yaml
 *
 * Intermediate layout (post-restructure, pre-devclaw/):
 *   projects.json                   → devclaw/projects.json
 *   workflow.yaml                   → devclaw/workflow.yaml
 *   prompts/*                       → devclaw/prompts/*
 *   projects/<project>/*.md         → devclaw/projects/<project>/prompts/*
 *   projects/<project>/workflow.yaml→ devclaw/projects/<project>/workflow.yaml
 *   log/*                           → devclaw/log/*
 *
 * Flat project layout (early devclaw/ without prompts subdir):
 *   devclaw/projects/<project>/*.md → devclaw/projects/<project>/prompts/*
 *
 * This file can be removed once all workspaces have been migrated.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Role file renames: old filename → new filename. */
const ROLE_FILE_RENAMES: Record<string, string> = {
  "dev.md": "developer.md",
  "qa.md": "tester.md",
};

/** The data directory name inside the workspace. */
export const DATA_DIR = "devclaw";

/** Track which workspaces have been migrated this process. */
const migrated = new Set<string>();

/**
 * Create or update the .INSTALLED_DEFAULTS manifest for version tracking.
 * 
 * On first run (or legacy workspace without the manifest), creates a retroactive
 * snapshot of current file hashes. On subsequent runs, this is a no-op unless
 * the manifest is missing or corrupted.
 */
async function ensureInstalledManifest(workspaceDir: string): Promise<void> {
  try {
    // Lazy import to avoid circular dependencies
    const { loadInstalledManifest, saveInstalledManifest, createRetroactiveManifest } = 
      await import("./defaults-manifest.js");
    
    const existing = await loadInstalledManifest(workspaceDir);
    if (existing) return; // Already exists, nothing to do
    
    // Create retroactive manifest from current state
    const manifest = await createRetroactiveManifest(workspaceDir);
    if (manifest) {
      await saveInstalledManifest(workspaceDir, manifest);
    }
  } catch {
    // Best-effort — don't break migration if manifest creation fails
  }
}

/**
 * Ensure a workspace has been migrated and default files exist (at most once per process).
 * Safe to call from any code path — no-ops if already run this process.
 */
export async function ensureWorkspaceMigrated(workspaceDir: string): Promise<void> {
  if (migrated.has(workspaceDir)) return;
  migrated.add(workspaceDir);
  await migrateWorkspaceLayout(workspaceDir);
  // Lazy import to avoid circular dependency (workspace.ts imports from this file)
  const { ensureDefaultFiles } = await import("./workspace.js");
  await ensureDefaultFiles(workspaceDir);
  
  // Create or update .INSTALLED_DEFAULTS manifest for version tracking
  await ensureInstalledManifest(workspaceDir);
}

/**
 * Migrate workspace from old layouts to new devclaw/ data directory.
 *
 * Detects four states:
 * 1. Already migrated: devclaw/projects.json exists → check prompt subdir migration
 * 2. Intermediate layout: projects.json at workspace root → move into devclaw/
 * 3. Very old layout: projects/projects.json → full migration into devclaw/
 * 4. Empty workspace → no-op
 */
export async function migrateWorkspaceLayout(workspaceDir: string): Promise<void> {
  const dataDir = path.join(workspaceDir, DATA_DIR);
  const newProjectsJson = path.join(dataDir, "projects.json");

  // Already migrated — but may need prompt subdir migration
  if (await fileExists(newProjectsJson)) {
    await migratePromptSubdirs(dataDir);
    return;
  }

  // Check for intermediate layout (post-restructure, pre-devclaw/)
  const rootProjectsJson = path.join(workspaceDir, "projects.json");
  if (await fileExists(rootProjectsJson)) {
    await migrateFromIntermediate(workspaceDir, dataDir);
    return;
  }

  // Check for very old layout (projects/projects.json)
  const oldProjectsJson = path.join(workspaceDir, "projects", "projects.json");
  if (await fileExists(oldProjectsJson)) {
    await migrateFromOldLayout(workspaceDir, dataDir);
    return;
  }
}

/**
 * Move flat prompt files in project dirs into prompts/ subdirs.
 * Handles: devclaw/projects/<project>/<role>.md → devclaw/projects/<project>/prompts/<role>.md
 */
async function migratePromptSubdirs(dataDir: string): Promise<void> {
  const projectsDir = path.join(dataDir, "projects");
  if (!await dirExists(projectsDir)) return;

  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, entry.name);

    // Skip if already has prompts/ subdir
    const promptsDir = path.join(projectDir, "prompts");
    if (await dirExists(promptsDir)) continue;

    // Check if there are .md files at project root
    const files = await fs.readdir(projectDir);
    const mdFiles = files.filter(f => f.endsWith(".md"));
    if (mdFiles.length === 0) continue;

    // Move .md files into prompts/ subdir (with renames)
    await fs.mkdir(promptsDir, { recursive: true });
    for (const file of mdFiles) {
      const newName = ROLE_FILE_RENAMES[file] ?? file;
      const dest = path.join(promptsDir, newName);
      if (!await fileExists(dest)) {
        await safeCopy(path.join(projectDir, file), dest);
      }
      await fs.unlink(path.join(projectDir, file));
    }
  }
}

/**
 * Migrate from intermediate layout (files at workspace root) into devclaw/.
 */
async function migrateFromIntermediate(workspaceDir: string, dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });

  // Move projects.json
  await moveIfExists(
    path.join(workspaceDir, "projects.json"),
    path.join(dataDir, "projects.json"),
  );

  // Move workflow.yaml
  await moveIfExists(
    path.join(workspaceDir, "workflow.yaml"),
    path.join(dataDir, "workflow.yaml"),
  );

  // Move prompts/ directory (with role file renames)
  await moveDirWithRenames(
    path.join(workspaceDir, "prompts"),
    path.join(dataDir, "prompts"),
  );

  // Move projects/ directory — prompt files go into prompts/ subdir
  await moveProjectDirs(
    path.join(workspaceDir, "projects"),
    path.join(dataDir, "projects"),
  );

  // Move log/ directory
  await moveDirIfExists(
    path.join(workspaceDir, "log"),
    path.join(dataDir, "log"),
  );
}

/**
 * Migrate from very old layout (projects/projects.json) directly into devclaw/.
 */
async function migrateFromOldLayout(workspaceDir: string, dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });

  // 1. Move projects/projects.json → devclaw/projects.json
  const oldProjectsJson = path.join(workspaceDir, "projects", "projects.json");
  await safeCopy(oldProjectsJson, path.join(dataDir, "projects.json"));
  await fs.unlink(oldProjectsJson);

  // 2. Move projects/config.yaml → devclaw/workflow.yaml
  const oldConfig = path.join(workspaceDir, "projects", "config.yaml");
  const newConfig = path.join(dataDir, "workflow.yaml");
  if (await fileExists(oldConfig) && !await fileExists(newConfig)) {
    await safeCopy(oldConfig, newConfig);
    await fs.unlink(oldConfig);
  }

  // 3. Move projects/roles/default/* → devclaw/prompts/* (with renames)
  const oldDefaultsDir = path.join(workspaceDir, "projects", "roles", "default");
  const newPromptsDir = path.join(dataDir, "prompts");
  if (await dirExists(oldDefaultsDir)) {
    await fs.mkdir(newPromptsDir, { recursive: true });
    const files = await fs.readdir(oldDefaultsDir);
    for (const file of files) {
      const newName = ROLE_FILE_RENAMES[file] ?? file;
      const dest = path.join(newPromptsDir, newName);
      if (!await fileExists(dest)) {
        await safeCopy(path.join(oldDefaultsDir, file), dest);
      }
      await fs.unlink(path.join(oldDefaultsDir, file));
    }
    await rmEmptyDir(oldDefaultsDir);
  }

  // 4. Move projects/roles/<project>/* → devclaw/projects/<project>/prompts/* (with renames)
  const oldRolesDir = path.join(workspaceDir, "projects", "roles");
  if (await dirExists(oldRolesDir)) {
    const entries = await fs.readdir(oldRolesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectName = entry.name;
      const srcDir = path.join(oldRolesDir, projectName);
      const destDir = path.join(dataDir, "projects", projectName, "prompts");
      await fs.mkdir(destDir, { recursive: true });

      const roleFiles = await fs.readdir(srcDir);
      for (const file of roleFiles) {
        const newName = ROLE_FILE_RENAMES[file] ?? file;
        const dest = path.join(destDir, newName);
        if (!await fileExists(dest)) {
          await safeCopy(path.join(srcDir, file), dest);
        }
        await fs.unlink(path.join(srcDir, file));
      }
      await rmEmptyDir(srcDir);
    }
    await rmEmptyDir(oldRolesDir);
  }

  // 5. Rename projects/<project>/config.yaml → devclaw/projects/<project>/workflow.yaml
  const oldProjectsDir = path.join(workspaceDir, "projects");
  if (await dirExists(oldProjectsDir)) {
    const entries = await fs.readdir(oldProjectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const oldCfg = path.join(oldProjectsDir, entry.name, "config.yaml");
      const newCfg = path.join(dataDir, "projects", entry.name, "workflow.yaml");
      if (await fileExists(oldCfg) && !await fileExists(newCfg)) {
        await safeCopy(oldCfg, newCfg);
        await fs.unlink(oldCfg);
      }
    }
  }

  // 6. Move log/ directory
  await moveDirIfExists(
    path.join(workspaceDir, "log"),
    path.join(dataDir, "log"),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch { return false; }
}

async function safeCopy(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function rmEmptyDir(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) await fs.rmdir(dir);
  } catch { /* ignore */ }
}

/** Move a file if it exists and dest doesn't. */
async function moveIfExists(src: string, dest: string): Promise<void> {
  if (await fileExists(src) && !await fileExists(dest)) {
    await safeCopy(src, dest);
    await fs.unlink(src);
  }
}

/** Move an entire directory's contents if it exists. */
async function moveDirIfExists(srcDir: string, destDir: string): Promise<void> {
  if (!await dirExists(srcDir)) return;
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await moveDirIfExists(srcPath, destPath);
    } else {
      if (!await fileExists(destPath)) {
        await safeCopy(srcPath, destPath);
      }
      await fs.unlink(srcPath);
    }
  }
  await rmEmptyDir(srcDir);
}

/** Move a directory, applying ROLE_FILE_RENAMES to files and recursing into subdirs. */
async function moveDirWithRenames(srcDir: string, destDir: string): Promise<void> {
  if (!await dirExists(srcDir)) return;
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      await moveDirWithRenames(srcPath, path.join(destDir, entry.name));
    } else {
      const newName = ROLE_FILE_RENAMES[entry.name] ?? entry.name;
      const destPath = path.join(destDir, newName);
      if (!await fileExists(destPath)) {
        await safeCopy(srcPath, destPath);
      }
      await fs.unlink(srcPath);
    }
  }
  await rmEmptyDir(srcDir);
}

/**
 * Move project directories: .md files go into prompts/ subdir (with renames),
 * other files (workflow.yaml) stay at project root.
 */
async function moveProjectDirs(srcDir: string, destDir: string): Promise<void> {
  if (!await dirExists(srcDir)) return;
  await fs.mkdir(destDir, { recursive: true });

  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      // Each subdirectory is a project — move its contents with prompt separation
      const destProjectDir = path.join(destDir, entry.name);
      await fs.mkdir(destProjectDir, { recursive: true });

      const projectFiles = await fs.readdir(srcPath);
      for (const file of projectFiles) {
        const fileSrc = path.join(srcPath, file);
        if (file.endsWith(".md")) {
          // Prompt file → prompts/ subdir (with renames)
          const newName = ROLE_FILE_RENAMES[file] ?? file;
          const promptsDest = path.join(destProjectDir, "prompts", newName);
          if (!await fileExists(promptsDest)) {
            await safeCopy(fileSrc, promptsDest);
          }
        } else {
          // Config file → project root
          const fileDest = path.join(destProjectDir, file);
          if (!await fileExists(fileDest)) {
            await safeCopy(fileSrc, fileDest);
          }
        }
        await fs.unlink(fileSrc);
      }
      await rmEmptyDir(srcPath);
    } else {
      // Top-level file in projects/ dir — just move
      const destPath = path.join(destDir, entry.name);
      if (!await fileExists(destPath)) {
        await safeCopy(srcPath, destPath);
      }
      await fs.unlink(srcPath);
    }
  }
  await rmEmptyDir(srcDir);
}
