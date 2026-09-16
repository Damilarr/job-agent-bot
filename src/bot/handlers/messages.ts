import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { env } from "../../config/env.js";
import {
    logUserEvent
} from "../../data/db.js";
import {
    addCustomLinkForTelegramUser,
    getLinksForTelegramUser,
    getOrCreateUserAndProfileForTelegram,
    getProfileTextForUserByTelegramChat,
    resolveApplicantDisplayNameForForms,
    saveResumeForTelegramUser,
    setCoreLinkForTelegramUser,
    updateProfileFromTextForTelegram,
    upsertEmailAccountForTelegramUser,
} from "../../data/profile.js";

import { generateCoverLetterPDF } from "../../services/coverLetter.js";
import type { DraftContext } from "../../services/drafter.js";
import { generateEmailDraft, reviseEmailDraft } from "../../services/drafter.js";
import { evaluateMatch } from "../../services/matcher.js";
import type { ParsedJobDescription } from "../../services/parser.js";
import { parseJobDescription } from "../../services/parser.js";
import {
    buildCandidateBackground,
    extractPhone,
    extractResumeText,
} from "../../services/resumeText.js";
import { bot } from "../botInstance.js";
import { renderDraftPreview } from "../pendingEmail.js";
import {
    pendingEmails,
    type PendingEmail
} from "../state.js";
import {
    looksLikeJobDescription,
    resolveResumePathForUser
} from "../utils.js";

