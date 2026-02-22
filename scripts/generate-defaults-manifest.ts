#!/usr/bin/env tsx
/**
 * Generate DEFAULTS.json manifest with SHA256 hashes of all default files.
 * Run this script whenever defaults files are updated.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = path.join(__dirname, "..", "defaults");
const MANIFEST_PATH = path.join(DEFAULTS_DIR, "DEFAULTS.json");

// Read package.json version
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
);

function calculateHash(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getFileStat(filePath: string): Date {
  return fs.statSync(filePath).mtime;
}

// Files to track (relative to defaults/)
const filesToTrack = [
  "AGENTS.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "devclaw/workflow.yaml",
  "devclaw/prompts/architect.md",
  "devclaw/prompts/developer.md",
  "devclaw/prompts/reviewer.md",
  "devclaw/prompts/tester.md",
];

const manifest: Record<string, any> = {
  version: packageJson.version,
  createdAt: new Date().toISOString(),
  files: {},
};

for (const relPath of filesToTrack) {
  const fullPath = path.join(DEFAULTS_DIR, relPath);
  if (fs.existsSync(fullPath)) {
    manifest.files[relPath] = {
      hash: calculateHash(fullPath),
      updatedAt: getFileStat(fullPath).toISOString(),
    };
  }
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

console.log(`✅ Generated DEFAULTS.json with ${Object.keys(manifest.files).length} files`);
console.log(`   Version: ${manifest.version}`);
console.log(`   Location: ${MANIFEST_PATH}`);
