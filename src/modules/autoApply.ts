import { fetchJobsFromAPI } from './sourcing.js';
import type { JSearchJob } from './sourcing.js';
import { parseJobDescription } from './parser.js';
import type { ParsedJobDescription } from './parser.js';
import { evaluateMatch } from './matcher.js';
import { generateEmailDraft } from './drafter.js';
import { generateCoverLetterPDF } from './coverLetter.js';
import { sendApplicationEmail } from './email.js';
import { hasJobBeenProcessed, logProcessedJob, getAdminChatId } from '../data/db.js';
import type { DBJobRecord } from '../data/db.js';
import fs from 'fs';
import path from 'path';
import { myCV, formatCVForPrompt } from '../data/cv.js';
import { Bot } from 'grammy';
import { env } from '../config/env.js';

const MIN_MATCH_SCORE = 80;

export async function runAutoApplyCycle() {
  console.log("🚀 Starting Auto-Apply Cycle...");
  
  // Prepare Bot instance for notifications
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  // We need a chat ID to send notifications to.
  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    console.warn("⚠️ Warning: No Admin Chat ID found in the database. Run /start on Telegram so the bot knows who to message.");
  }

  const cvText = formatCVForPrompt(myCV);
  
  // Define our search queries
  // Can use multiple keys in .env to increase the API limit
  const queries = [
    "Remote Frontend Developer",
    "Remote React Developer",
    "Frontend Developer Nigeria"
  ];

  for (const query of queries) {
    console.log(`\n🔍 Searching jobs for: ${query}`);
    const jobs = await fetchJobsFromAPI(query, 1);
    
    for (const job of jobs) {
      // 1. Check if processed
      if (hasJobBeenProcessed(job.job_id)) {
        console.log(`   ⏭  Skipping ${job.job_title} at ${job.employer_name} (Already Processed)`);
        continue;
      }

      console.log(`   ⚙️  Processing ${job.job_title} at ${job.employer_name}`);

      let dbRecord: DBJobRecord = {
        id: job.job_id,
        title: job.job_title,
        company: job.employer_name,
        url: job.job_apply_link,
        status: 'SKIPPED',
        matchScore: null
      };

      try {
        // 2. Parse JD to find required details (and crucially, the email)
        // Some APIs provide `job_apply_email`, but if not, we rely on the description parsing
        const parsedJD = await parseJobDescription(job.job_description);
        
        // Merge API email if parser didn't find one
        if (!parsedJD.applicationEmail && job.job_apply_email) {
          parsedJD.applicationEmail = job.job_apply_email;
        }

        // We can only auto-apply if there's an email
        if (!parsedJD.applicationEmail) {
           console.log(`      ⚠️ No application email found. Skipping.`);
           logProcessedJob(dbRecord);
           continue;
        }

        // 3. Evaluate Match
        const match = await evaluateMatch(parsedJD, cvText);
        dbRecord.matchScore = match.matchScore;

        if (match.matchScore < MIN_MATCH_SCORE) {
          console.log(`      📉 Match score too low (${match.matchScore}%). Target is ${MIN_MATCH_SCORE}%.`);
          logProcessedJob(dbRecord);
          continue;
        }

        console.log(`      ✅ Match Score: ${match.matchScore}%. Generating application...`);

        // 4. Draft Email
        const draft = await generateEmailDraft(parsedJD, cvText, match.feedback);

        // 5. Generate Cover Letter only if requested
        let coverLetterFilename: string | undefined;
        let coverLetterPath: string | undefined;
        if (parsedJD.requiresCoverLetter) {
          console.log(`      📄 Drafted Cover Letter requested... generating.`);
          coverLetterFilename = `Cover_Letter_${parsedJD.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
          coverLetterPath = await generateCoverLetterPDF(parsedJD, cvText, `./${coverLetterFilename}`);
        }

        // 6. Send Email
        const dynamicFilename = `${myCV.name.replace(/\s+/g, '_')}_${parsedJD.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}_Resume.pdf`;
        const resumeFileExists = fs.existsSync(path.resolve(process.cwd(), 'resume.pdf'));

        let attachments = [];
        if (parsedJD.requiresResume && resumeFileExists) {
           attachments.push({ filename: dynamicFilename, path: path.resolve(process.cwd(), 'resume.pdf') });
        }
        if (parsedJD.requiresCoverLetter && coverLetterFilename && coverLetterPath) {
           attachments.push({ filename: coverLetterFilename, path: coverLetterPath });
        }

        const emailResult = await sendApplicationEmail({
          to: parsedJD.applicationEmail,
          subject: draft.subject,
          bodyText: draft.bodyText,
          attachments: attachments
        });

        if (emailResult.success) {
           dbRecord.status = 'APPLIED';
           console.log(`      🎉 Successfully applied to ${job.employer_name}!`);

           // Send immediate notification via Telegram
           if (adminChatId) {
             const msg = `🚀 **Auto-Submitted Application!**\n\n**Role:** ${job.job_title}\n**Company:** ${job.employer_name}\n**Match Score:** ${match.matchScore}%\n\n✅ Email sent to ${parsedJD.applicationEmail}`;
             await bot.api.sendMessage(adminChatId, msg, { parse_mode: 'Markdown' });
           }
        } else {
           dbRecord.status = 'FAILED';
           console.log(`      ❌ Failed to send email: ${emailResult.error}`);
        }

      } catch (err) {
        console.error(`      ❌ Error processing job ${job.job_id}:`, err);
        dbRecord.status = 'FAILED';
      }

      // Log the result to SQLite
      logProcessedJob(dbRecord);
    }
  }

  console.log("\n🏁 Auto-Apply Cycle Complete.\n");
}