bot.on("message:document", async (ctx) => {
  if (!ctx.from) return;
  const telegramChatId = ctx.from.id;

  if (!ctx.session.awaitingResumeUpload) {
    // Ignore documents that are not part of the resume upload flow for now
    return;
  }

  const document = ctx.message.document;
  if (!document) return;

  // Basic MIME / extension check – prefer PDFs
  const isPdf =
    document.mime_type === "application/pdf" ||
    (document.file_name && document.file_name.toLowerCase().endsWith(".pdf"));

  if (!isPdf) {
    await ctx.reply("⚠️ Please upload your resume as a PDF file.");
    return;
  }

  const file = await ctx.api.getFile(document.file_id);
  if (!file.file_path) {
    await ctx.reply(
      "❌ I couldn't access the file path from Telegram. Please try again.",
    );
    return;
  }

  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    await ctx.reply(
      "❌ Failed to download the file from Telegram. Please try again.",
    );
    return;
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  const uploadsDir = path.resolve(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const safeName =
    document.file_name && document.file_name.toLowerCase().endsWith(".pdf")
      ? document.file_name
      : `resume_${telegramChatId}_${Date.now()}.pdf`;

  const localPath = path.join(uploadsDir, safeName);
  fs.writeFileSync(localPath, buffer);

  await saveResumeForTelegramUser(
    telegramChatId,
    localPath,
    ctx.from.first_name || ctx.from.last_name
      ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
      : undefined,
    ctx.from.username || undefined,
  );

  ctx.session.awaitingResumeUpload = false;

  {
    const { user } = await getOrCreateUserAndProfileForTelegram(telegramChatId);
    await logUserEvent(user.id, "resume_uploaded", path.basename(localPath));
  }

  await ctx.reply(
    "✅ Resume uploaded and saved! I’ll attach this file for future applications that require a resume.",
  );
});

bot.on("message:text", async (ctx) => {
  if (!ctx.from) return;
  const telegramChatId = ctx.from.id;
  const rawJD = ctx.message.text;

  // Handle email setup: step 1 - address
  if (ctx.session.awaitingEmailAddress) {
    const email = rawJD.trim();
    ctx.session.currentActionId = email;
    ctx.session.awaitingEmailAddress = false;
    ctx.session.awaitingEmailPassword = true;

    await ctx.reply(
      "🔐 Step 2 of 2: Now send me your *Gmail app password* for this address.\n\n" +
        "Create one at: Google Account → Security → App passwords → choose 'Mail' and your device.\n\n" +
        "You can revoke it anytime. I will store it securely and only use it to send applications on your behalf.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Handle email setup: step 2 - app password
  if (ctx.session.awaitingEmailPassword && ctx.session.currentActionId) {
    const emailAddress = ctx.session.currentActionId;
    const appPassword = rawJD.trim();

    await upsertEmailAccountForTelegramUser(
      telegramChatId,
      "gmail_smtp",
      emailAddress,
      "smtp.gmail.com",
      465,
      emailAddress,
      appPassword,
      ctx.from.first_name || ctx.from.last_name
        ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
        : undefined,
      ctx.from.username || undefined,
    );

    ctx.session.awaitingEmailPassword = false;
    ctx.session.currentActionId = null;

    {
      const { user } =
        await getOrCreateUserAndProfileForTelegram(telegramChatId);
      await logUserEvent(user.id, "email_connected", emailAddress);
    }

    await ctx.reply(
      "✅ Email account connected! I’ll now send applications using this address.",
    );
    return;
  }

  // Handle profile text update
  if (ctx.session.awaitingProfileText) {
    await updateProfileFromTextForTelegram(
      telegramChatId,
      rawJD,
      ctx.from.first_name || ctx.from.last_name
        ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
        : undefined,
      ctx.from.username || undefined,
    );

    ctx.session.awaitingProfileText = false;
    {
      const { user } =
        await getOrCreateUserAndProfileForTelegram(telegramChatId);
      await logUserEvent(user.id, "profile_updated");
    }
    await ctx.reply(
      "✅ Profile updated! I’ll use this new information for future match scores, emails and cover letters.",
    );
    return;
  }

  // Handle structured link flows
  if (ctx.session.awaitingCustomLinkLabel) {
    // Save the label and ask for URL next
    ctx.session.awaitingCustomLinkLabel = false;
    ctx.session.awaitingLinkType = "custom";
    ctx.session.currentActionId = rawJD.trim(); // reuse currentActionId to store label temporarily
    await ctx.reply("🔗 Great, now send me the URL for this link.");
    return;
  }

  if (ctx.session.awaitingLinkType) {
    const kind = ctx.session.awaitingLinkType;
    const url = rawJD.trim();

    if (!/^https?:\/\//i.test(url)) {
      await ctx.reply(
        "⚠️ Please send a valid URL starting with http:// or https://",
      );
      return;
    }

    if (kind === "github" || kind === "linkedin" || kind === "portfolio") {
      const from = ctx.from;
      if (!from) {
        ctx.session.awaitingLinkType = null;
        return;
      }
      await setCoreLinkForTelegramUser(
        telegramChatId,
        kind,
        url,
        from.first_name || from.last_name
          ? `${from.first_name || ""} ${from.last_name || ""}`.trim()
          : undefined,
        from.username || undefined,
      );
      const labelPretty =
        kind === "github"
          ? "GitHub"
          : kind === "linkedin"
            ? "LinkedIn"
            : "Portfolio";
      {
        const { user } =
          await getOrCreateUserAndProfileForTelegram(telegramChatId);
        await logUserEvent(user.id, "link_updated", `${kind}: ${url}`);
      }
      await ctx.reply(`✅ ${labelPretty} URL updated.`);
    } else if (kind === "custom" && ctx.session.currentActionId) {
      const label = ctx.session.currentActionId;
      const from = ctx.from;
      if (from) {
        await addCustomLinkForTelegramUser(
          telegramChatId,
          label,
          url,
          from.first_name || from.last_name
            ? `${from.first_name || ""} ${from.last_name || ""}`.trim()
            : undefined,
          from.username || undefined,
        );
        {
          const { user } =
            await getOrCreateUserAndProfileForTelegram(telegramChatId);
          await logUserEvent(user.id, "link_added", `${label}: ${url}`);
        }
        await ctx.reply(`✅ Custom link "${label}" saved.`);
      }
    }

    ctx.session.awaitingLinkType = null;
    ctx.session.currentActionId = null;
    return;
  }



  // Handle revision input
  if (ctx.session.awaitingRevision && ctx.session.currentActionId) {
    const actionId = ctx.session.currentActionId;
    const pending = pendingEmails.get(actionId);

    if (!pending) {
      await ctx.reply("❌ Session expired for revision. Please start over.");
      ctx.session.awaitingRevision = false;
      ctx.session.currentActionId = null;
      return;
    }

    await ctx.reply("🔄 Revising email draft based on your feedback...");
    pending.draft = await reviseEmailDraft(pending.draft, rawJD);

    ctx.session.awaitingRevision = false;
    ctx.session.currentActionId = null;

    const preview = renderDraftPreview(pending, actionId, "Draft Revised");
    await ctx.reply(preview.text, {
      parse_mode: "HTML",
      reply_markup: preview.keyboard,
    });
    return;
  }

  // Check if we are waiting for a filename
  if (ctx.session.awaitingResumeName && ctx.session.currentActionId) {
    const actionId = ctx.session.currentActionId;
    const pending = pendingEmails.get(actionId);

    if (!pending) {
      await ctx.reply(
        "❌ Session expired for resume renaming. Please start over.",
      );
      ctx.session.awaitingResumeName = false;
      ctx.session.currentActionId = null;
      return;
    }

    let newName = rawJD.trim();
    if (!newName.toLowerCase().endsWith(".pdf")) {
      newName += ".pdf";
    }
    // Basic sanitization
    newName = newName.replace(/[^a-zA-Z0-9_.-]/g, "_");
    pending.customResumeName = newName;

    ctx.session.awaitingResumeName = false;
    ctx.session.currentActionId = null;

    const preview = renderDraftPreview(pending, actionId, "Resume Renamed");
    await ctx.reply(preview.text, {
      parse_mode: "HTML",
      reply_markup: preview.keyboard,
    });
    return;
  }

  if (!looksLikeJobDescription(rawJD)) {
    await ctx.reply(
      "That doesn’t look like a job description. Send me the full job posting (role, company, requirements) and I’ll draft an application",
    );
    return;
  }

  const statusMsg = await ctx.reply("🔍 Analyzing the job description...");

  try {
    const { user } = await getOrCreateUserAndProfileForTelegram(
      telegramChatId,
      ctx.from.first_name || ctx.from.last_name
        ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
        : undefined,
      ctx.from.username || undefined,
    );

    const jobData: ParsedJobDescription = await parseJobDescription(rawJD);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "⚙️ Evaluating match score...",
    );

    // Resolve per-user profile text (seeded from myCV by default) and the uploaded resume
    const from = ctx.from!;
    const tgName =
      from.first_name || from.last_name
        ? `${from.first_name || ""} ${from.last_name || ""}`.trim()
        : undefined;
    const profileText = await getProfileTextForUserByTelegramChat(
      telegramChatId,
      tgName,
      from.username || undefined,
    );
    const resumePath = await resolveResumePathForUser(telegramChatId, from);
    const resumeText = await extractResumeText(resumePath);
    const cvText = buildCandidateBackground(profileText, resumeText);

    const match = await evaluateMatch(jobData, cvText);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "✍️ Drafting application email...",
    );

    const userLinks = await getLinksForTelegramUser(
      telegramChatId,
      tgName,
      from.username || undefined,
    );
    const applicantDisplayName = await resolveApplicantDisplayNameForForms(
      telegramChatId,
      {
        ...(tgName !== undefined ? { name: tgName } : {}),
        ...(from.first_name !== undefined
          ? { telegramFirstName: from.first_name }
          : {}),
        ...(from.last_name !== undefined
          ? { telegramLastName: from.last_name }
          : {}),
        ...(from.username !== undefined ? { username: from.username } : {}),
      },
    );

    const ghUrl = userLinks.find((l) => l.label === "github")?.url;
    const liUrl = userLinks.find((l) => l.label === "linkedin")?.url;
    const pfUrl = userLinks.find((l) => l.label === "portfolio")?.url;
    const phone = extractPhone(resumeText);
    const draftCtx: DraftContext = {
      ...(ghUrl ? { githubUrl: ghUrl } : {}),
      ...(liUrl ? { linkedinUrl: liUrl } : {}),
      ...(pfUrl ? { portfolioUrl: pfUrl } : {}),
      ...(applicantDisplayName ? { applicantName: applicantDisplayName } : {}),
      ...(phone ? { phone } : {}),
    };

    const draft = await generateEmailDraft(
      jobData,
      cvText,
      draftCtx,
    );

    const pending: PendingEmail = {
      jobData,
      match,
      draft,
      userId: user.id,
      cvText,
      draftCtx,
      tone: "confident",
      ...(resumePath ? { resumePath } : {}),
    };

    if (jobData.requiresCoverLetter || !!jobData.applicationEmail) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "📄 Generating tailored Cover Letter PDF...",
      );

      const coverLetterOutPath = path.join(
        tmpdir(),
        `Cover_Letter_${jobData.jobTitle.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.pdf`,
      );
      try {
        pending.coverLetterPath = await generateCoverLetterPDF(
          jobData,
          cvText,
          coverLetterOutPath,
        );
      } catch (coverErr: any) {
        console.error("Cover letter PDF generation failed:", coverErr);
        pending.coverLetterError =
          coverErr?.message ||
          "PDF generation failed. The email draft is still ready without it.";
      }
    }

    const actionId = `draft_${Date.now()}`;
    pendingEmails.set(actionId, pending);

    const preview = renderDraftPreview(pending, actionId);
    await ctx.reply(preview.text, {
      parse_mode: "HTML",
      reply_markup: preview.keyboard,
    });

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (error: any) {
    console.error("Error processing text message:", error);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `❌ An error occurred: ${error.message}`,
    );
  }
});
