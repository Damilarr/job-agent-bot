import { Bot, InlineKeyboard, Context, session } from 'grammy';
import { env } from '../config/env.js';
import { myCV, formatCVForPrompt } from '../data/cv.js';
import { parseJobDescription } from './parser.js';
import type { ParsedJobDescription } from './parser.js';
import { evaluateMatch } from './matcher.js';
import { generateEmailDraft, reviseEmailDraft } from './drafter.js';
import type { EmailDraft } from './drafter.js';
import { generateCoverLetterPDF } from './coverLetter.js';
import { sendApplicationEmail } from './email.js';
import { runAutoApplyCycle } from './autoApply.js';
import { saveAdminChatId } from '../data/db.js';
import fs from 'fs';
import path from 'path';

// Define the bot and store data temporarily in memory for the callback
interface SessionData {
  awaitingResumeName: boolean;
  awaitingRevision: boolean;
  currentActionId: string | null;
}

type MyContext = Context & {
  session: SessionData;
};

export const bot = new Bot<MyContext>(env.TELEGRAM_BOT_TOKEN);

// Session middleware
bot.use(session({ initial: (): SessionData => ({ awaitingResumeName: false, awaitingRevision: false, currentActionId: null }) }));

const pendingEmails = new Map<string, { jobData: ParsedJobDescription, match: any, draft: EmailDraft, customResumeName?: string, coverLetterPath?: string }>();

const cvText = formatCVForPrompt(myCV);

bot.command('start', (ctx) => {
  if (!ctx.from) return;
  const adminId = ctx.from.id;
  saveAdminChatId(adminId);
  ctx.reply("👋 Hello! I'm your Job Application Agent.\n\nSend me a messy job description or run /job_hunt to start an automated search!");
});

bot.command('job_hunt', async (ctx) => {
  if (!ctx.from) return;
  const adminId = ctx.from.id;
  saveAdminChatId(adminId);

  ctx.reply("🚀 Initiating Automated Job Hunt Cycle manually... I will notify you with the results and any applied jobs.");
  
  runAutoApplyCycle().catch(err => {
    console.error("Manual job hunt failed:", err);
    ctx.reply("❌ An error occurred during the automated job hunt.");
  });
});

