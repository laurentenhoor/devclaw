/**
 * context.ts — Lightweight DI container for the DevClaw plugin.
 *
 * Created once in register() and threaded to all tools, services, and hooks.
 * Replaces the global singleton in run-command.ts with explicit injection.
 */
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";

/**
 * RunCommand — the signature of api.runtime.system.runCommandWithTimeout.
 * Extracted so consumers don't need the full OpenClawPluginApi type.
 */
export type RunCommand = OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];

/**
 * PluginContext — shared services for all DevClaw modules.
 *
 * No framework, no decorators — just a plain object created once and
 * passed through factory functions and service registrations.
 */
export type PluginContext = {
  /** Run an external command via the plugin SDK (replaces global singleton). */
  runCommand: RunCommand;
  /** Plugin runtime for direct API access (channel messaging, gateway calls). */
  runtime: PluginRuntime;
  /** Plugin-level config from openclaw.json (notifications, heartbeat, etc.). */
  pluginConfig: Record<string, unknown> | undefined;
  /** Full OpenClaw config (agents list, defaults, etc.) — read-only. */
  config: OpenClawPluginApi["config"];
  /** Structured logger from the plugin SDK. */
  logger: OpenClawPluginApi["logger"];
};

/**
 * Build a PluginContext from the raw plugin API. Called once in register().
 */
export function createPluginContext(api: OpenClawPluginApi): PluginContext {
  return {
    runCommand: api.runtime.system.runCommandWithTimeout,
    runtime: api.runtime,
    pluginConfig: api.pluginConfig as Record<string, unknown> | undefined,
    config: api.config,
    logger: api.logger,
  };
}
