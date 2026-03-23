import { Bot, InlineKeyboard, Context, session } from "grammy";
import { env } from "../config/env.js";
import { myCV } from "../data/cv.js";
import { parseJobDescription } from "./parser.js";
import type { ParsedJobDescription } from "./parser.js";
import { evaluateMatch } from "./matcher.js";
import { generateEmailDraft, reviseEmailDraft } from "./drafter.js";
import type { EmailDraft } from "./drafter.js";
import { generateCoverLetterPDF } from "./coverLetter.js";
import { sendApplicationEmailForUser } from "./email.js";
import { runAutoApplyCycle } from "./autoApply.js";
import {
  getRecentUserEvents,
  logUserEvent,
  saveAdminChatId,
} from "../data/db.js";
import {
  autoFillGoogleForm,
  type GoogleFormFillContext,
} from "./formFiller.js";
import {
  getOrCreateUserAndProfileForTelegram,
  getProfileTextForUserByTelegramChat,
  updateProfileFromTextForTelegram,
  saveResumeForTelegramUser,
  getLatestResumePathForTelegramUser,
  setCoreLinkForTelegramUser,
  addCustomLinkForTelegramUser,
  getLinksForTelegramUser,
  upsertEmailAccountForTelegramUser,
  getEmailAccountForTelegramUser,
  resolveApplicantDisplayNameForForms,
} from "../data/profile.js";
import fs from "fs";
import path from "path";
import { tmpdir } from "os";

// Define the bot and store data temporarily in memory for the callback
interface SessionData {
  awaitingResumeName: boolean;
  awaitingRevision: boolean;
  currentActionId: string | null;
  awaitingProfileText: boolean;
  awaitingResumeUpload: boolean;
  awaitingLinkType: "github" | "linkedin" | "portfolio" | "custom" | null;
  awaitingCustomLinkLabel: boolean;
  awaitingEmailAddress: boolean;
  awaitingEmailPassword: boolean;
}

type MyContext = Context & {
  session: SessionData;
};

const GLOBAL_CONCURRENCY = 2;
let globalActive = 0;
const globalQueue: Array<() => void> = [];

async function withGlobalLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (globalActive >= GLOBAL_CONCURRENCY) {
    await new Promise<void>((resolve) => globalQueue.push(resolve));
  }
  globalActive++;
  try {
    return await fn();
  } finally {
    globalActive--;
    const next = globalQueue.shift();
    if (next) next();
  }
}

const userChains = new Map<number, Promise<unknown>>();
function queueForUser<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = userChains.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn);
  userChains.set(
    userId,
    next.finally(() => {
      if (userChains.get(userId) === next) userChains.delete(userId);
    }),
  );
  return next;
}

/** Heuristic: does this message look like a job description (so we don't run the parser on "nice", "thanks", etc.)? */
function looksLikeJobDescription(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 50) return false;
  const lower = trimmed.toLowerCase();
  const jdKeywords = [
    "experience",
    "requirements",
    "apply",
    "role",
    "company",
    "developer",
    "engineer",
    "responsibilities",
    "qualifications",
    "salary",
    "remote",
    "position",
    "hiring",
    "description",
    "skills",
    "years",
    "applicant",
    "job",
    "vacancy",
    "opening",
  ];
  const hasKeyword = jdKeywords.some((k) => lower.includes(k));
  const hasMultipleLines = (trimmed.match(/\n/g)?.length ?? 0) >= 2;
  return hasKeyword || hasMultipleLines || trimmed.length >= 200;
}

function extractGoogleFormUrl(text: string): string | null {
  const m = text.match(/https?:\/\/docs\.google\.com\/forms\/[^\s)]+/i);
  return m ? m[0] : null;
}

