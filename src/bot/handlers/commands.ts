import fs from "fs";
import { InlineKeyboard, InputFile } from "grammy";
import path from "path";
import {
    getRecentUserEvents,
    getUserApplications,
    saveAdminChatId,
    updateApplicationStatus,
    type ApplicationStatus
} from "../../data/db.js";
import {
    getEmailAccountForTelegramUser,
    getLatestResumePathForTelegramUser,
    getLinksForTelegramUser,
    getOrCreateUserAndProfileForTelegram
} from "../../data/profile.js";
import { bot, refreshBotMenu } from "../botInstance.js";
import {
    escapeHtml,
    startSetEmail,
    startSetLinks,
    startSetProfile, startSetResume
} from "../utils.js";

bot.command("start", async (ctx) => {
  if (!ctx.from) return;

  // Refresh the bot command menu so the client shows the latest list (set_email, set_resume, etc.)
  await refreshBotMenu();

  // Ensure we have a user + profile row for this Telegram chat
  await getOrCreateUserAndProfileForTelegram(
    ctx.from.id,
    ctx.from.first_name || ctx.from.last_name
      ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
      : undefined,
    ctx.from.username || undefined,
  );

  const adminId = ctx.from.id;
  await saveAdminChatId(adminId);

  const emailAccount = await getEmailAccountForTelegramUser(
    ctx.from.id,
    ctx.from.first_name || ctx.from.last_name
      ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
      : undefined,
    ctx.from.username || undefined,
  );

  const resumePath = await getLatestResumePathForTelegramUser(
    ctx.from.id,
    ctx.from.first_name || ctx.from.last_name
      ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
      : undefined,
    ctx.from.username || undefined,
  );

  const links = await getLinksForTelegramUser(
    ctx.from.id,
    ctx.from.first_name || ctx.from.last_name
      ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
      : undefined,
    ctx.from.username || undefined,
  );

  const hasLinks = links.length > 0;

  let text = "👋 Welcome to your Job Application Agent.\n\n";
  text +=
    "Before we start applying on your behalf, please complete these quick steps:\n\n";
  text += `${emailAccount ? "✅" : "⚠️"} Connect your email (/set_email)\n`;
  text += `${resumePath ? "✅" : "⚠️"} Upload your resume (/set_resume)\n`;
  text += `✅ Set your profile text (/set_profile)\n`;
  text += `${hasLinks ? "✅" : "ℹ️"} (Optional) Set your links (/set_links)\n\n`;
  text += "You can tap the buttons below to go through each step.";

  const keyboard = new InlineKeyboard()
    .text(emailAccount ? "✅ Email" : "1️⃣ Set email", "onboard_email")
    .row()
    .text(resumePath ? "✅ Resume" : "2️⃣ Upload resume", "onboard_resume")
    .row()
    .text("3️⃣ Set profile", "onboard_profile")
    .row()
    .text(hasLinks ? "Edit links" : "4️⃣ Set links", "onboard_links");

  await ctx.reply(text, { reply_markup: keyboard });
});

