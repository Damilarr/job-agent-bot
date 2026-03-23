import { fetchJobsFromHN, fetchJobsFromLinkedIn, fetchJobsFromX } from './sourcing.js';
import type { Job } from './sourcing.js';
import { parseJobDescription } from './parser.js';
import type { ParsedJobDescription } from './parser.js';
import { evaluateMatch } from './matcher.js';
import { generateEmailDraft } from './drafter.js';
import { generateCoverLetterPDF } from './coverLetter.js';
import { sendApplicationEmailForUser } from './email.js';
import { autoFillApplication } from './formFiller.js';
import { hasJobBeenProcessed, logProcessedJob, getAdminChatId, getOrCreateUserByTelegramChat, addUserApplication } from '../data/db.js';
import type { DBJobRecord } from '../data/db.js';
import fs from 'fs';
import { myCV, formatCVForPrompt } from '../data/cv.js';
import {
  getLatestResumePathForTelegramUser,
  getLinksForTelegramUser,
  resolveApplicantDisplayNameForForms,
} from '../data/profile.js';
import type { DraftContext } from './drafter.js';
import { Bot } from 'grammy';
import { env } from '../config/env.js';

const MIN_MATCH_SCORE = 60;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


export async function runAutoApplyCycle() {
  console.log("🚀 Starting Auto-Apply Cycle...");
  
  // Prepare Bot instance for notifications
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  // We need a chat ID to send notifications to.
  const adminChatId = getAdminChatId();
  const adminUser = adminChatId ? getOrCreateUserByTelegramChat(parseInt(adminChatId, 10)) : null;
  if (!adminChatId) {
    console.warn("⚠️ Warning: No Admin Chat ID found in the database. Run /start on Telegram so the bot knows who to message.");
  }

  const cvText = formatCVForPrompt(myCV);
  
  // Define our search queries
  const queries = [
    "Remote Frontend Developer",
    "Remote React Developer",
    "Frontend Developer Nigeria"
  ];

  for (const query of queries) {
    console.log(`\n🔍 Searching jobs for: ${query}`);
    
    // ========================================
    // PHASE 1: Auto-Applyable Sources (HN + X)
    // ========================================
    // These sources are more likely to contain emails for direct application.
    const hnJobs = await fetchJobsFromHN(query);
    const xJobs = await fetchJobsFromX(query);
    
    const applyableJobs: Job[] = [...hnJobs, ...xJobs];
    console.log(`   📬 Applyable sources: ${applyableJobs.length} jobs (${hnJobs.length} HN, ${xJobs.length} X)`);

    for (const job of applyableJobs) {
      // 1. Check if processed
      if (hasJobBeenProcessed(job.id)) {
        continue;
      }

      let dbRecord: DBJobRecord = {
        id: job.id,
        title: job.title,
        company: job.company,
        url: job.url,
        status: 'SKIPPED',
        matchScore: null
      };

      // Fast Pre-Filter: Stringify the entire job object to catch any email
      const jobString = JSON.stringify(job);
      const rawMatches = jobString.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      
      const validEmails = rawMatches.filter(m => {
        const lower = m.toLowerCase();
        if (lower.includes("google_jobs_apply")) return false;
        if (lower.match(/\.(png|jpg|jpeg|gif|webp)$/i)) return false;
        if (lower.includes("sentry.io")) return false;
        if (lower.length > 50) return false;
        return true;
      });

      console.log(`   ⚙️  Processing ${job.title} at ${job.company} [Source: ${job.source}]`);
      await sleep(2000); 

      try {
        // 2. Parse JD
        const parsedJD = await parseJobDescription(job.description);
        
        // Merge identified email if parser didn't find one but pre-filter did
        if (!parsedJD.applicationEmail && validEmails.length > 0) {
          parsedJD.applicationEmail = validEmails[0] || null;
        }

        // Merge API email if available
        if (!parsedJD.applicationEmail && job.email) {
          parsedJD.applicationEmail = job.email;
        }

        // Provide a fallback mechanism: If no email, check if it's a known form
        if (!parsedJD.applicationEmail) {
           console.log(`      ⚠️ No application email found. Attempting ATS Form Auto-Fill...`);
           const formResult = await autoFillApplication(job.url, parsedJD);
           
           if (formResult.success) {
               dbRecord.status = 'APPLIED';
               console.log(`      🎉 ${formResult.message}`);
               if (adminChatId) {
                 const msg = `🚀 **Auto-Submitted ATS Form!**\n\n**Source:** ${job.source}\n**Role:** ${job.title}\n**Company:** ${job.company}\n\n✅ Successfully filled out the application form via Playwright.`;
                 await bot.api.sendMessage(adminChatId, msg, { parse_mode: 'Markdown' });
               }
           } else {
               dbRecord.status = 'FAILED';
               console.log(`      ❌ Form auto-fill failed or unsupported ATS: ${formResult.message}`);
           }
           logProcessedJob(dbRecord);
           continue;
        }

        // --- Email Flow ---

        // 3. Evaluate Match
        const match = await evaluateMatch(parsedJD, cvText);
        dbRecord.matchScore = match.matchScore;

        if (match.matchScore < MIN_MATCH_SCORE) {
          console.log(`      📉 Match score too low (${match.matchScore}%). Target is ${MIN_MATCH_SCORE}%.`);
          logProcessedJob(dbRecord);
          continue;
        }

        console.log(`      ✅ Match Score: ${match.matchScore}%. Generating application...`);

        // 4. Resolve links + name for draft context
        let autoDraftCtx: DraftContext = {};
        if (adminUser && adminUser.telegram_chat_id != null) {
          const links = await getLinksForTelegramUser(adminUser.telegram_chat_id);
          const dispName = await resolveApplicantDisplayNameForForms(adminUser.telegram_chat_id);
          const gh = links.find((l) => l.label === 'github')?.url;
          const li = links.find((l) => l.label === 'linkedin')?.url;
          const pf = links.find((l) => l.label === 'portfolio')?.url;
          autoDraftCtx = {
            ...(gh ? { githubUrl: gh } : {}),
            ...(li ? { linkedinUrl: li } : {}),
            ...(pf ? { portfolioUrl: pf } : {}),
            ...(dispName ? { applicantName: dispName } : {}),
          };
        }

        const draft = await generateEmailDraft(parsedJD, cvText, match.feedback, autoDraftCtx);

        // 5. Generate Cover Letter (always for email applications)
        let coverLetterFilename: string | undefined;
        let coverLetterPath: string | undefined;
        const shouldGenCover = parsedJD.requiresCoverLetter || !!parsedJD.applicationEmail;
        if (shouldGenCover) {
          console.log(`      📄 Generating Cover Letter...`);
          coverLetterFilename = `Cover_Letter_${parsedJD.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
          coverLetterPath = await generateCoverLetterPDF(parsedJD, cvText, `./${coverLetterFilename}`);
        }

        // 6. Send Email (uses admin user's connected email account)
        if (!adminUser) {
          console.log(`      ⚠️ No admin user; skipping email send.`);
          logProcessedJob(dbRecord);
          continue;
        }

        const dynamicFilename = `${myCV.name.replace(/\s+/g, '_')}_${parsedJD.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}_Resume.pdf`;
        const resumePath =
          adminUser.telegram_chat_id != null
            ? await getLatestResumePathForTelegramUser(adminUser.telegram_chat_id)
            : null;
        const resumeFileExists =
          resumePath !== null && fs.existsSync(resumePath);

        const attachments = [];
        if (resumeFileExists && resumePath) {
          attachments.push({ filename: dynamicFilename, path: resumePath });
        }
        if (coverLetterFilename && coverLetterPath) {
          attachments.push({ filename: coverLetterFilename, path: coverLetterPath });
        }

        const emailResult = await sendApplicationEmailForUser(adminUser.id, {
          to: parsedJD.applicationEmail,
          subject: draft.subject,
          bodyText: draft.bodyText,
          attachments: attachments
        });

        if (emailResult.success) {
           dbRecord.status = 'APPLIED';
           console.log(`      🎉 Successfully applied to ${job.company} via Email!`);

           addUserApplication({
             userId: adminUser.id,
             company: job.company || parsedJD.companyName || "Unknown",
             role: job.title || parsedJD.jobTitle,
             method: "email",
             destination: parsedJD.applicationEmail,
             matchScore: match.matchScore,
             ...(coverLetterPath ? { coverLetterPath } : {}),
           });

           if (adminChatId) {
             const msg = `🚀 **Auto-Submitted Email Application!**\n\n**Source:** ${job.source}\n**Role:** ${job.title}\n**Company:** ${job.company}\n**Match Score:** ${match.matchScore}%\n\n✅ Email sent to ${parsedJD.applicationEmail}`;
             await bot.api.sendMessage(adminChatId, msg, { parse_mode: 'Markdown' });
           }
        } else {
           dbRecord.status = 'FAILED';
           console.log(`      ❌ Failed to send email: ${emailResult.error}`);
        }

      } catch (err: any) {
        console.error(`      ❌ Error processing job ${job.id}:`, err.message);
        dbRecord.status = 'FAILED';
      }
      logProcessedJob(dbRecord);
    }

    // ========================================
    // PHASE 2: LinkedIn Advisory (No Auto-Apply)
    // ========================================
    // LinkedIn jobs are surfaced as suggestions via Telegram, not auto-applied.
    console.log(`\n   👀 Fetching LinkedIn suggestions for: ${query}`);
    const linkedInJobs = await fetchJobsFromLinkedIn(query);

    // Filter to only new, unprocessed jobs posted recently
    const newLinkedInJobs = linkedInJobs
      .filter(j => !hasJobBeenProcessed(j.id))
      .slice(0, 5); // Max 5 suggestions per query

    if (newLinkedInJobs.length > 0 && adminChatId) {
      let digestMsg = `👀 **LinkedIn Job Picks for "${query}"**\n\n`;
      digestMsg += `Found ${newLinkedInJobs.length} new job${newLinkedInJobs.length > 1 ? 's' : ''} worth checking out:\n\n`;

      newLinkedInJobs.forEach((job, idx) => {
        digestMsg += `${idx + 1}. **${job.title}** at ${job.company}`;
        if (job.location) digestMsg += ` (${job.location})`;
        digestMsg += `\n   🔗 [View Job](${job.url})\n\n`;

        // Log as processed so we don't suggest them again
        logProcessedJob({
          id: job.id,
          title: job.title,
          company: job.company,
          url: job.url,
          status: 'SKIPPED', // Advisory = skipped (not applied)
          matchScore: null,
        });
      });

      digestMsg += `_These are suggestions only — apply manually if interested._`;

      try {
        await bot.api.sendMessage(adminChatId, digestMsg, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
        });
        console.log(`   📨 Sent ${newLinkedInJobs.length} LinkedIn job suggestions via Telegram.`);
      } catch (err: any) {
        console.warn(`   ⚠️ Failed to send LinkedIn digest: ${err.message}`);
      }
    } else if (newLinkedInJobs.length > 0) {
      console.log(`   📋 ${newLinkedInJobs.length} new LinkedIn jobs found but no admin chat ID for notifications.`);
    } else {
      console.log(`   📭 No new LinkedIn jobs to suggest for "${query}".`);
    }
  }

  console.log("\n🏁 Auto-Apply Cycle Complete.\n");
}
