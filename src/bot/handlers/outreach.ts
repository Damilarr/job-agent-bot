import { InlineKeyboard } from "grammy";
import { env } from "../../config/env.js";
import { prisma, updateApplicationStatus } from "../../data/db.js";
import { getOrCreateUserAndProfileForTelegram } from "../../data/profile.js";
import { runOutreachForUser, sendFollowUp, type OutreachRunReport } from "../../outreach/runner.js";
import {
  getLead,
  getLeadsDueForFollowUp,
  getOutreachSettings,
  getOutreachStats,
  updateLead,
  updateOutreachSettings,
  type OutreachLead,
} from "../../outreach/store.js";
import { bot } from "../botInstance.js";
import type { MyContext } from "../types.js";
import { escapeHtml } from "../utils.js";

const FOLLOW_UP_AFTER_DAYS = 7;
const MAX_DAILY_CAP = 10;
const TELEGRAM_LIMIT = 4000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function contactLine(lead: Pick<OutreachLead, "contact_name" | "contact_title" | "contact_email" | "contact_email_source">): string {
  const who = [lead.contact_name, lead.contact_title].filter(Boolean).join(", ");
  const via = lead.contact_email_source === "published" ? "published by the company" : "verified via Apollo";
  return `${escapeHtml(who || "Hiring contact")} &lt;${escapeHtml(lead.contact_email || "")}&gt; (${via})`;
}

function formatEmailMessage(params: {
  heading: string;
  company: string;
  domain: string;
  sourceUrl: string | null;
  contact: string;
  reason: string | null;
  subject: string;
  body: string;
}): string {
  let text = `<b>${escapeHtml(params.heading)}: ${escapeHtml(params.company)}</b> (${escapeHtml(params.domain)})\n`;
  if (params.sourceUrl) text += `<b>Found via:</b> ${escapeHtml(params.sourceUrl)}\n`;
  text += `<b>To:</b> ${params.contact}\n`;
  if (params.reason) text += `<b>Why:</b> ${escapeHtml(params.reason)}\n`;
  text += `<b>Subject:</b> ${escapeHtml(params.subject)}\n`;
  text += `<blockquote>${escapeHtml(truncate(params.body, 2500))}</blockquote>`;
  return truncate(text, TELEGRAM_LIMIT);
}

function formatRunSummary(report: OutreachRunReport, dryRun: boolean): string {
  const count = dryRun ? report.drafts.length : report.sent.length;
  let text = dryRun
    ? `<b>🧪 Outreach preview:</b> ${count} email${count === 1 ? "" : "s"} written, nothing sent.\n`
    : `<b>📬 Outreach run:</b> ${count} email${count === 1 ? "" : "s"} sent.\n`;
  if (report.stoppedReason) text += `\n${escapeHtml(report.stoppedReason)}\n`;

  const reasons = new Map<string, number>();
  for (const s of report.skipped) {
    const key = s.reason.startsWith("Error:") ? "Errors (will retry later)" : s.reason;
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  if (reasons.size) {
    text += `\n<b>Skipped:</b>\n`;
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      text += `• ${n} × ${escapeHtml(truncate(reason, 120))}\n`;
    }
  }
  return truncate(text, TELEGRAM_LIMIT);
}

async function chatIdForUser(userId: number): Promise<number | null> {
  const user = await prisma.users.findUnique({ where: { id: userId }, select: { telegram_chat_id: true } });
  return user?.telegram_chat_id ? Number(user.telegram_chat_id) : null;
}

