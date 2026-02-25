/**
 * workflow/index.ts — Barrel re-export for backward compatibility.
 *
 * All existing `import { ... } from "../workflow.js"` paths resolve here
 * via moduleResolution: Bundler.
 */
export * from "./types.js";
export * from "./defaults.js";
export * from "./queries.js";
export * from "./labels.js";
export * from "./completion.js";