function extractRoles(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const roles: string[] = [];

  // Look for numbered roles (1. Role — ...), especially after a "Roles:" marker.
  let inRoles = false;
  for (const line of lines) {
    if (/^roles\s*:/i.test(line)) {
      inRoles = true;
      continue;
    }
    if (inRoles) {
      const m = line.match(/^(\d+)[.)-]\s*(.+)$/);
      if (m?.[2]) {
        roles.push(m[2].trim());
        continue;
      }
      // End roles section when we hit Location/Requirements/etc.
      if (
        /^(location|requirements?|candidates?|apply|if you know|notes?)\b/i.test(
          line,
        )
      ) {
        inRoles = false;
      }
    }
  }

  // Fallback: scan all lines for numbered list items that look like roles.
  if (roles.length === 0) {
    for (const line of lines) {
      const m = line.match(/^(\d+)[.)-]\s*(.+)$/);
      if (
        m?.[2] &&
        /senior|developer|engineer|architect|owner|manager|designer|lead/i.test(
          m[2],
        )
      ) {
        roles.push(m[2].trim());
      }
    }
  }

  const cleaned = roles
    .map((r) =>
      r
        // strip salary/ranges like "– ₦1M – ₦2M" or "$..." etc
        .replace(/[-–—]\s*(₦|\$|£|€)\s*[\d.,]+[^\n]*/g, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter(Boolean);

  // De-dup (case-insensitive)
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const r of cleaned) {
    const k = r.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(r);
  }
  return unique.slice(0, 8);
}

function extractReferrerDetails(text: string): {
  referrerName?: string;
  referrerEmail?: string;
} {
  const nameMatch = text.match(/input\s+my\s+name\s*[-–:]\s*([^\n.]+)/i);
  const emailMatch = text.match(
    /\bmy\s+email\s+is\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
  );
  const referrerName = nameMatch?.[1]?.trim();
  const referrerEmail = emailMatch?.[1]?.trim();
  return {
    ...(referrerName ? { referrerName } : {}),
    ...(referrerEmail ? { referrerEmail } : {}),
  };
}

export type PendingGoogleFormSession = {
  rawJD: string;
  roles: string[];
  googleFormUrl: string | null;
  referrerName?: string;
  referrerEmail?: string;
  formAttachmentPaths?: { resumePath?: string; coverLetterPath?: string };
};

const pendingMultiRole = new Map<string, PendingGoogleFormSession>();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function resolveResumePathForUser(
  telegramChatId: number,
  from: { first_name?: string; last_name?: string; username?: string },
): Promise<string | undefined> {
  const tgName =
    from.first_name || from.last_name
      ? `${from.first_name || ""} ${from.last_name || ""}`.trim()
      : undefined;
  const userPath = await getLatestResumePathForTelegramUser(
    telegramChatId,
    tgName,
    from.username,
  );
  if (userPath && fs.existsSync(userPath)) return userPath;
  return undefined;
}

/** Generates a cover letter PDF when the JD asks for one (or mentions cover letter). */
async function maybeGenerateCoverLetterForGoogleForm(
  rawJD: string,
  roleTitle: string,
  cvText: string,
): Promise<string | undefined> {
  let jobData: ParsedJobDescription;
  try {
    jobData = await parseJobDescription(rawJD);
  } catch {
    return undefined;
  }
  const wantsCover =
    jobData.requiresCoverLetter ||
    /cover\s*letter|covering\s*letter|cv\s+and\s+cover|resume\s+and\s+cover/i.test(
      rawJD,
    );
  if (!wantsCover) return undefined;
  const safe = (jobData.jobTitle || roleTitle || "Application").replace(
    /[^a-zA-Z0-9]/g,
    "_",
  );
  const out = path.join(tmpdir(), `cl_gform_${safe}_${Date.now()}.pdf`);
  return generateCoverLetterPDF(jobData, cvText, out);
}

