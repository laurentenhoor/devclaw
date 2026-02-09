/**
 * binding-manager.ts — Channel binding analysis and migration.
 *
 * Handles detection of existing channel bindings, channel availability,
 * and safe migration of bindings between agents.
 */
import fs from "node:fs/promises";
import path from "node:path";

export type ChannelType = "telegram" | "whatsapp";

export interface BindingAnalysis {
  channelEnabled: boolean;
  channelConfigured: boolean;
  existingChannelWideBinding?: {
    agentId: string;
    agentName: string;
  };
  groupSpecificBindings: Array<{
    agentId: string;
    agentName: string;
    groupId: string;
  }>;
  recommendation: string;
}

/**
 * Analyze the current state of channel bindings for a given channel.
 */
export async function analyzeChannelBindings(
  channel: ChannelType,
): Promise<BindingAnalysis> {
  const configPath = path.join(
    process.env.HOME ?? "/home/lauren",
    ".openclaw",
    "openclaw.json",
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));

  // Check if channel is configured and enabled
  const channelConfig = config.channels?.[channel];
  const channelConfigured = !!channelConfig;
  const channelEnabled = channelConfig?.enabled === true;

  // Find existing bindings
  const bindings = config.bindings ?? [];
  let existingChannelWideBinding:
    | BindingAnalysis["existingChannelWideBinding"]
    | undefined;
  const groupSpecificBindings: BindingAnalysis["groupSpecificBindings"] = [];

  for (const binding of bindings) {
    if (binding.match?.channel === channel) {
      const agent = config.agents?.list?.find(
        (a: { id: string }) => a.id === binding.agentId,
      );
      const agentName = agent?.name ?? binding.agentId;

      if (!binding.match.peer) {
        // Channel-wide binding (no peer filter) - potential conflict
        existingChannelWideBinding = {
          agentId: binding.agentId,
          agentName,
        };
      } else if (binding.match.peer.kind === "group") {
        // Group-specific binding - no conflict
        groupSpecificBindings.push({
          agentId: binding.agentId,
          agentName,
          groupId: binding.match.peer.id,
        });
      }
    }
  }

  // Generate recommendation
  let recommendation: string;
  if (!channelConfigured) {
    recommendation = `⚠️ ${channel} is not configured in OpenClaw. Configure it first via the wizard or openclaw.json, then restart OpenClaw.`;
  } else if (!channelEnabled) {
    recommendation = `⚠️ ${channel} is configured but disabled. Enable it in openclaw.json (channels.${channel}.enabled: true) and restart OpenClaw.`;
  } else if (existingChannelWideBinding) {
    recommendation = `⚠️ Agent "${existingChannelWideBinding.agentName}" is already bound to all ${channel} messages. Options:\n  1. Migrate binding to the new agent (recommended if replacing)\n  2. Use group-specific binding instead (if you want both agents active)\n  3. Skip binding for now`;
  } else if (groupSpecificBindings.length > 0) {
    recommendation = `✅ ${groupSpecificBindings.length} group-specific binding(s) exist. No conflicts - safe to add channel-wide binding.`;
  } else {
    recommendation = `✅ No existing ${channel} bindings. Safe to bind the new agent.`;
  }

  return {
    channelEnabled,
    channelConfigured,
    existingChannelWideBinding,
    groupSpecificBindings,
    recommendation,
  };
}

/**
 * Migrate a channel-wide binding from one agent to another.
 */
export async function migrateChannelBinding(
  channel: ChannelType,
  fromAgentId: string,
  toAgentId: string,
): Promise<void> {
  const configPath = path.join(
    process.env.HOME ?? "/home/lauren",
    ".openclaw",
    "openclaw.json",
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  const bindings = config.bindings ?? [];

  // Find the channel-wide binding for this channel and agent
  const bindingIndex = bindings.findIndex(
    (b: {
      agentId: string;
      match?: { channel: string; peer?: unknown };
    }) =>
      b.match?.channel === channel &&
      !b.match.peer &&
      b.agentId === fromAgentId,
  );

  if (bindingIndex === -1) {
    throw new Error(
      `No channel-wide ${channel} binding found for agent "${fromAgentId}"`,
    );
  }

  // Update the binding to point to the new agent
  bindings[bindingIndex].agentId = toAgentId;
  config.bindings = bindings;

  await fs.writeFile(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Remove a channel-wide binding for a specific agent.
 */
export async function removeChannelBinding(
  channel: ChannelType,
  agentId: string,
): Promise<void> {
  const configPath = path.join(
    process.env.HOME ?? "/home/lauren",
    ".openclaw",
    "openclaw.json",
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  const bindings = config.bindings ?? [];

  // Filter out the channel-wide binding for this channel and agent
  config.bindings = bindings.filter(
    (b: {
      agentId: string;
      match?: { channel: string; peer?: unknown };
    }) => !(b.match?.channel === channel && !b.match.peer && b.agentId === agentId),
  );

  await fs.writeFile(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
}