bot.on('message:text', async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  const rawJD = ctx.message.text;

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
    replyText += `**Company:** ${pending.jobData.companyName || 'Not specified'}\n`;
    replyText += `**Values:** ${pending.jobData.companyValues ? (pending.jobData.companyValues.length > 50 ? pending.jobData.companyValues.substring(0, 50) + '...' : pending.jobData.companyValues) : 'Not specified'}\n`;
    replyText += `**Required Exp:** ${pending.jobData.requiredExperience}\n`;
    replyText += `**Key Skills:** ${pending.jobData.keySkills.join(', ')}\n`;
    replyText += `**Email:** ${pending.jobData.applicationEmail || "Not Found"}\n\n`;
    
    replyText += `**Match Evaluation:**\n`;
    replyText += `📊 Score: ${pending.match.matchScore}%\n`;
    replyText += `💡 Feedback: ${pending.match.feedback}\n\n`;

    replyText += `**Email Draft (Revised):**\n`;
    replyText += `*Subject:* ${revisedDraft.subject}\n`;
    replyText += `*Body:*\n${revisedDraft.bodyText}`;

    const keyboard = new InlineKeyboard()
      .text("📝 Edit Draft", `edit_${actionId}`)
      .text("✏️ Rename Resume", `rename_${actionId}`).row()
      .text("🚀 Send Email", `send_${actionId}`)
      .text("❌ Cancel", `cancel_${actionId}`);

    await ctx.reply(replyText, { parse_mode: "Markdown", reply_markup: keyboard });
    return;
  }

  // Check if we are waiting for a filename
  if (ctx.session.awaitingResumeName && ctx.session.currentActionId) {
    const actionId = ctx.session.currentActionId;
    const pending = pendingEmails.get(actionId);

    if (!pending) {
      await ctx.reply("❌ Session expired for resume renaming. Please start over.");
      ctx.session.awaitingResumeName = false;
      ctx.session.currentActionId = null;
      return;
    }

    let newName = rawJD.trim();
    if (!newName.toLowerCase().endsWith('.pdf')) {
      newName += '.pdf';
    }
    // Basic sanitization
    newName = newName.replace(/[^a-zA-Z0-9_.-]/g, '_');
    pending.customResumeName = newName;
    
    ctx.session.awaitingResumeName = false;
    ctx.session.currentActionId = null;
    
    const keyboard = new InlineKeyboard()
      .text("📝 Edit Draft", `edit_${actionId}`)
      .text("✏️ Rename Resume", `rename_${actionId}`).row()
      .text("🚀 Send Email", `send_${actionId}`)
      .text("❌ Cancel", `cancel_${actionId}`);

    await ctx.reply(`✅ Resume attachment renamed to:\n\`${pending.customResumeName}\`\n\nReady to send?`, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    return;
  }

  const statusMsg = await ctx.reply("🔍 Analyzing the job description...");

  try {
    const jobData: ParsedJobDescription = await parseJobDescription(rawJD);
    
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "⚙️ Evaluating match score...");

    const match = await evaluateMatch(jobData, cvText);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✍️ Drafting application email...");

    const draft = await generateEmailDraft(jobData, cvText, match.feedback);

    if (jobData.requiresCoverLetter) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "📄 Generating tailored Cover Letter PDF...");
    }

    let coverLetterFilename: string | undefined;
    let coverLetterPath: string | undefined;
    if (jobData.requiresCoverLetter) {
      coverLetterFilename = `Cover_Letter_${jobData.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      coverLetterPath = await generateCoverLetterPDF(jobData, cvText, `./${coverLetterFilename}`);
    }

    // Save state in memory cache
    const actionId = `draft_${Date.now()}`;
    const newPendingEmail: {
      jobData: ParsedJobDescription;
      match: any;
      draft: EmailDraft;
      customResumeName?: string;
      coverLetterPath?: string;
    } = { jobData, match, draft };

    if (coverLetterPath) {
      newPendingEmail.coverLetterPath = coverLetterPath;
    }

    pendingEmails.set(actionId, newPendingEmail);


    //Final Message
    let replyText = `**Job Parsed Successfully**\n`;
    replyText += `**Role:** ${jobData.jobTitle}\n`;
    replyText += `**Company:** ${jobData.companyName || 'Not specified'}\n`;
    replyText += `**Values:** ${jobData.companyValues ? (jobData.companyValues.length > 50 ? jobData.companyValues.substring(0, 50) + '...' : jobData.companyValues) : 'Not specified'}\n`;
    replyText += `**Required Exp:** ${jobData.requiredExperience}\n`;
    replyText += `**Key Skills:** ${jobData.keySkills.join(', ')}\n`;
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
      const dynamicFilename = `${myCV.name.replace(/\s+/g, '_')}_${jobData.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}_Resume.pdf`;

      keyboard.text("📝 Edit Draft", `edit_${actionId}`)
      
      const resumeFileExists = fs.existsSync('./resume.pdf');
      
      let attachments = [];
      replyText += `\n\n📎 *Attachments ready:*\n`;
      let attachedSomething = false;

      if (jobData.requiresResume) {
        if (resumeFileExists) {
           attachments.push({ filename: dynamicFilename, path: './resume.pdf' });
           replyText += `- \`${dynamicFilename}\`\n`;
           attachedSomething = true;
           keyboard.text("✏️ Rename Resume", `rename_${actionId}`).row();
        } else {
           replyText += `⚠️ *No Resume Found:* The JD requested a resume, but please place a \`resume.pdf\` file in the project root folder if you want it included.\n`;
        }
      } else {
         replyText += `- Resume skipped (Not requested by JD)\n`;
      }
      
      if (jobData.requiresCoverLetter && coverLetterFilename && coverLetterPath) {
        attachments.push({ filename: coverLetterFilename, path: coverLetterPath });
        replyText += `- \`${coverLetterFilename}\`\n`;
        attachedSomething = true;
      } else {
        replyText += `- Cover Letter skipped (Not requested by JD)\n`;
      }
      
      keyboard.text("🚀 Send Email", `send_${actionId}`)
      keyboard.text("❌ Cancel", `cancel_${actionId}`);

    } else {
       replyText += `\n\n⚠️ No application email was found in the JD, so I cannot send it via Gmail.`;
    }

    await ctx.reply(replyText, { parse_mode: "Markdown", reply_markup: keyboard });

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);

  } catch (error: any) {
    console.error("Error processing text message:", error);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ An error occurred: ${error.message}`);
  }
});

// Handle Edit button
bot.callbackQuery(/^edit_(.+)$/, async (ctx) => {
  try {
    const actionId = ctx.match[1];
    if (!actionId) return;
    
    const pending = pendingEmails.get(actionId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Session expired or invalid.", show_alert: true });
      return;
    }

    ctx.session.awaitingRevision = true;
    ctx.session.currentActionId = actionId;

    await ctx.reply("📝 What would you like to change about the draft? (e.g. 'Make it more formal', 'Remove the second sentence')");
    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({ text: "Error preparing edit.", show_alert: true });
  }
});

// Handle Rename button
bot.callbackQuery(/^rename_(.+)$/, async (ctx) => {
  try {
    const actionId = ctx.match[1];
    if (!actionId) return;
    
    const pending = pendingEmails.get(actionId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Session expired or invalid.", show_alert: true });
      return;
    }

    ctx.session.awaitingResumeName = true;
    ctx.session.currentActionId = actionId;

    const currentName = pending.customResumeName || 'resume.pdf';
    await ctx.reply(`Current resume filename: \`${currentName}\`\n\nPlease type the new filename (e.g. \`Emmanuel_Frontend_CV.pdf\`):`, {
      parse_mode: 'Markdown'
    });
    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({ text: "Error starting rename.", show_alert: true });
  }
});

