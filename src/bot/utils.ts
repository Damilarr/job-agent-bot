import fs from "fs";
import { InlineKeyboard } from "grammy";
import { tmpdir } from "os";
import path from "path";
import {
    getEmailAccountForTelegramUser,
    getLatestResumePathForTelegramUser,
    getLinksForTelegramUser,
    getProfileTextForUserByTelegramChat,
    resolveApplicantDisplayNameForForms
} from "../data/profile.js";
import { generateCoverLetterPDF } from "../services/coverLetter.js";
import type { ParsedJobDescription } from "../services/parser.js";
import { parseJobDescription } from "../services/parser.js";
import type { MyContext } from "./types.js";

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

export { escapeHtml, extractReferrerDetails, extractRoles, looksLikeJobDescription, resolveResumePathForUser, startSetEmail, startSetLinks, startSetProfile, startSetResume };
