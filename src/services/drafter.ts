import { aiService, normalizeDashes } from '../services/ai.js';
import { removeUnsupportedClaims } from './factCheck.js';
import type { ParsedJobDescription } from './parser.js';

const draftSchema = {
  type: "object",
  properties: {
    bodyText: {
      type: "string",
      description: "The email body in plain text: greeting and 2-3 short paragraphs separated by blank lines. No sign-off, no name, no attachment note."
    }
  },
  required: ["bodyText"]
};

export interface EmailDraft {
  subject: string;
  /** The model-written part of the email. The attachment note and signature are added by composeEmailBody. */
  bodyText: string;
}

export type DraftTone = "confident" | "formal" | "friendly";

export interface DraftContext {
  /** User's real links, resolved from /set_links */
  githubUrl?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  applicantName?: string;
  phone?: string;
  tone?: DraftTone;
}

export interface EmailAttachmentsSummary {
  resume: boolean;
  coverLetter: boolean;
}

export const FACT_RULES = `
    FACTS - NEVER BREAK THESE:
    - Only mention experience, employers, projects, skills and achievements that appear in the candidate background. Never invent metrics, tools or responsibilities.
    - Do not stretch past work to fit the job's domain (e.g. do not call a media overlay tool "video streaming experience").
    - Do not state a number of years of experience unless it appears in the PROFILE, and then use exactly that figure.
    - A role with an end date is a past role. Never describe it as current.
    - Never mention skills the candidate lacks or is "learning".
    - Never attach a skill or technology to an employer or project unless the background lists it for that employer or project. A skill in a skills list is not proof it was used at a specific job.
    - Never merge facts from different employers or projects into one claim.`;

export const STYLE_RULES = `
    STYLE:
    - Never use em dashes or en dashes. Use a plain hyphen "-", a comma, or a new sentence instead.
    - No buzzwords or clichés: "I am writing to express", "thrilled", "excited to apply", "delve", "synergy", "passionate", "aligns perfectly", "proven track record", "look forward to contributing to your team's success".
    - No hype words about the candidate ("expert", "rockstar", "top-tier").`;

function cleanDraft(draft: EmailDraft): EmailDraft {
  return {
    subject: normalizeDashes(draft.subject).trim(),
    bodyText: normalizeDashes(draft.bodyText).trim(),
  };
}

export function buildSubject(jobData: ParsedJobDescription, applicantName?: string): string {
  return applicantName
    ? `Application for ${jobData.jobTitle} - ${applicantName}`
    : `Application for ${jobData.jobTitle}`;
}

/**
 * Appends the attachment note and signature to the model-written body.
 * Kept out of the model's hands so contact details and links are always exact.
 */
export function composeEmailBody(
  draft: EmailDraft,
  draftCtx: DraftContext | undefined,
  attachments: EmailAttachmentsSummary,
): string {
  const parts = [draft.bodyText];

  if (attachments.resume && attachments.coverLetter) {
    parts.push("I have attached my resume and a cover letter.");
  } else if (attachments.resume) {
    parts.push("I have attached my resume.");
  } else if (attachments.coverLetter) {
    parts.push("I have attached a cover letter.");
  }

  const signature = ["Best regards,"];
  if (draftCtx?.applicantName) signature.push(draftCtx.applicantName);
  if (draftCtx?.phone) signature.push(draftCtx.phone);
  const links = [
    draftCtx?.portfolioUrl ? `Portfolio: ${draftCtx.portfolioUrl}` : null,
    draftCtx?.linkedinUrl ? `LinkedIn: ${draftCtx.linkedinUrl}` : null,
    draftCtx?.githubUrl ? `GitHub: ${draftCtx.githubUrl}` : null,
  ].filter(Boolean);
  signature.push(...(links as string[]));
  parts.push(signature.join("\n"));

  return parts.join("\n\n");
}

/**
 * Generates an email draft customized to the job description and candidate's background.
 */
