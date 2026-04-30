import fs from "fs";
import { InlineKeyboard } from "grammy";
import {
    addUserApplication,
    getUserApplications,
    logUserEvent,
    updateApplicationStatus,
    type ApplicationStatus
} from "../../data/db.js";
import {
    getEmailAccountForTelegramUser,
    getLatestResumePathForTelegramUser,
    getLinksForTelegramUser,
    getOrCreateUserAndProfileForTelegram,
    getProfileTextForUserByTelegramChat,
    resolveApplicantDisplayNameForForms
} from "../../data/profile.js";
import { sendApplicationEmailForUser } from "../../integrations/email.js";

import type { DraftContext, DraftTone } from "../../services/drafter.js";
import { generateEmailDraft } from "../../services/drafter.js";
import { bot } from "../botInstance.js";
import {
    pendingEmails,
    queueForUser,
    withGlobalLimit
} from "../state.js";
import {
    escapeHtml,
    resolveResumePathForUser,
    startSetEmail,
    startSetLinks,
    startSetProfile, startSetResume
} from "../utils.js";

bot.callbackQuery(/^appstatus_(\d+)$/, async (ctx) => {
  const appId = parseInt(ctx.match[1] ?? "0", 10);
  const keyboard = new InlineKeyboard();
  const statuses: { label: string; value: ApplicationStatus }[] = [
    { label: "💬 Replied", value: "replied" },
    { label: "🗓️ Interview", value: "interview" },
    { label: "🎉 Offer", value: "offer" },
    { label: "❌ Rejected", value: "rejected" },
    { label: "👻 Ghosted", value: "ghosted" },
  ];
  for (const s of statuses) {
    keyboard.text(s.label, `setappstatus_${appId}_${s.value}`);
  }
  keyboard.row().text("🔙 Back", "back_to_apps");

  await ctx.editMessageText(`Update status for application #${appId}:`, {
    reply_markup: keyboard,
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^setappstatus_(\d+)_(\w+)$/, async (ctx) => {
  if (!ctx.from) return;
  const appId = parseInt(ctx.match[1] ?? "0", 10);
  const status = (ctx.match[2] ?? "sent") as ApplicationStatus;
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);

  const updated = await updateApplicationStatus(appId, user.id, status);
  if (updated) {
    await ctx.editMessageText(
      `✅ Application #${appId} updated to *${status}*.`,
      { parse_mode: "Markdown" },
    );
  } else {
    await ctx.editMessageText(`❌ Application #${appId} not found.`);
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("back_to_apps", async (ctx) => {
  if (!ctx.from) return;
  const { user } = await getOrCreateUserAndProfileForTelegram(ctx.from.id);
  const apps = await getUserApplications(user.id, 20);

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
    "\n<i>Update status:</i> tap a button or use\n<code>/update_status [id] [status]</code>";

  const keyboard = new InlineKeyboard();
  const recent = apps.slice(0, 5);
  for (const app of recent) {
    keyboard
      .text(`#${app.id} ${app.role.slice(0, 18)}`, `appstatus_${app.id}`)
      .row();
  }

  await ctx.editMessageText(msg, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
  await ctx.answerCallbackQuery();
});

// Handle Edit button
bot.callbackQuery(/^edit_(.+)$/, async (ctx) => {
  try {
    const actionId = ctx.match[1];
    if (!actionId) return;

    const pending = pendingEmails.get(actionId);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "Session expired or invalid.",
        show_alert: true,
      });
      return;
    }

    ctx.session.awaitingRevision = true;
    ctx.session.currentActionId = actionId;

    await ctx.reply(
      "📝 What would you like to change about the draft? (e.g. 'Make it more formal', 'Remove the second sentence')",
    );
    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({
      text: "Error preparing edit.",
      show_alert: true,
    });
  }
});

bot.callbackQuery(/^tone_(confident|formal|friendly)_(.+)$/, async (ctx) => {
  try {
    const tone = ctx.match[1] as DraftTone;
    const actionId = ctx.match[2];
    if (!actionId) return;

    const pending = pendingEmails.get(actionId);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "Session expired or invalid.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Regenerating as ${tone}...` });

    const toneCtx: DraftContext = {
      ...pending.draftCtx,
      tone,
    };

    const newDraft = await generateEmailDraft(
      pending.jobData,
      pending.cvText ?? "",
      pending.match?.feedback,
      toneCtx,
    );

    pending.draft = newDraft;
    pending.tone = tone;

    const toneLabel: Record<DraftTone, string> = {
      confident: "💪 Confident",
      formal: "🎩 Formal",
      friendly: "😊 Friendly",
    };

    let replyText = `**Email Draft** (${toneLabel[tone]})\n`;
    replyText += `*Subject:* ${newDraft.subject}\n`;
    replyText += `*Body:*\n${newDraft.bodyText}`;

    const keyboard = new InlineKeyboard();
    keyboard.text("📝 Edit Draft", `edit_${actionId}`);
    if (pending.jobData.applicationEmail) {
      keyboard.text("🚀 Send Email", `send_${actionId}`);
    }
    keyboard.text("❌ Cancel", `cancel_${actionId}`);
    keyboard.row();
    keyboard.text("💪 Confident", `tone_confident_${actionId}`);
    keyboard.text("🎩 Formal", `tone_formal_${actionId}`);
    keyboard.text("😊 Friendly", `tone_friendly_${actionId}`);

    await ctx.editMessageText(replyText, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error("Tone switch error:", err);
    await ctx.answerCallbackQuery({
      text: "Failed to regenerate draft.",
      show_alert: true,
    });
  }
});

// Handle structured link buttons
bot.callbackQuery(
  /^setlink_(github|linkedin|portfolio|custom)$/,
  async (ctx) => {
    const kind = ctx.match[1] as "github" | "linkedin" | "portfolio" | "custom";

    ctx.session.awaitingProfileText = false;
    ctx.session.awaitingResumeUpload = false;
    ctx.session.awaitingResumeName = false;
    ctx.session.awaitingRevision = false;
    ctx.session.currentActionId = null;

    if (kind === "custom") {
      ctx.session.awaitingCustomLinkLabel = true;
      await ctx.reply(
        "📝 What label should I use for this link? (e.g. 'Blog', 'Behance', 'LeetCode')",
      );
    } else {
      ctx.session.awaitingLinkType = kind;
      await ctx.reply(
        `🔗 Send me your ${kind} URL (starting with http:// or https://).`,
      );
    }

    await ctx.answerCallbackQuery();
  },
);

// Onboarding buttons
bot.callbackQuery("onboard_email", async (ctx) => {
  await startSetEmail(ctx);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("onboard_resume", async (ctx) => {
  await startSetResume(ctx);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("onboard_profile", async (ctx) => {
  await startSetProfile(ctx);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("onboard_links", async (ctx) => {
  await startSetLinks(ctx);
  await ctx.answerCallbackQuery();
});





// Handle "View sample profile" button
bot.callbackQuery("view_sample_profile", async (ctx) => {
  const sample =
    "Here’s a sample profile, you can copy this and edit to fit your own:\n\n" +
    "Name: Jane Doe\n\n" +
    "Summary:\n" +
    "I’m a frontend engineer with 3+ years experience building React and Next.js apps, AI tooling, and UX-heavy dashboards. I care a lot about performance, DX, and making complex workflows feel simple.\n\n" +
    "Recent highlights:\n" +
    "- Built an AI-assisted research tool that integrates live search results into an agent workflow.\n" +
    "- Shipped a content authenticity UI that overlays verified/unverified segments on media.\n" +
    "- Maintained and improved a production B2B SaaS frontend used by thousands of users.\n\n" +
    "Skills:\n" +
    "- Languages: JavaScript, TypeScript, HTML, CSS\n" +
    "- Frameworks: React, Next.js, TailwindCSS\n" +
    "- Tools: Git, GCP, Prisma, MongoDB, Cloudflare R2/D1\n\n" +
    "Preferred roles:\n" +
    "Frontend / React / Next.js, remote-friendly.\n\n" +
    "⚠️ Start with \"Name: Your Full Name\" — this is used as your applicant name on forms and emails.\n\n" +
    "When you’re ready, run /set_profile and paste your own version.";

  const sent = await ctx.reply(sample);

  // Best-effort auto-delete after 30 seconds to keep chat clean
  setTimeout(async () => {
    try {
      await ctx.api.deleteMessage(sent.chat.id, sent.message_id);
    } catch {
      // ignore if already deleted or cannot delete
    }
  }, 30000);

  await ctx.answerCallbackQuery();
});

// Handle Rename button
bot.callbackQuery(/^rename_(.+)$/, async (ctx) => {
  try {
    const actionId = ctx.match[1];
    if (!actionId) return;

    const pending = pendingEmails.get(actionId);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "Session expired or invalid.",
        show_alert: true,
      });
      return;
    }

    ctx.session.awaitingResumeName = true;
    ctx.session.currentActionId = actionId;

    const currentName = pending.customResumeName || "resume.pdf";
    await ctx.reply(
      `Current resume filename: \`${currentName}\`\n\nPlease type the new filename (e.g. \`Emmanuel_Frontend_CV.pdf\`):`,
      {
        parse_mode: "Markdown",
      },
    );
    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({
      text: "Error starting rename.",
      show_alert: true,
    });
  }
});

// Handle Send Email
bot.callbackQuery(/^send_(.+)$/, async (ctx) => {
  try {
    const actionId = ctx.match[1];
    if (!actionId) return;

    const pending = pendingEmails.get(actionId);

    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "Email data expired or already sent.",
        show_alert: true,
      });
      return;
    }

    if (!pending.jobData.applicationEmail) {
      await ctx.answerCallbackQuery({
        text: "No application email was found for this job.",
        show_alert: true,
      });
      return;
    }

    if (!ctx.from) {
      await ctx.answerCallbackQuery({
        text: "Cannot resolve your user account. Try again.",
        show_alert: true,
      });
      return;
    }

    const emailAccount = await getEmailAccountForTelegramUser(
      ctx.from.id,
      ctx.from.first_name || ctx.from.last_name
        ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
        : undefined,
      ctx.from.username || undefined,
    );

    if (!emailAccount) {
      await ctx.answerCallbackQuery({
        text: "You need to configure your email first via /set_email.",
        show_alert: true,
      });
      return;
    }

    // Attach Cover Letter if we generated one
    const attachments: { filename: string; path: string }[] = [];
    if (pending.coverLetterPath) {
      attachments.push({
        filename: "Cover_Letter.pdf",
        path: pending.coverLetterPath,
      });
    }

    let resumePath: string | null = null;
    if (pending.userId && ctx.from) {
      resumePath = await getLatestResumePathForTelegramUser(
        ctx.from.id,
        ctx.from.first_name || ctx.from.last_name
          ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
          : undefined,
        ctx.from.username || undefined,
      );
    }

    if (resumePath) {
      const finalName = pending.customResumeName || "resume.pdf";
      attachments.push({ filename: finalName, path: resumePath });
    }

    const summary =
      `**Confirm send**\n\n` +
      `From: \`${emailAccount.email_address}\`\n` +
      `To: \`${pending.jobData.applicationEmail}\`\n` +
      `Role: ${pending.jobData.jobTitle}\n` +
      `Subject: \`${pending.draft.subject}\`\n\n` +
      `Proceed?`;

    const keyboard = new InlineKeyboard()
      .text("✅ Confirm send", `confirm_send_${actionId}`)
      .text("❌ Cancel", `cancel_${actionId}`);

    await ctx.editMessageText(summary, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error("Failed to send email via callback:", error);
    await ctx.answerCallbackQuery({
      text: "Failed to send email. Check console.",
      show_alert: true,
    });
  }
});

bot.callbackQuery(/^confirm_send_(.+)$/, async (ctx) => {
  try {
    const actionId = ctx.match[1];
    if (!actionId) return;

    const pending = pendingEmails.get(actionId);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "Email data expired or already sent.",
        show_alert: true,
      });
      return;
    }
    if (!pending.jobData.applicationEmail) {
      await ctx.answerCallbackQuery({
        text: "No application email was found for this job.",
        show_alert: true,
      });
      return;
    }
    if (!ctx.from) {
      await ctx.answerCallbackQuery({
        text: "Cannot resolve your user account. Try again.",
        show_alert: true,
      });
      return;
    }

    const emailAccount = await getEmailAccountForTelegramUser(ctx.from.id);
    if (!emailAccount) {
      await ctx.answerCallbackQuery({
        text: "You need to configure your email first via /set_email.",
        show_alert: true,
      });
      return;
    }

    const attachments: { filename: string; path: string }[] = [];
    if (pending.coverLetterPath) {
      attachments.push({
        filename: "Cover_Letter.pdf",
        path: pending.coverLetterPath,
      });
    }

    const resumePath: string | null = await getLatestResumePathForTelegramUser(
      ctx.from.id,
    );
    if (resumePath) {
      const finalName = pending.customResumeName || "resume.pdf";
      attachments.push({ filename: finalName, path: resumePath });
    }

    await ctx.editMessageText(
      `🚀 Sending email to ${pending.jobData.applicationEmail} from ${emailAccount.email_address}...`,
    );

    const result = await withGlobalLimit(() =>
      queueForUser(pending.userId, () =>
        sendApplicationEmailForUser(pending.userId, {
          to: pending.jobData.applicationEmail!,
          subject: pending.draft.subject,
          bodyText: pending.draft.bodyText,
          attachments,
        }),
      ),
    ) as { success: boolean; id?: string; error?: string };

    if (result.success) {
      await logUserEvent(pending.userId, "email_sent", pending.jobData.jobTitle);
      await addUserApplication({
                userId: pending.userId,
                company: pending.jobData.companyName || "Unknown",
                role: pending.jobData.jobTitle,
                method: "email",
                ...(pending.jobData.applicationEmail ? { destination: pending.jobData.applicationEmail } : {}),
                ...(pending.match?.matchScore != null ? { matchScore: pending.match.matchScore } : {}),
                ...(pending.coverLetterPath ? { coverLetterPath: pending.coverLetterPath } : {}),
              });
      await ctx.editMessageText(
        `✅ **Application Sent!**\n\nTo: \`${pending.jobData.applicationEmail}\`\nSubject: \`${pending.draft.subject}\`\n\nTracked in /my\\_applications.`,
        { parse_mode: "Markdown" },
      );
      pendingEmails.delete(actionId);
    } else {
      await ctx.editMessageText(
        `❌ Failed to send: ${result.error || "Unknown error"}`,
      );
    }

    await ctx.answerCallbackQuery();
  } catch (e) {
    console.error(e);
    await ctx.answerCallbackQuery({
      text: "Failed to send email.",
      show_alert: true,
    });
  }
});

// Handle Cancel
bot.callbackQuery(/^cancel_(.+)$/, async (ctx) => {
  const actionId = ctx.match[1];
  if (actionId) {
    pendingEmails.delete(actionId);
  }
  ctx.session.awaitingRevision = false;
  ctx.session.awaitingResumeName = false;
  ctx.session.currentActionId = null;

  await ctx.editMessageText("❌ Application cancelled.");
  await ctx.answerCallbackQuery();
});
