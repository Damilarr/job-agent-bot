import { Bot, InlineKeyboard } from 'grammy';
import { env } from '../config/env.js';
import { myCV, formatCVForPrompt } from '../data/cv.js';
import { parseJobDescription } from './parser.js';
import type { ParsedJobDescription } from './parser.js';
import { evaluateMatch } from './matcher.js';
import { generateEmailDraft } from './drafter.js';
import type { EmailDraft } from './drafter.js';
import { generateCoverLetterPDF } from './coverLetter.js';
import { sendApplicationEmail } from './email.js';
import { runAutoApplyCycle } from './autoApply.js';
import { saveAdminChatId } from '../data/db.js';
import fs from 'fs';

// Define the bot and store data temporarily in memory for the callback
// In a production app, use a database or Redis to store pending applications.
const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
const pendingEmails = new Map<number, { payload: any, draft: EmailDraft, status: 'ready' | 'waiting_for_filename' }>();

// Formatted CV string
const cvText = formatCVForPrompt(myCV);

bot.command('start', (ctx) => {
  if (!ctx.from) return;
  const adminId = ctx.from.id;
  saveAdminChatId(adminId); // Save persistently
  ctx.reply("👋 Hello! I'm your Job Application Agent.\n\nSend me a messy job description or run /job_hunt to start an automated search!");
});

bot.command('job_hunt', async (ctx) => {
  if (!ctx.from) return;
  const adminId = ctx.from.id;
  saveAdminChatId(adminId); // Save persistently

  ctx.reply("🚀 Initiating Automated Job Hunt Cycle manually... I will notify you with the results and any applied jobs.");
  
  // Run async without blocking the response
  runAutoApplyCycle().catch(err => {
    console.error("Manual job hunt failed:", err);
    ctx.reply("❌ An error occurred during the automated job hunt.");
  });
});