/** Runs outreach for a user and reports each email and a summary to their Telegram chat. */
export async function runOutreachAndNotify(userId: number, options: { dryRun?: boolean; force?: boolean } = {}): Promise<void> {
  const chatId = await chatIdForUser(userId);
  if (!chatId) return;

  try {
    const report = await runOutreachForUser(userId, {
      ...options,
      onSent: async (lead) => {
        await bot.api.sendMessage(
          chatId,
          formatEmailMessage({
            heading: "✅ Sent",
            company: lead.company_name,
            domain: lead.domain,
            sourceUrl: lead.source_url,
            contact: contactLine(lead),
            reason: lead.status_reason,
            subject: lead.subject || "",
            body: lead.body || "",
          }),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
      },
    });

    for (const draft of report.drafts) {
      await bot.api.sendMessage(
        chatId,
        formatEmailMessage({
          heading: "🧪 Would send",
          company: draft.company,
          domain: draft.domain,
          sourceUrl: null,
          contact: contactLine({
            contact_name: draft.contact.name,
            contact_title: draft.contact.title,
            contact_email: draft.contact.email,
            contact_email_source: draft.contact.source,
          }),
          reason: draft.reason,
          subject: draft.subject,
          body: draft.body,
        }),
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
    }

    await bot.api.sendMessage(chatId, formatRunSummary(report, !!options.dryRun), { parse_mode: "HTML" });
  } catch (error: any) {
    console.error("Outreach run failed:", error);
    await bot.api.sendMessage(chatId, `❌ Outreach run failed: ${truncate(String(error?.message || error), 500)}`);
  }
}

/** Asks once, about a week after sending, whether to follow up with companies that haven't been marked as replied. */
export async function sendFollowUpReminders(userId: number): Promise<void> {
  const chatId = await chatIdForUser(userId);
  if (!chatId) return;

  for (const lead of await getLeadsDueForFollowUp(userId, FOLLOW_UP_AFTER_DAYS)) {
    const days = Math.round((Date.now() - (lead.sent_at?.getTime() ?? Date.now())) / 86_400_000);
    const keyboard = new InlineKeyboard()
      .text("📨 Send follow-up", `ofu_send_${lead.id}`)
      .row()
      .text("💬 They replied", `ofu_replied_${lead.id}`)
      .text("⏭ Skip", `ofu_skip_${lead.id}`);
    await bot.api.sendMessage(
      chatId,
      `⏰ <b>Follow up with ${escapeHtml(lead.company_name)}?</b>\nYou emailed ${contactLine(lead)} ${days} days ago and it's still marked as not replied.`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
    await updateLead(lead.id, { followup_reminded_at: new Date() });
  }
}

async function renderStatus(ctx: MyContext): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from!.id);
  const settings = await getOutreachSettings(user.id);
  const stats = await getOutreachStats(user.id);

  let text = `<b>📬 Cold outreach</b>\n\n`;
  text += `I find small, remote-friendly software companies outside Africa (YC, Hacker News "Who is hiring", Remotive, RemoteOK), `;
  text += `email a founder or engineering lead with your resume attached, and remind you to follow up after ${FOLLOW_UP_AFTER_DAYS} days.\n\n`;
  text += `<b>Status:</b> ${settings?.enabled ? "✅ On (weekdays at 14:00 UTC)" : "⏸ Off"}\n`;
  text += `<b>Daily cap:</b> ${settings?.daily_cap ?? 5}\n`;
  text += `<b>Your location:</b> ${escapeHtml(settings?.candidate_location || "not set")}\n`;
  text += `<b>Target roles:</b> ${escapeHtml(settings?.target_roles || "not set")}\n`;
  text += `<b>Founder emails (Apollo):</b> ${env.APOLLO_API_KEY ? "✅ configured" : "⚠️ not configured, only companies that publish a hiring email can be contacted"}\n\n`;
  text += `<b>So far:</b> ${stats.sent || 0} sent, ${stats.rejected || 0} screened out, ${stats.no_contact || 0} without a contact\n\n`;
  text += `<i>Change settings:</i>\n<code>/outreach_location Nigeria (WAT, UTC+1)</code>\n<code>/outreach_roles Frontend or full-stack engineer (junior to mid-level)</code>\n<code>/outreach_cap 5</code>`;

  const keyboard = new InlineKeyboard()
    .text(settings?.enabled ? "⏸ Turn off" : "▶️ Turn on", "outreach_toggle")
    .row()
    .text("🧪 Preview (no sending)", "outreach_preview")
    .row()
    .text("🚀 Run now", "outreach_run");
  return { text, keyboard };
}

bot.command("outreach", async (ctx) => {
  if (!ctx.from) return;
  const { text, keyboard } = await renderStatus(ctx);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });
});

