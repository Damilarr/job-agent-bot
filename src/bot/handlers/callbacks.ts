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
    getOrCreateUserAndProfileForTelegram
} from "../../data/profile.js";
import { sendApplicationEmailForUser } from "../../integrations/email.js";
import {
    autoFillGoogleForm,
    fillGoogleFormFromPlan,
    getUserProfileDir,
    isGoogleSessionValid,
    launchGoogleSignIn
} from "../../integrations/googleForms/index.js";
import type { DraftContext, DraftTone } from "../../services/drafter.js";
import { generateEmailDraft } from "../../services/drafter.js";
import { bot } from "../botInstance.js";
import {
    activeSignInSessions,
    pendingEmails,
    pendingFormReviews,
    pendingMultiRole,
    queueForUser,
    withGlobalLimit
} from "../state.js";
import {
    buildGoogleFormFillContext,
    escapeHtml,
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
    const date = app.created_at.slice(0, 10);
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
// Confirm: fill the form and submit
bot.callbackQuery("formreview_confirm", async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  const review = pendingFormReviews.get(userId);

  if (!review) {
    await ctx.answerCallbackQuery({ text: "No pending form review found." });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText("⏳ Filling and submitting the form...");

  try {
    const result = await fillGoogleFormFromPlan(
      review.googleFormUrl,
      review.plan,
      { resumePath: review.resumePath ?? undefined, coverLetterPath: review.coverLetterPath ?? undefined },
      { submit: true, telegramUserId: userId },
    );

    pendingFormReviews.delete(userId);

    if (result.success) {
      const { user } = await getOrCreateUserAndProfileForTelegram(userId);
      await addUserApplication({
                userId: user.id,
                company: review.plan.formTitle || "Google Form",
                role: review.plan.answers.find((a: any) => /role|position/i.test(a.label))?.answer || "Application",
                method: "google_form",
                destination: review.googleFormUrl,
                matchScore: 0,
              });

      let msg = "✅ <b>Form submitted successfully!</b>\n\n";
      if (result.filledFields && result.filledFields.length > 0) {
        msg += `Filled ${result.filledFields.length} field(s).`;
      }
      await ctx.editMessageText(msg, { parse_mode: "HTML" });
    } else {
      await ctx.editMessageText(`❌ Failed to submit: ${result.message}`);
    }
  } catch (error: any) {
    pendingFormReviews.delete(userId);
    await ctx.editMessageText(`❌ Error: ${error.message}`);
  }
});

// Revise: ask the user for instructions
bot.callbackQuery("formreview_revise", async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  if (!pendingFormReviews.has(userId)) {
    await ctx.answerCallbackQuery({ text: "No pending form review found." });
    return;
  }

  ctx.session.awaitingFormRevision = true;
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "✏️ Tell me what changes you'd like. For example:\n\n" +
      '• "Make Q3 more concise"\n' +
      '• "Change Q1 to use my middle name: John A. Doe"\n' +
      '• "For Q5, say I have 3 years of experience, not 5"\n\n' +
      "Send your instructions and I'll update the plan.",
  );
});

// Cancel: abort the form fill
bot.callbackQuery("formreview_cancel", async (ctx) => {
  if (!ctx.from) return;
  pendingFormReviews.delete(ctx.from.id);
  ctx.session.awaitingFormRevision = false;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("❌ Form fill cancelled.");
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

bot.callbackQuery("onboard_google", async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();

  if (await isGoogleSessionValid(ctx.from.id)) {
    await ctx.reply("✅ Your Google account is already connected! You're all set for Google Form applications.");
    return;
  }

  // Trigger the same flow as /connect_google
  const userId = ctx.from.id;

  if (activeSignInSessions.has(userId)) {
    await ctx.reply(
      "⚠️ You already have a sign-in session open. Please complete it first, then send /connect_google_done.",
    );
    return;
  }

  await ctx.reply(
    "🔑 <b>Google Account Setup</b>\n\n" +
      "I'm opening a Chrome window. Please sign into your Google account there.\n\n" +
      "Once you've signed in, send /connect_google_done to save your session.\n\n" +
      "⏳ The browser will stay open for 5 minutes.",
    { parse_mode: "HTML" },
  );

  try {
    const session = await launchGoogleSignIn(userId);
    activeSignInSessions.set(userId, session);

    setTimeout(async () => {
      if (activeSignInSessions.has(userId)) {
        try { await activeSignInSessions.get(userId)!.close(); } catch { /* ignore */ }
        activeSignInSessions.delete(userId);

        // Clean up the profile directory if sign-in was never completed
        if (!(await isGoogleSessionValid(userId))) {
          const profileDir = getUserProfileDir(userId);
          if (fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true, force: true });
          }
        }

        await ctx.reply("⏰ Google sign-in session timed out. Run /connect_google to try again.");
      }
    }, 5 * 60 * 1000);
  } catch (error: any) {
    await ctx.reply(`❌ Failed to open browser: ${error.message}`);
  }
});