export async function generateEmailDraft(
  jobData: ParsedJobDescription,
  cvText: string,
  draftCtx?: DraftContext,
): Promise<EmailDraft> {
  const toneInstructions: Record<DraftTone, string> = {
    confident: `Confident and direct. State what the candidate has done plainly, without hedging ("I think", "I believe") and without bragging.`,
    formal: `Polished and professional, with structured sentences. Suitable for corporate or enterprise roles, while still sounding like a real person.`,
    friendly: `Warm and approachable, casual but professional. Good for startups and small teams.`,
  };

  const tone = draftCtx?.tone ?? "confident";
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `
    You are writing a job application email on behalf of the candidate, in the first person.
    The email will be sent with the candidate's resume attached, to the address in the job post.
    Today's date is ${today}.

    GOAL: A short, specific email a busy recruiter reads in 30 seconds and wants to open the resume.

    TONE: ${toneInstructions[tone]}

    STRUCTURE (plain text, paragraphs separated by one blank line, 90-150 words in total):
    1. Greeting: "Hello ${jobData.companyName ? `${jobData.companyName} team` : "Hiring Team"}," (or the named contact if the job post gives one).
    2. First paragraph (1-2 sentences): the role being applied for${jobData.companyName ? ` at ${jobData.companyName}` : ""} and who the candidate is, in one line.
    3. Second paragraph (2-3 sentences): the 1-2 most relevant things from the candidate background that match this job's key requirements. Name the employer or project and what was built.
    4. Final paragraph (1 sentence): a simple ask, e.g. being happy to talk further.
    Do NOT write a sign-off, the candidate's name, contact details, links, or a note about attachments. Those are added automatically.
    ${FACT_RULES}
    ${STYLE_RULES}

    Candidate background:
    ---
    ${cvText}
    ---

    Job:
    ---
    Job Title: ${jobData.jobTitle}
    Company: ${jobData.companyName || "Not specified"}
    Required Experience: ${jobData.requiredExperience}
    Key Skills: ${jobData.keySkills.join(', ')}
    ${jobData.companyValues ? `Company Values/About: ${jobData.companyValues}` : ""}
    ---
  `;

  try {
    const response = await aiService.complete({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Output ONLY a valid JSON object matching this schema:\n' + JSON.stringify(draftSchema, null, 2) }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    const resultText = response.choices[0]?.message?.content;
    if (!resultText) {
      throw new Error("No text response from Groq during email draft generation.");
    }

    const { bodyText } = JSON.parse(resultText) as { bodyText: string };
    const checkedBody = await removeUnsupportedClaims(normalizeDashes(bodyText), cvText);
    return cleanDraft({ subject: buildSubject(jobData, draftCtx?.applicantName), bodyText: checkedBody });
  } catch (error) {
    console.error("Failed to generate email draft:", error);
    throw new Error("Could not draft the application email.");
  }
}

/**
 * Takes an existing email draft and applies the user's revision feedback to generate a new draft.
 */
export async function reviseEmailDraft(originalDraft: EmailDraft, feedback: string): Promise<EmailDraft> {
  const prompt = `
    You are editing a job application email that the candidate will send.
    Revise it strictly according to the candidate's instructions.

    Existing Subject: "${originalDraft.subject}"
    Existing Body:
    "${originalDraft.bodyText}"

    Candidate's Revision Instructions: "${feedback}"

    Apply these instructions EXACTLY.
    If they ask you to remove something, remove it. If they ask you to add something, add it smoothly.
    Keep everything else, including the tone, the same unless instructed otherwise.
    Keep the subject unchanged unless the instructions are about the subject.
    Do NOT add a sign-off, name, contact details, links, or a note about attachments. Those are added automatically.
    Do not add any experience, metrics or skills that are not already in the existing body or the instructions.
    ${STYLE_RULES}

    Return the result strictly as a JSON object matching this schema:
    {
      "subject": (the subject line),
      "bodyText": (the revised email body)
    }
  `;

  try {
    const response = await aiService.complete({
      messages: [
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error("Empty response from Groq.");

    const revised = JSON.parse(text) as Partial<EmailDraft>;
    return cleanDraft({
      subject: revised.subject || originalDraft.subject,
      bodyText: revised.bodyText || originalDraft.bodyText,
    });
  } catch (error) {
    console.error("Failed to revise email draft:", error);
    throw new Error("Could not revise the application email.");
  }
}
