/**
 * upgrade-notification.ts — Startup notifications for available upgrades.
 *
 * Sends a notification to users when a new defaults version is available,
 * with instructions on how to upgrade.
 */
import { notify } from "../notify.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { checkVersionStatus, getNotificationState, updateNotificationState } from "./version-check.js";
import { readProjects } from "../projects.js";

/**
 * Check if upgrade notification should be sent.
 * Only sends once per plugin version per workspace.
 */
export async function shouldNotifyUpgrade(
  workspaceDir: string,
  pluginVersion: string,
): Promise<boolean> {
  try {
    const notifiedVersion = await getNotificationState(workspaceDir);
    
    // Already notified about this version
    if (notifiedVersion === pluginVersion) {
      return false;
    }
    
    return true;
  } catch {
    return false; // Error checking - don't notify
  }
}

/**
 * Send upgrade notification to all project groups.
 * 
 * Notifies users that a new defaults version is available and provides
 * instructions on how to upgrade.
 */
export async function sendUpgradeNotification(opts: {
  workspaceDir: string;
  runtime?: PluginRuntime;
}): Promise<boolean> {
  const { workspaceDir, runtime } = opts;
  
  try {
    const status = await checkVersionStatus(workspaceDir);
    
    // Only notify if there are changes available
    if (!status.changesAvailable || status.status === "error") {
      return false;
    }
    
    // Check if we should notify
    if (status.pluginVersion && !(await shouldNotifyUpgrade(workspaceDir, status.pluginVersion))) {
      return false;
    }
    
    // Build notification message
    let message = `🔄 **DevClaw defaults upgrade available**\n\n`;
    message += `📦 Version: ${status.installedVersion} → ${status.pluginVersion}\n`;
    
    if (status.status === "customizations") {
      message += `⚠️ You have ${status.customizedFiles?.length} customized file(s)\n\n`;
      message += `**Preview changes:**\n`;
      message += `\`openclaw devclaw upgrade-defaults --preview\`\n\n`;
      message += `**Auto-apply (skips customized):**\n`;
      message += `\`openclaw devclaw upgrade-defaults --auto\`\n\n`;
      message += `Customized files: ${status.customizedFiles?.join(", ")}`;
    } else if (status.status === "outdated") {
      message += `✅ No customizations detected - safe to auto-upgrade\n\n`;
      message += `**Preview changes:**\n`;
      message += `\`openclaw devclaw upgrade-defaults --preview\`\n\n`;
      message += `**Auto-apply:**\n`;
      message += `\`openclaw devclaw upgrade-defaults --auto\``;
    }
    
    // Send notification to all project groups
    const data = await readProjects(workspaceDir);
    let notified = false;
    
    for (const project of Object.values(data.projects)) {
      for (const channel of project.channels) {
        try {
          await notify(
            {
              type: "workerComplete" as any, // Use a generic type that exists
              project: project.name,
              issueId: 0,
              issueUrl: "",
              issueTitle: "Upgrade Available",
            },
            {
              workspaceDir,
              groupId: channel.groupId,
              channel: channel.channel,
              runtime,
            },
          );
          notified = true;
        } catch {
          // Best-effort - continue to next channel
        }
      }
    }
    
    // Mark as notified if we successfully sent to at least one channel
    if (notified && status.pluginVersion) {
      await updateNotificationState(workspaceDir, status.pluginVersion);
    }
    
    return notified;
  } catch {
    return false;
  }
}