async function buildGoogleFormFillContext(
  pending: PendingGoogleFormSession,
  telegramChatId: number,
  from: { first_name?: string; last_name?: string; username?: string },
  role: string,
  opts: { reuseCachedAttachments: boolean },
): Promise<{
  fillCtx: GoogleFormFillContext;
  applicantDisplayName: string | undefined;
  resumePath: string | undefined;
  coverLetterPath: string | undefined;
}> {
  const tgName =
    from.first_name || from.last_name
      ? `${from.first_name || ""} ${from.last_name || ""}`.trim()
      : undefined;

  const cvText = await getProfileTextForUserByTelegramChat(
    telegramChatId,
    tgName,
    from.username,
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

  const emailAccount = await getEmailAccountForTelegramUser(
    telegramChatId,
    tgName,
    from.username,
  );

  const links = await getLinksForTelegramUser(
    telegramChatId,
    tgName,
    from.username,
  );
  const github = links.find((l) => l.label === "github")?.url;
  const linkedin = links.find((l) => l.label === "linkedin")?.url;
  const portfolio = links.find((l) => l.label === "portfolio")?.url;

  let resumePath: string | undefined;
  let coverLetterPath: string | undefined;

  if (opts.reuseCachedAttachments && pending.formAttachmentPaths) {
    const r = pending.formAttachmentPaths.resumePath;
    const c = pending.formAttachmentPaths.coverLetterPath;
    if (r && fs.existsSync(r)) resumePath = r;
    if (c && fs.existsSync(c)) coverLetterPath = c;
  }

  if (!resumePath) {
    resumePath = await resolveResumePathForUser(telegramChatId, from);
  }
  if (!coverLetterPath) {
    coverLetterPath = await maybeGenerateCoverLetterForGoogleForm(
      pending.rawJD,
      role,
      cvText,
    );
  }

  const fillCtx: GoogleFormFillContext = {
    ...(role ? { roleTitle: role } : {}),
    ...(applicantDisplayName ? { applicantName: applicantDisplayName } : {}),
    ...(emailAccount?.email_address
      ? { applicantEmail: emailAccount.email_address }
      : {}),
    ...(pending.referrerName ? { referrerName: pending.referrerName } : {}),
    ...(pending.referrerEmail ? { referrerEmail: pending.referrerEmail } : {}),
    ...(github ? { githubUrl: github } : {}),
    ...(linkedin ? { linkedinUrl: linkedin } : {}),
    ...(portfolio ? { portfolioUrl: portfolio } : {}),
    ...(resumePath ? { resumePath } : {}),
    ...(coverLetterPath ? { coverLetterPath } : {}),
  };

  return {
    fillCtx,
    applicantDisplayName,
    resumePath,
    coverLetterPath,
  };
}

export const bot = new Bot<MyContext>(env.TELEGRAM_BOT_TOKEN);

async function startSetProfile(ctx: MyContext) {
  if (!ctx.from) return;

  ctx.session.awaitingProfileText = true;
  ctx.session.currentActionId = null;

  const keyboard = new InlineKeyboard().text(
    "👀 View sample profile",
    "view_sample_profile",
  );

  await ctx.reply(
    "✏️ Send me your profile text in your next message.\n\n" +
      "You can paste your experience, skills and a short summary. " +
      "I’ll use this instead of the default profile when matching and drafting.\n\n" +
      "Need inspiration? Tap below to see a sample.",
    { reply_markup: keyboard },
  );
}

async function startSetResume(ctx: MyContext) {
  if (!ctx.from) return;

  ctx.session.awaitingResumeUpload = true;
  ctx.session.currentActionId = null;

  await ctx.reply(
    "📄 Please upload your resume as a PDF in your next message.\n\n" +
      "I’ll store it securely and attach it to future applications that require a resume.",
  );
}

async function startSetLinks(ctx: MyContext) {
  if (!ctx.from) return;

  const links = await getLinksForTelegramUser(
    ctx.from.id,
    ctx.from.first_name || ctx.from.last_name
      ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
      : undefined,
    ctx.from.username || undefined,
  );

  const github = links.find((l) => l.label === "github")?.url;
  const linkedin = links.find((l) => l.label === "linkedin")?.url;
  const portfolio = links.find((l) => l.label === "portfolio")?.url;

  const keyboard = new InlineKeyboard()
    .text("GitHub", "setlink_github")
    .text("LinkedIn", "setlink_linkedin")
    .row()
    .text("Portfolio", "setlink_portfolio")
    .text("➕ Custom link", "setlink_custom");

  let text = "🔗 Manage your important links.\n\n";
  text += `• GitHub: ${github || "_not set_"}\n`;
  text += `• LinkedIn: ${linkedin || "_not set_"}\n`;
  text += `• Portfolio: ${portfolio || "_not set_"}\n`;
  if (links.length > 0) {
    const custom = links.filter(
      (l) => !["github", "linkedin", "portfolio"].includes(l.label),
    );
    if (custom.length) {
      text += "\nOther links:\n";
      custom.forEach((l) => {
        text += `• ${l.label}: ${l.url}\n`;
      });
    }
  }

  await ctx.reply(text, { reply_markup: keyboard });
}

async function startSetEmail(ctx: MyContext) {
  if (!ctx.from) return;

  ctx.session.awaitingEmailAddress = true;
  ctx.session.awaitingEmailPassword = false;
  ctx.session.currentActionId = null;

  await ctx.reply(
    "📧 Let's connect your email account.\n\n" +
      "Step 1 of 2: Send me the email address you want to send applications from (e.g. `you@gmail.com`).\n\n" +
      "Important: For now I support Gmail with an app password. You can revoke it anytime in your Google Account security settings.",
    { parse_mode: "Markdown" },
  );
}

// Session middleware
bot.use(
  session({
    initial: (): SessionData => ({
      awaitingResumeName: false,
      awaitingRevision: false,
      currentActionId: null,
      awaitingProfileText: false,
      awaitingResumeUpload: false,
      awaitingLinkType: null,
      awaitingCustomLinkLabel: false,
      awaitingEmailAddress: false,
      awaitingEmailPassword: false,
    }),
  }),
);

const pendingEmails = new Map<
  string,
  {
    jobData: ParsedJobDescription;
    match: any;
    draft: EmailDraft;
    customResumeName?: string;
    coverLetterPath?: string;
    userId: number;
  }
>();

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
  saveAdminChatId(adminId);

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

  const events = getRecentUserEvents(user.id, 5);

  let msg = "🧾 **Your setup status**\n\n";
  msg += `${emailAccount ? "✅" : "⚠️"} Email connected\n`;
  msg += `${resumePath ? "✅" : "⚠️"} Resume uploaded\n`;
  msg += `✅ Profile text set (you can update with /set_profile)\n`;
  msg += `${links.length ? "✅" : "ℹ️"} Links configured\n\n`;

  if (events.length) {
    msg += "**Recent activity:**\n";
    events.forEach((e, i) => {
      msg += `${i + 1}. ${e.type}${e.detail ? ` — ${e.detail}` : ""}\n`;
    });
  } else {
    msg += "_No activity yet._";
  }

  await ctx.reply(msg, { parse_mode: "Markdown" });
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
    logUserEvent(user.id, "resume_uploaded", path.basename(localPath));
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
      logUserEvent(user.id, "email_connected", emailAddress);
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
      logUserEvent(user.id, "profile_updated");
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
        logUserEvent(user.id, "link_updated", `${kind}: ${url}`);
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
          logUserEvent(user.id, "link_added", `${label}: ${url}`);
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
    const revisedDraft = await reviseEmailDraft(pending.draft, rawJD);
    pending.draft = revisedDraft;

    ctx.session.awaitingRevision = false;
    ctx.session.currentActionId = null;

    let replyText = `**Job Parsed Successfully**\n`;
    replyText += `**Role:** ${pending.jobData.jobTitle}\n`;
    replyText += `**Company:** ${pending.jobData.companyName || "Not specified"}\n`;
    replyText += `**Values:** ${pending.jobData.companyValues ? (pending.jobData.companyValues.length > 50 ? pending.jobData.companyValues.substring(0, 50) + "..." : pending.jobData.companyValues) : "Not specified"}\n`;
    replyText += `**Required Exp:** ${pending.jobData.requiredExperience}\n`;
    replyText += `**Key Skills:** ${pending.jobData.keySkills.join(", ")}\n`;
    replyText += `**Email:** ${pending.jobData.applicationEmail || "Not Found"}\n\n`;

    replyText += `**Match Evaluation:**\n`;
    replyText += `📊 Score: ${pending.match.matchScore}%\n`;
    replyText += `💡 Feedback: ${pending.match.feedback}\n\n`;

    replyText += `**Email Draft (Revised):**\n`;
    replyText += `*Subject:* ${revisedDraft.subject}\n`;
    replyText += `*Body:*\n${revisedDraft.bodyText}`;

    const keyboard = new InlineKeyboard()
      .text("📝 Edit Draft", `edit_${actionId}`)
      .text("✏️ Rename Resume", `rename_${actionId}`)
      .row()
      .text("🚀 Send Email", `send_${actionId}`)
      .text("❌ Cancel", `cancel_${actionId}`);

    await ctx.reply(replyText, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
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

    const keyboard = new InlineKeyboard()
      .text("📝 Edit Draft", `edit_${actionId}`)
      .text("✏️ Rename Resume", `rename_${actionId}`)
      .row()
      .text("🚀 Send Email", `send_${actionId}`)
      .text("❌ Cancel", `cancel_${actionId}`);

    await ctx.reply(
      `✅ Resume attachment renamed to:\n\`${pending.customResumeName}\`\n\nReady to send?`,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      },
    );
    return;
  }

  if (!looksLikeJobDescription(rawJD)) {
    await ctx.reply(
      "That doesn’t look like a job description. Send me the full job posting (role, company, requirements) and I’ll draft an application",
    );
    return;
  }

  const roles = extractRoles(rawJD);
  const googleFormUrl = extractGoogleFormUrl(rawJD);
  const ref = extractReferrerDetails(rawJD);

  if (googleFormUrl && roles.length <= 1) {
    const token = `form_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const role = roles[0] || "This role";
    pendingMultiRole.set(token, {
      rawJD,
      roles: [role],
      googleFormUrl,
      ...(ref.referrerName ? { referrerName: ref.referrerName } : {}),
      ...(ref.referrerEmail ? { referrerEmail: ref.referrerEmail } : {}),
    });

    const keyboard = new InlineKeyboard()
      .text("🧾 Fill Google Form (review)", `fillform_${token}_0`)
      .text("❌ Cancel", `pickrole_cancel_${token}`);

    await ctx.reply(
      `I found a Google Form application link. Do you want me to fill it now?\n\nRole: ${role}`,
      { reply_markup: keyboard },
    );
    return;
  }

  if (roles.length > 1) {
    const token = `roles_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    pendingMultiRole.set(token, {
      rawJD,
      roles,
      googleFormUrl,
      ...(ref.referrerName ? { referrerName: ref.referrerName } : {}),
      ...(ref.referrerEmail ? { referrerEmail: ref.referrerEmail } : {}),
    });

    const keyboard = new InlineKeyboard();
    roles.forEach((r, idx) => {
      const label = r.length > 40 ? `${r.slice(0, 40)}…` : r;
      keyboard.text(label, `pickrole_${token}_${idx}`).row();
    });
    keyboard.text("❌ Cancel", `pickrole_cancel_${token}`);

    await ctx.reply(
      `I found multiple roles in this post. Which one do you want to apply for?\n\n` +
        roles.map((r, i) => `${i + 1}. ${r}`).join("\n"),
      { reply_markup: keyboard },
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

    // Resolve per-user profile text (seeded from myCV by default)
    const from = ctx.from!;
    const cvText = await getProfileTextForUserByTelegramChat(
      telegramChatId,
      from.first_name || from.last_name
        ? `${from.first_name || ""} ${from.last_name || ""}`.trim()
        : undefined,
      from.username || undefined,
    );

    const match = await evaluateMatch(jobData, cvText);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "✍️ Drafting application email...",
    );

    const draft = await generateEmailDraft(jobData, cvText, match.feedback);

    if (jobData.requiresCoverLetter) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "📄 Generating tailored Cover Letter PDF...",
      );
    }

    let coverLetterFilename: string | undefined;
    let coverLetterPath: string | undefined;
    if (jobData.requiresCoverLetter) {
      coverLetterFilename = `Cover_Letter_${jobData.jobTitle.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`;
      coverLetterPath = await generateCoverLetterPDF(
        jobData,
        cvText,
        `./${coverLetterFilename}`,
      );
    }

    // Save state in memory cache
    const actionId = `draft_${Date.now()}`;
    const newPendingEmail: {
      jobData: ParsedJobDescription;
      match: any;
      draft: EmailDraft;
      customResumeName?: string;
      coverLetterPath?: string;
      userId: number;
    } = { jobData, match, draft, userId: user.id };

    if (coverLetterPath) {
      newPendingEmail.coverLetterPath = coverLetterPath;
    }

    pendingEmails.set(actionId, newPendingEmail);

    //Final Message
    let replyText = `**Job Parsed Successfully**\n`;
    replyText += `**Role:** ${jobData.jobTitle}\n`;
    replyText += `**Company:** ${jobData.companyName || "Not specified"}\n`;
    replyText += `**Values:** ${jobData.companyValues ? (jobData.companyValues.length > 50 ? jobData.companyValues.substring(0, 50) + "..." : jobData.companyValues) : "Not specified"}\n`;
    replyText += `**Required Exp:** ${jobData.requiredExperience}\n`;
    replyText += `**Key Skills:** ${jobData.keySkills.join(", ")}\n`;
    replyText += `**Email:** ${jobData.applicationEmail || "Not Found"}\n\n`;

    replyText += `**Match Evaluation:**\n`;
    replyText += `📊 Score: ${match.matchScore}%\n`;
    replyText += `💡 Feedback: ${match.feedback}\n\n`;

    replyText += `**Email Draft:**\n`;
    replyText += `*Subject:* ${draft.subject}\n`;
    replyText += `*Body:*\n${draft.bodyText}`;

    // 7. Send Telegram Message with Inline Keyboard
    const keyboard = new InlineKeyboard();

    if (jobData.applicationEmail) {
      const displayName =
        (ctx.from.first_name || ctx.from.last_name
          ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim()
          : myCV.name) || myCV.name;

      const dynamicFilename = `${displayName.replace(/\s+/g, "_")}_${jobData.jobTitle.replace(/[^a-zA-Z0-9]/g, "_")}_Resume.pdf`;

      keyboard.text("📝 Edit Draft", `edit_${actionId}`);

      const userResumePath = await getLatestResumePathForTelegramUser(
        telegramChatId,
        from.first_name || from.last_name
          ? `${from.first_name || ""} ${from.last_name || ""}`.trim()
          : undefined,
        from.username || undefined,
      );
      const resumeFileExists =
        userResumePath !== null && fs.existsSync(userResumePath);

      replyText += `\n\n📎 *Attachments ready:*\n`;

      if (jobData.requiresResume) {
        if (resumeFileExists) {
          replyText += `- \`${dynamicFilename}\` (from your /set_resume upload)\n`;
          keyboard.text("✏️ Rename Resume", `rename_${actionId}`).row();
        } else {
          replyText += `⚠️ *No Resume Found:* The JD requested a resume. Upload one via /set_resume.\n`;
        }
      } else {
        replyText += `- Resume skipped (Not requested by JD)\n`;
      }

      if (
        jobData.requiresCoverLetter &&
        coverLetterFilename &&
        coverLetterPath
      ) {
        replyText += `- \`${coverLetterFilename}\`\n`;
      } else {
        replyText += `- Cover Letter skipped (Not requested by JD)\n`;
      }

      keyboard.text("🚀 Send Email", `send_${actionId}`);
      keyboard.text("❌ Cancel", `cancel_${actionId}`);
    } else {
      replyText += `\n\n⚠️ No application email was found in the JD, so I cannot send it via Gmail.`;
    }

    await ctx.reply(replyText, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
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
  });

  if (result.success) {
    const fields = result.filledFields ?? [];
    const filledSummary =
      fields.length > 0
        ? fields
            .map(
              (f) =>
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
    await ctx.answerCallbackQuery({
      text: "Session expired.",
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
      ...(from.first_name !== undefined
        ? { first_name: from.first_name }
        : {}),
      ...(from.last_name !== undefined ? { last_name: from.last_name } : {}),
      ...(from.username !== undefined ? { username: from.username } : {}),
    },
    role,
    { reuseCachedAttachments: true },
  );

  const result = await autoFillGoogleForm(pending.googleFormUrl, fillCtx, {
    submit: true,
  });

  if (token) pendingMultiRole.delete(token);

  await ctx.editMessageText(
    result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
  );
  await ctx.answerCallbackQuery();
});