bot.command("outreach_location", async (ctx) => {
  if (!ctx.from) return;
  const value = ctx.match.trim();
  if (!value) {
    await ctx.reply("Usage: /outreach_location Nigeria (WAT, UTC+1)");
    return;
  }
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  await updateOutreachSettings(user.id, { candidate_location: value.slice(0, 100) });
  await ctx.reply(`✅ Location set to: ${value.slice(0, 100)}`);
});

bot.command("outreach_roles", async (ctx) => {
  if (!ctx.from) return;
  const value = ctx.match.trim();
  if (!value) {
    await ctx.reply("Usage: /outreach_roles Frontend or full-stack engineer (junior to mid-level)");
    return;
  }
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  await updateOutreachSettings(user.id, { target_roles: value.slice(0, 150) });
  await ctx.reply(`✅ Target roles set to: ${value.slice(0, 150)}`);
});

bot.command("outreach_cap", async (ctx) => {
  if (!ctx.from) return;
  const cap = parseInt(ctx.match.trim(), 10);
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_DAILY_CAP) {
    await ctx.reply(`Usage: /outreach_cap 5 (between 1 and ${MAX_DAILY_CAP})`);
    return;
  }
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  await updateOutreachSettings(user.id, { daily_cap: cap });
  await ctx.reply(`✅ Daily cap set to ${cap}.`);
});

bot.callbackQuery("outreach_toggle", async (ctx) => {
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  const settings = await getOutreachSettings(user.id);
  if (!settings?.enabled && (!settings?.candidate_location || !settings?.target_roles)) {
    await ctx.answerCallbackQuery({ text: "Set your location and target roles first (commands below).", show_alert: true });
    return;
  }
  await updateOutreachSettings(user.id, { enabled: !settings?.enabled });
  const { text, keyboard } = await renderStatus(ctx);
  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });
  await ctx.answerCallbackQuery({ text: settings?.enabled ? "Outreach turned off" : "Outreach turned on" });
});

for (const [action, dryRun] of [["outreach_preview", true], ["outreach_run", false]] as const) {
  bot.callbackQuery(action, async (ctx) => {
    const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      dryRun
        ? "🧪 Finding and screening companies. I'll send the emails I would write here, without sending them. This takes a few minutes."
        : "🚀 Running outreach now. Emails go out a few minutes apart; I'll report each one here.",
    );
    // Runs take minutes; don't block the bot's update loop
    void runOutreachAndNotify(user.id, { dryRun, force: true });
  });
}

bot.callbackQuery(/^ofu_(send|replied|skip)_(\d+)$/, async (ctx) => {
  const action = ctx.match[1];
  const leadId = parseInt(ctx.match[2]!, 10);
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  const lead = await getLead(leadId, user.id);
  if (!lead) {
    await ctx.answerCallbackQuery({ text: "Lead not found.", show_alert: true });
    return;
  }

  if (action === "replied") {
    if (lead.application_id) await updateApplicationStatus(lead.application_id, user.id, "replied");
    await ctx.editMessageText(`💬 Marked ${escapeHtml(lead.company_name)} as replied.`, { parse_mode: "HTML" });
  } else if (action === "skip") {
    await ctx.editMessageText(`⏭ No follow-up for ${escapeHtml(lead.company_name)}.`, { parse_mode: "HTML" });
  } else {
    await ctx.editMessageText(`📨 Sending follow-up to ${escapeHtml(lead.company_name)}...`, { parse_mode: "HTML" });
    const result = await sendFollowUp(user.id, lead.id);
    await ctx.editMessageText(
      result.ok
        ? `✅ <b>Follow-up sent to ${escapeHtml(lead.company_name)}</b>\n<blockquote>${escapeHtml(truncate(result.body, 2500))}</blockquote>`
        : `❌ Follow-up not sent: ${escapeHtml(result.error)}`,
      { parse_mode: "HTML" },
    );
  }
  await ctx.answerCallbackQuery();
});
