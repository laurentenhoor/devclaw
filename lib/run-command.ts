/**
 * run-command.ts — Thin wrapper around the plugin SDK's runCommandWithTimeout.
 *
 * Initialised once during plugin registration, then available to all modules
 * without threading the plugin API through every function signature.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type RunCommand = OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];

let _runCommand: RunCommand | undefined;

/**
 * Store the plugin SDK's runCommandWithTimeout. Call once in register().
 */
export function initRunCommand(api: OpenClawPluginApi): void {
  _runCommand = api.runtime.system.runCommandWithTimeout;
}

/**
 * Run an external command via the plugin SDK.
 */
export const runCommand: RunCommand = (...args) => {
  if (!_runCommand) {
    throw new Error("runCommand not initialised — call initRunCommand(api) first");
  }
  return _runCommand(...args);
};