bot.command("my_status", async (ctx) => {
  if (!ctx.from) return;
  const telegramChatId = ctx.from.id;
  const { user } = await getOrCreateUserAndProfileForTelegram(telegramChatId);

  const emailAccount = await getEmailAccountForTelegramUser(telegramChatId);
  const resumePath = await getLatestResumePathForTelegramUser(telegramChatId);
  const links = await getLinksForTelegramUser(telegramChatId);

  const events = await getRecentUserEvents(user.id, 5);

  let msg = "🧾 <b>Your setup status</b>\n\n";
  msg += `${emailAccount ? "✅" : "⚠️"} Email connected\n`;
  msg += `${resumePath ? "✅" : "⚠️"} Resume uploaded\n`;
  msg += `✅ Profile text set (you can update with /set_profile)\n`;
  msg += `${links.length ? "✅" : "ℹ️"} Links configured\n\n`;

  if (events.length) {
    msg += "<b>Recent activity:</b>\n";
    events.forEach((e, i) => {
      msg += `${i + 1}. ${escapeHtml(e.type)}${e.detail ? ` — ${escapeHtml(e.detail)}` : ""}\n`;
    });
  } else {
    msg += "<i>No activity yet.</i>";
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
});

bot.command("my_applications", async (ctx) => {
  if (!ctx.from) return;
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  const apps = await getUserApplications(user.id, 20);

  if (!apps.length) {
    await ctx.reply("📋 No applications tracked yet. Send a JD to get started!");
    return;
  }

  const statusEmoji: Record<string, string> = {
    sent: "📨",
    replied: "💬",
    interview: "🗓️",
    offer: "🎉",
    rejected: "❌",
    ghosted: "👻",
  };

  let msg = "<b>📋 Your Applications</b>\n\n";
  for (const app of apps) {
    const emoji = statusEmoji[app.status] || "📨";
    const date = app.created_at instanceof Date ? app.created_at.toISOString().slice(0, 10) : String(app.created_at).slice(0, 10);
    const score = app.match_score != null ? ` (${app.match_score}%)` : "";
    msg += `${emoji} <b>#${app.id}</b> ${escapeHtml(app.role)} @ ${escapeHtml(app.company)}${score}\n`;
    msg += `   ${app.method} · ${app.status} · ${date}\n`;
  }

  msg +=
    "\n<i>Update status:</i> tap a button or use\n<code>/update_status [id] [status]</code>\n";
  msg +=
    "<i>Statuses: sent, replied, interview, offer, rejected, ghosted</i>";

  const keyboard = new InlineKeyboard();
  const recent = apps.slice(0, 5);
  for (const app of recent) {
    keyboard
      .text(
        `#${app.id} ${app.role.slice(0, 18)}`,
        `appstatus_${app.id}`,
      )
      .row();
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

bot.command("update_status", async (ctx) => {
  if (!ctx.from) return;
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  const text = ctx.message?.text ?? "";
  const parts = text.replace(/^\/update_status\s*/i, "").trim().split(/\s+/);
  const appId = parseInt(parts[0] ?? "", 10);
  const newStatus = (parts[1] ?? "").toLowerCase() as ApplicationStatus;

  const validStatuses: ApplicationStatus[] = [
    "sent",
    "replied",
    "interview",
    "offer",
    "rejected",
    "ghosted",
  ];

  if (isNaN(appId) || !validStatuses.includes(newStatus)) {
    await ctx.reply(
      "Usage: `/update_status [id] [status]`\nStatuses: sent, replied, interview, offer, rejected, ghosted",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const updated = await updateApplicationStatus(appId, user.id, newStatus);
  if (updated) {
    await ctx.reply(`✅ Application #${appId} updated to *${newStatus}*.`, {
      parse_mode: "Markdown",
    });
  } else {
    await ctx.reply(`❌ Application #${appId} not found.`);
  }
});
bot.command("job_hunt", async (ctx) => {
  if (!ctx.from) return;

  // Ensure user exists for this chat as well
  await getOrCreateUserAndProfileForTelegram(
    ctx.from.id,
    ctx.from.first_name || ctx.from.last_name
      ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
      : undefined,
    ctx.from.username || undefined,
  );

  ctx.reply(
    "⏸ Auto-apply is currently disabled while we upgrade the system for multi-user support.",
  );
});

// Let users override their profile/CV text used for matching & drafting
bot.command("set_profile", async (ctx) => {
  await startSetProfile(ctx);
});

// Allow users to upload a resume file (PDF) that will be attached to applications
bot.command("set_resume", async (ctx) => {
  await startSetResume(ctx);
});

// Structured link setup for GitHub / LinkedIn / Portfolio and custom links
bot.command("set_links", async (ctx) => {
  await startSetLinks(ctx);
});

// Per-user email configuration (Gmail SMTP for now)
bot.command("set_email", async (ctx) => {
  await startSetEmail(ctx);
});


bot.command("download_resume", async (ctx) => {
  if (!ctx.from) return;
  const resumePath = await getLatestResumePathForTelegramUser(ctx.from.id);
  if (!resumePath || !fs.existsSync(resumePath)) {
    await ctx.reply(
      "No resume found. Upload one with /set\\_resume first.",
      { parse_mode: "Markdown" },
    );
    return;
  }
  await ctx.replyWithDocument(new InputFile(resumePath, path.basename(resumePath)));
});

bot.command("download_cover_letter", async (ctx) => {
  if (!ctx.from) return;
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  const apps = await getUserApplications(user.id, 10);
  const latest = apps.find(
    (a) => a.cover_letter_path && fs.existsSync(a.cover_letter_path),
  );

  if (!latest) {
    await ctx.reply(
      "No cover letter found. One is generated when you send an email application.",
    );
    return;
  }
  await ctx.replyWithDocument(
    new InputFile(latest.cover_letter_path!, path.basename(latest.cover_letter_path!)),
  );
});
