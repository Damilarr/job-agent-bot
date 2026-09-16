import fs from "fs";
import { InlineKeyboard } from "grammy";
import type { DraftTone } from "../services/drafter.js";
import { composeEmailBody } from "../services/drafter.js";
import type { PendingEmail } from "./state.js";
import { escapeHtml } from "./utils.js";

export interface EmailAttachment {
  filename: string;
  path: string;
}

const TONE_LABELS: Record<DraftTone, string> = {
  confident: "💪 Confident",
  formal: "🎩 Formal",
  friendly: "😊 Friendly",
};

/** "Jane O'Doe" -> "Jane_O_Doe", used to name attachments after the applicant. */
function attachmentBaseName(applicantName: string | undefined): string {
  const base = (applicantName || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base || "Applicant";
}

export function resumeAttachmentName(pending: PendingEmail): string {
  return pending.customResumeName || `${attachmentBaseName(pending.draftCtx.applicantName)}_Resume.pdf`;
}

/** Attachments that exist on disk, plus the names of any that were expected but are missing. */
export function getEmailAttachments(pending: PendingEmail): { attachments: EmailAttachment[]; missing: string[] } {
  const attachments: EmailAttachment[] = [];
  const missing: string[] = [];

  if (pending.resumePath) {
    if (fs.existsSync(pending.resumePath)) {
      attachments.push({ filename: resumeAttachmentName(pending), path: pending.resumePath });
    } else {
      missing.push("resume");
    }
  }

  if (pending.coverLetterPath) {
    if (fs.existsSync(pending.coverLetterPath)) {
      attachments.push({
        filename: `${attachmentBaseName(pending.draftCtx.applicantName)}_Cover_Letter.pdf`,
        path: pending.coverLetterPath,
      });
    } else {
      missing.push("cover letter");
    }
  }

  return { attachments, missing };
}

/** The exact plain-text body that will be sent, including attachment note and signature. */
export function composePendingEmailBody(pending: PendingEmail): string {
  const { attachments } = getEmailAttachments(pending);
  return composeEmailBody(pending.draft, pending.draftCtx, {
    resume: attachments.some((a) => a.path === pending.resumePath),
    coverLetter: attachments.some((a) => a.path === pending.coverLetterPath),
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Renders the job summary, match evaluation and full email preview as Telegram HTML.
 * All user- and model-provided text is escaped, so underscores or asterisks in a job post cannot break parsing.
 */
export function renderDraftPreview(
  pending: PendingEmail,
  actionId: string,
  heading = "Job Parsed Successfully",
): { text: string; keyboard: InlineKeyboard } {
  const { jobData, match, draft } = pending;
  const { attachments } = getEmailAttachments(pending);

  let text = `<b>${escapeHtml(heading)}</b>\n`;
  text += `<b>Role:</b> ${escapeHtml(jobData.jobTitle)}\n`;
  text += `<b>Company:</b> ${escapeHtml(jobData.companyName || "Not specified")}\n`;
  text += `<b>Required Exp:</b> ${escapeHtml(jobData.requiredExperience)}\n`;
  text += `<b>Key Skills:</b> ${escapeHtml(truncate(jobData.keySkills.join(", "), 300))}\n\n`;

  text += `📊 <b>Match:</b> ${match.matchScore}%\n`;
  text += `💡 ${escapeHtml(truncate(match.feedback, 500))}\n\n`;

  text += `<b>✉️ Email draft</b> (${TONE_LABELS[pending.tone]})\n`;
  text += `<b>To:</b> ${escapeHtml(jobData.applicationEmail || "No application email found")}\n`;
  text += `<b>Subject:</b> ${escapeHtml(draft.subject)}\n`;
  text += `<blockquote>${escapeHtml(composePendingEmailBody(pending))}</blockquote>\n`;

  text += `\n📎 <b>Attachments:</b>\n`;
  for (const a of attachments) text += `• <code>${escapeHtml(a.filename)}</code>\n`;
  if (!pending.resumePath) text += `⚠️ No resume found. Upload one via /set_resume so it can be attached.\n`;
  if (pending.coverLetterError) text += `⚠️ Cover letter skipped: ${escapeHtml(truncate(pending.coverLetterError, 200))}\n`;
  if (!jobData.applicationEmail) text += `\n⚠️ No application email was found in the job post, so this can't be sent from here.`;

  const keyboard = new InlineKeyboard().text("📝 Edit Draft", `edit_${actionId}`);
  if (pending.resumePath) keyboard.text("✏️ Rename Resume", `rename_${actionId}`);
  keyboard.row();
  if (jobData.applicationEmail) keyboard.text("🚀 Send Email", `send_${actionId}`);
  keyboard.text("❌ Cancel", `cancel_${actionId}`).row();
  for (const tone of Object.keys(TONE_LABELS) as DraftTone[]) {
    keyboard.text(TONE_LABELS[tone], `tone_${tone}_${actionId}`);
  }

  return { text, keyboard };
}
