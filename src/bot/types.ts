import { Context } from "grammy";
import type { FormAnswerPlan, ScrapedFormQuestion } from "../integrations/googleForms/index.js";

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
  awaitingFormRevision: boolean;
}

export type MyContext = Context & {
  session: SessionData;
};
export type PendingGoogleFormSession = {
  rawJD: string;
  roles: string[];
  googleFormUrl: string | null;
  referrerName?: string;
  referrerEmail?: string;
  formAttachmentPaths?: { resumePath?: string; coverLetterPath?: string };
};

/** Pending AI form review: the user is reviewing/revising planned answers before submission */
export type PendingFormReview = {
  googleFormUrl: string;
  plan: FormAnswerPlan;
  questions: ScrapedFormQuestion[];
  rawJD: string;
  userProfileText: string;
  resumePath?: string | undefined;
  coverLetterPath?: string | undefined;
  telegramUserId: number;
};