// Multi-role selection callbacks
bot.callbackQuery(/^pickrole_cancel_(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  if (token) pendingMultiRole.delete(token);
  await ctx.editMessageText("❌ Cancelled.");
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^pickrole_(.+)_(\d+)$/, async (ctx) => {
  const token = ctx.match[1];
  const idx = parseInt(ctx.match[2] || "0", 10);
  const pending = token ? pendingMultiRole.get(token) : null;
  if (!pending) {
    await ctx.answerCallbackQuery({
      text: "Session expired.",
      show_alert: true,
    });
    return;
  }

  const role = pending.roles[idx];
  if (!role) {
    await ctx.answerCallbackQuery({
      text: "Invalid role selection.",
      show_alert: true,
    });
    return;
  }

  // If there's a Google Form link, route to form fill confirmation
  if (pending.googleFormUrl) {
    const keyboard = new InlineKeyboard()
      .text("🧾 Fill Google Form (review)", `fillform_${token}_${idx}`)
      .text("❌ Cancel", `pickrole_cancel_${token}`);

    await ctx.editMessageText(
      `Selected: **${role}**\n\nI found a Google Form application link. Do you want me to fill it now?`,
      { parse_mode: "Markdown", reply_markup: keyboard },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // No form link; continue with normal JD parsing by editing message and asking user to resend JD (simple path)
  await ctx.editMessageText(
    `Selected: **${role}**\n\nNow paste the JD again and I’ll draft the application for that role.`,
    { parse_mode: "Markdown" },
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^fillform_(.+)_(\d+)$/, async (ctx) => {
  if (!ctx.from) {
    await ctx.answerCallbackQuery({
      text: "Missing user info.",
      show_alert: true,
    });
    return;
  }
  const token = ctx.match[1];
  const idx = parseInt(ctx.match[2] || "0", 10);
  const pending = token ? pendingMultiRole.get(token) : null;
  if (!pending || !pending.googleFormUrl) {
    await ctx.answerCallbackQuery({
      text: "Session expired.",
      show_alert: true,
    });
    return;
  }

  const role = pending.roles[idx] || pending.roles[0] || "This role";
  const from = ctx.from;

  await ctx.editMessageText(
    "🧾 Preparing profile, resume, cover letter (if needed), and opening the form…",
  );

  const { fillCtx, resumePath, coverLetterPath } =
    await buildGoogleFormFillContext(
      pending,
      from.id,
      {
        ...(from.first_name !== undefined
          ? { first_name: from.first_name }
          : {}),
        ...(from.last_name !== undefined ? { last_name: from.last_name } : {}),
        ...(from.username !== undefined ? { username: from.username } : {}),
      },
      role,
      { reuseCachedAttachments: false },
    );

  if (token) {
    pendingMultiRole.set(token, {
      ...pending,
      formAttachmentPaths: {
        ...(resumePath !== undefined ? { resumePath } : {}),
        ...(coverLetterPath !== undefined ? { coverLetterPath } : {}),
      },
    });
  }

  const result = await autoFillGoogleForm(pending.googleFormUrl, fillCtx, {
    submit: false,
    telegramUserId: from.id,
  });

  if (result.success) {
    const fields = result.filledFields ?? [];
    const filledSummary =
      fields.length > 0
        ? fields
            .map(
              (f: any) =>
                `• <b>${escapeHtml(f.label)}</b>\n  → ${escapeHtml(f.value)}`,
            )
            .join("\n")
        : "";

    const hintEmpty =
      fields.length === 0
        ? "\n\n<i>No questions on this form were matched to your profile.</i> Open the form, complete missing items manually, or update <code>/set_profile</code> (include a <code>Name:</code> line) and <code>/set_resume</code>."
        : "";

    const keyboard = new InlineKeyboard()
      .text("✅ Submit now", `submitform_${token}_${idx}`)
      .text("❌ Cancel", `pickrole_cancel_${token}`);
    await ctx.editMessageText(
      `✅ ${escapeHtml(result.message)}\n\n<b>Form fields we filled</b>\n${
        filledSummary || "<i>(none)</i>"
      }${hintEmpty}\n\nIf everything looks correct, you can submit now.`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  } else {
    if (token) pendingMultiRole.delete(token);
    await ctx.editMessageText(`❌ ${result.message}`);
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^submitform_(.+)_(\d+)$/, async (ctx) => {
  if (!ctx.from) {
    await ctx.answerCallbackQuery({
      text: "Missing user info.",
      show_alert: true,
    });
    return;
  }
  const token = ctx.match[1];
  const idx = parseInt(ctx.match[2] || "0", 10);
  const pending = token ? pendingMultiRole.get(token) : null;
  if (!pending || !pending.googleFormUrl) {
    console.warn(
      `submitform: token=${token} found=${!!pending} mapSize=${pendingMultiRole.size}`,
    );
    await ctx.answerCallbackQuery({
      text: "Session expired — the bot may have restarted. Please paste the JD again.",
      show_alert: true,
    });
    return;
  }

  const role = pending.roles[idx] || pending.roles[0] || "This role";
  const from = ctx.from;

  await ctx.editMessageText("✅ Submitting the Google Form now...");

  const { fillCtx } = await buildGoogleFormFillContext(
    pending,
    from.id,
    {
      ...(from.first_name !== undefined ? { first_name: from.first_name } : {}),
      ...(from.last_name !== undefined ? { last_name: from.last_name } : {}),
      ...(from.username !== undefined ? { username: from.username } : {}),
    },
    role,
    { reuseCachedAttachments: true },
  );

  const result = await autoFillGoogleForm(pending.googleFormUrl, fillCtx, {
    submit: true,
    telegramUserId: from.id,
  });

  if (result.success) {
    const { user } = await getOrCreateUserAndProfileForTelegram(from.id);
    await addUserApplication({
            userId: user.id,
            company: "Unknown",
            role,
            method: "google_form",
            destination: pending.googleFormUrl ?? undefined,
          });
  }

  if (token) pendingMultiRole.delete(token);

  await ctx.editMessageText(
    result.success
      ? `✅ ${result.message}\n\nTracked in /my_applications.`
      : `❌ ${result.message}`,
  );
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
