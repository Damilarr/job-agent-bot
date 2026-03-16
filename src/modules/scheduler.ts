import cron from 'node-cron';
import { runAutoApplyCycle } from './autoApply.js';
import { getTodaysProcessedJobs, getAdminChatId } from '../data/db.js';
import { Bot } from 'grammy';
import { env } from '../config/env.js';

/**
 * Initializes all background scheduled tasks.
 */
export function startScheduler() {
  console.log("⏰ Scheduler is currently disabled (auto-apply paused for multi-user upgrade).");
}

/**
 * Generates and sends the End of Day Report via Telegram
 */
export async function sendEndOfDayReport() {
  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    console.error("ADMIN_CHAT_ID is not set in DB. Cannot send end of day report.");
    return;
  }

  try {
    const todayJobs = getTodaysProcessedJobs();
    
    if (todayJobs.length === 0) {
      const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
      await bot.api.sendMessage(adminChatId, "📊 **End of Day Report**\n\nNo jobs were processed today.");
      return;
    }

    const applied = todayJobs.filter(j => j.status === 'APPLIED');
    const skipped = todayJobs.filter(j => j.status === 'SKIPPED');
    const failed = todayJobs.filter(j => j.status === 'FAILED');

    let reportMsg = `📊 **Daily Job Hunting Report**\n\n`;
    reportMsg += `**Total Jobs Analyzed:** ${todayJobs.length}\n`;
    reportMsg += `✅ **Applications Sent:** ${applied.length}\n`;
    reportMsg += `⏭ **Skipped (Low Match / No Email):** ${skipped.length}\n`;
    reportMsg += `❌ **Failed:** ${failed.length}\n\n`;

    if (applied.length > 0) {
      reportMsg += `**Applications Submitted Today:**\n`;
      applied.forEach((job, idx) => {
        reportMsg += `${idx + 1}. [${job.title} at ${job.company}](${job.url}) (Score: ${job.matchScore || 'N/A'}%)\n`;
      });
    }

    const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    await bot.api.sendMessage(adminChatId, reportMsg, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });

  } catch (error) {
    console.error("Failed to generate end of day report:", error);
  }
}
