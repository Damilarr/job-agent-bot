import { Context } from "grammy";

// Define the bot and store data temporarily in memory for the callback
export interface SessionData {
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

export type MyContext = Context & {
  session: SessionData;
};
