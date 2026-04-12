import { Bot, session } from "grammy";
import { env } from "../config/env.js";
import type { MyContext, SessionData } from "./types.js";

export const bot = new Bot<MyContext>(env.TELEGRAM_BOT_TOKEN);

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
      awaitingFormRevision: false,
    }),
  }),
);
export const BOT_MENU_COMMANDS = [
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
    command: "my_applications",
    description: "View your tracked applications and update statuses",
  },
  {
    command: "download_resume",
    description: "Download your uploaded resume",
  },
  {
    command: "download_cover_letter",
    description: "Download the last generated cover letter",
  },
  {
    command: "my_status",
    description: "See your setup status and recent activity",
  },
  {
    command: "connect_google",
    description: "Connect your Google account for form applications",
  },
  {
    command: "connect_google_done",
    description: "Confirm Google sign-in is complete",
  },
];
/** Call this to refresh the bot's command menu (e.g. from /start so clients see the latest list). */
export async function refreshBotMenu() {
  try {
    await bot.api.setMyCommands(BOT_MENU_COMMANDS);
  } catch (e) {
    console.error("Failed to refresh bot menu:", e);
  }
}

const BOT_DESCRIPTION =
  "I'm your AI-powered job application assistant! Send me a job description and I'll:\n\n" +
  "📊 Score how well you match\n" +
  "✍️ Draft a tailored application email\n" +
  "📄 Generate a cover letter PDF\n" +
  "📝 Auto-fill Google Form applications\n\n" +
  "Type /start to get set up!";

const BOT_SHORT_DESCRIPTION = "AI job application assistant — match scoring, email drafting, cover letters & Google Form auto-fill.";

export async function setBotDescription() {
  try {
    await bot.api.setMyDescription(BOT_DESCRIPTION);
    await bot.api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
  } catch (e) {
    console.error("Failed to set bot description:", e);
  }
}

bot.catch((err) => {
  console.error("Error in middleware while handling update", err.error);
});