// Handle Send Email
bot.callbackQuery(/^send_(.+)$/, async (ctx) => {
  try {
    const actionId = ctx.match[1];
    if (!actionId) return;
    
    const pending = pendingEmails.get(actionId);

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Email data expired or already sent.", show_alert: true });
      return;
    }

    if (!pending.jobData.applicationEmail) {
      await ctx.answerCallbackQuery({ text: "No application email was found for this job.", show_alert: true });
      return;
    }

    // Attach Cover Letter if we generated one
    const attachments = [];
    if (pending.coverLetterPath) {
      attachments.push({ filename: 'Cover_Letter.pdf', path: pending.coverLetterPath });
    }
    
    if (fs.existsSync(path.resolve(process.cwd(), 'resume.pdf'))) {
      const finalName = pending.customResumeName || 'resume.pdf';
      attachments.push({ filename: finalName, path: path.resolve(process.cwd(), 'resume.pdf') });
    }

    await ctx.editMessageText(`🚀 Sending email to ${pending.jobData.applicationEmail}...`);

    await sendApplicationEmail({
      to: pending.jobData.applicationEmail,
      subject: pending.draft.subject,
      bodyText: pending.draft.bodyText,
      attachments: attachments
    });

    await ctx.editMessageText(`✅ **Application Sent!**\n\nTo: \`${pending.jobData.applicationEmail}\`\nSubject: \`${pending.draft.subject}\``, { parse_mode: "Markdown" });

    pendingEmails.delete(actionId);

  } catch (error) {
    console.error("Failed to send email via callback:", error);
    await ctx.answerCallbackQuery({ text: "Failed to send email. Check console.", show_alert: true });
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

export function startBot() {
  bot.start();
  console.log("🤖 Job Agent Bot is running...");
  
  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());
}
