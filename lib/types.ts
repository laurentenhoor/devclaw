/**
 * Shared types for the DevClaw plugin.
 *
 * OpenClawPluginToolContext is declared in the plugin-sdk but not exported.
 * We define a compatible local type for use in tool factory functions.
 */

export type ToolContext = {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
};