// Handle "View sample profile" button
bot.callbackQuery("view_sample_profile", async (ctx) => {
  const sample =
    "Here’s a sample profile, you can copy this and edit to fit your own:\n\n" +
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
    );

    if (result.success) {
      logUserEvent(pending.userId, "email_sent", pending.jobData.jobTitle);
      await ctx.editMessageText(
        `✅ **Application Sent!**\n\nTo: \`${pending.jobData.applicationEmail}\`\nSubject: \`${pending.draft.subject}\``,
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

const BOT_MENU_COMMANDS = [
  { command: "start", description: "Wake up the bot and see setup checklist" },
  {
    command: "set_email",
    description: "Set or update your email for sending applications",
  },
  { command: "set_resume", description: "Upload or update your resume (PDF)" },
  {
    command: "set_profile",
    description: "Set or update your profile text for matching",
  },
  {
    command: "set_links",
    description: "Set or update GitHub, LinkedIn, portfolio & custom links",
  },
  {
    command: "job_hunt",
    description: "Manually trigger an automated job search (disabled)",
  },
  {
    command: "my_status",
    description: "See your setup status and recent activity",
  },
];

export async function startBot() {
  try {
    await bot.api.setMyCommands(BOT_MENU_COMMANDS);
    console.log("📋 Bot menu commands updated.");
  } catch (e) {
    console.error("Failed to set bot menu commands:", e);
  }
  bot.start();
  console.log("🤖 Job Agent Bot is running...");

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
}

/** Call this to refresh the bot's command menu (e.g. from /start so clients see the latest list). */
export async function refreshBotMenu() {
  try {
    await bot.api.setMyCommands(BOT_MENU_COMMANDS);
  } catch (e) {
    console.error("Failed to refresh bot menu:", e);
  }
}