bot.on('message:text', async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  const rawJD = ctx.message.text;

  // Check if we are waiting for a filename
  if (pendingEmails.has(userId)) {
    const pending = pendingEmails.get(userId)!;
    if (pending.status === 'waiting_for_filename') {
      if (pending.payload.attachments && pending.payload.attachments.length > 0) {
        let newName = rawJD.trim();
        // Ensure it ends in .pdf
        if (!newName.toLowerCase().endsWith('.pdf')) {
          newName += '.pdf';
        }
        // Basic sanitization
        newName = newName.replace(/[^a-zA-Z0-9_.-]/g, '_');
        pending.payload.attachments[0].filename = newName;
      }
      
      pending.status = 'ready';
      
      const keyboard = new InlineKeyboard()
        .text("🚀 Send Email", "send_email").row()
        .text("✏️ Rename Attachment", "rename_attachment").row()
        .text("❌ Cancel", "cancel");

      await ctx.reply(`✅ Attachment renamed to:\n\`${pending.payload.attachments[0].filename}\`\n\nReady to send?`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      return;
    }
  }

  // Let the user know we're working on it
  const statusMsg = await ctx.reply("🔍 Analyzing the job description...");

  try {
    // 1. Parse JD
    const jobData: ParsedJobDescription = await parseJobDescription(rawJD);
    
    // Update status
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "⚙️ Evaluating match score...");

    // 2. Evaluate Match
    const match = await evaluateMatch(jobData, cvText);

    // Update status
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✍️ Drafting application email...");

    // 4. Draft Email
    const draft = await generateEmailDraft(jobData, cvText, match.feedback);

    // Update status
    if (jobData.requiresCoverLetter) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "📄 Generating tailored Cover Letter PDF...");
    }

    // 5. Generate Cover Letter only if requested
    let coverLetterFilename: string | undefined;
    let coverLetterPath: string | undefined;
    if (jobData.requiresCoverLetter) {
      coverLetterFilename = `Cover_Letter_${jobData.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      coverLetterPath = await generateCoverLetterPDF(jobData, cvText, `./${coverLetterFilename}`);
    }

    // 6. Construct Final Message
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
      // Make a professional dynamic filename based on CV name and Job Title
      const dynamicFilename = `${myCV.name.replace(/\s+/g, '_')}_${jobData.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}_Resume.pdf`;

      keyboard.text("🚀 Send Email", "send_email").row();

      // Check if resume.pdf exists in the project root
      const resumeFileExists = fs.existsSync('./resume.pdf');
      
      let attachments = [];
      replyText += `\n\n📎 *Attachments ready:*\n`;
      let attachedSomething = false;

      if (jobData.requiresResume) {
        if (resumeFileExists) {
           attachments.push({ filename: dynamicFilename, path: './resume.pdf' });
           replyText += `- \`${dynamicFilename}\`\n`;
           attachedSomething = true;
           keyboard.text("✏️ Rename Resume", "rename_attachment").row();
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
      
      keyboard.text("❌ Cancel", "cancel");

      // Store data for the callback
      pendingEmails.set(userId, { 
        status: 'ready',
        payload: { 
          to: jobData.applicationEmail,
          attachments: attachments
        },
        draft: draft 
      });
    } else {
       replyText += `\n\n⚠️ No application email was found in the JD, so I cannot send it via Gmail.`;
    }

    await ctx.reply(replyText, { parse_mode: "Markdown", reply_markup: keyboard });

    // Clean up status message
    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);

  } catch (error: any) {
    console.error("Error processing text message:", error);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ An error occurred: ${error.message}`);
  }
});

// Handle Callbacks
bot.callbackQuery('rename_attachment', async (ctx) => {
  const userId = ctx.from.id;
  const pending = pendingEmails.get(userId);

  if (!pending) {
    await ctx.answerCallbackQuery({ text: "Session expired or invalid.", show_alert: true });
    return;
  }

  pending.status = 'waiting_for_filename';
  
  const currentName = pending.payload.attachments?.[0]?.filename || 'resume.pdf';

  await ctx.answerCallbackQuery();
  await ctx.reply(`The current attachment name is:\n\`${currentName}\`\n\nPlease reply with the new filename you want to use (e.g. My_Custom_Resume):`, { parse_mode: 'Markdown' });
});

bot.callbackQuery('send_email', async (ctx) => {
  const userId = ctx.from.id;
  const pending = pendingEmails.get(userId);

  if (!pending) {
    await ctx.answerCallbackQuery({ text: "Session expired or invalid. Please try again.", show_alert: true });
    return;
  }

  // Acknowledge the button press
  await ctx.answerCallbackQuery("Sending email...");

  // Execute Send
  const result = await sendApplicationEmail({
    to: pending.payload.to,
    subject: pending.draft.subject,
    bodyText: pending.draft.bodyText,
    attachments: pending.payload.attachments
  });

  if (result.success) {
    // Edit the message to show success
    const newText = ctx.callbackQuery.message?.text + `\n\n✅ **Email Sent Successfully!** (ID: ${result.id})`;
    await ctx.editMessageText(newText, { parse_mode: 'Markdown' }); // Removed the keyboard
    pendingEmails.delete(userId); // Clear memory
  } else {
    await ctx.answerCallbackQuery({ text: `Failed to send email: ${result.error}`, show_alert: true });
  }
});

bot.callbackQuery('cancel', async (ctx) => {
  const userId = ctx.from.id;
  pendingEmails.delete(userId);
  await ctx.answerCallbackQuery("Application canceled.");
  const newText = ctx.callbackQuery.message?.text + `\n\n❌ **Application Canceled.**`;
  await ctx.editMessageText(newText, { parse_mode: 'Markdown' }); 
});

// Start the bot gracefully
export function startBot() {
  bot.start();
  console.log("🤖 Job Agent Bot is running...");
  
  // Enable graceful stop
  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());
}
