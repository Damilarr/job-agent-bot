import { Type } from '@google/genai';
import { aiService } from '../services/ai.js';
import type { ParsedJobDescription } from './parser.js';


const draftSchema = {
  type: Type.OBJECT,
  properties: {
    subject: {
      type: Type.STRING,
      description: "A professional and concise email subject line for the job application."
    },
    bodyText: {
      type: Type.STRING,
      description: "The main body of the email in plain text style (using line breaks where appropriate)."
    }
  },
  required: ["subject", "bodyText"]
};

export interface EmailDraft {
  subject: string;
  bodyText: string;
}

export type DraftTone = "confident" | "formal" | "friendly";

export interface DraftContext {
  /** User's real links, resolved from /set_links */
  githubUrl?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  applicantName?: string;
  tone?: DraftTone;
}

/**
 * Generates an email draft customized to the job description and candidate's CV.
 */
export async function generateEmailDraft(
  jobData: ParsedJobDescription,
  cvText: string,
  feedback?: string,
  draftCtx?: DraftContext,
): Promise<EmailDraft> {
  const linksBlock = [
    draftCtx?.portfolioUrl ? `Portfolio: ${draftCtx.portfolioUrl}` : null,
    draftCtx?.githubUrl ? `GitHub: ${draftCtx.githubUrl}` : null,
    draftCtx?.linkedinUrl ? `LinkedIn: ${draftCtx.linkedinUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n    ");

  const toneInstructions: Record<DraftTone, string> = {
    confident: `Write with a confident, direct tone. Sound like a top-tier candidate who knows their worth. Be assertive about skills and value. No hedging language like "I think" or "I believe".`,
    formal: `Write with a polished, professional tone. Use proper salutations and structured sentences. Maintain formality while still being concise and genuine. Suitable for corporate or enterprise roles.`,
    friendly: `Write with a warm, approachable tone. Sound personable and enthusiastic without being over-the-top. Use casual but professional language. Good for startups and creative teams.`,
  };

  const tone = draftCtx?.tone ?? "confident";

  const prompt = `
    You are an expert career advisor and professional copywriter.
    I will provide you with a candidate's Master CV, the parsed details of a job opportunity, and some optional context feedback.
    
    Your task is to write a highly conversational, ultra-concise, and extremely human job application email draft.

    TONE: ${toneInstructions[tone]}
    
    CRITICAL CONSTRAINTS - YOU MUST OBEY THESE OR FAIL:
    1. NEVER use robotic AI buzzwords or formal clichés like: "I am writing to express my keen interest", "coupled with", "aligns perfectly with your requirements", "delve", "synergy", "thrilled to apply".
    2. Write like a real, competent professional sending a quick ping to a hiring manager or recruiter. 
    3. Keep it ultra-short. Maximum 3-4 sentences (under 50 words). 
    4. Start normally (e.g., "Hi Team,", "Hi there,", or just "Hello,").
    5. Directly mention 1 specific skill/achievement from my CV that proves I can do what they need.
    6. You MUST use the EXACT links provided below — do NOT invent, shorten, or substitute any URL.${linksBlock ? ` Include my portfolio link naturally in the text.` : ""}
    7. Maintain the ${tone} tone throughout.
    8. If a company name is provided, mention it once naturally (e.g., "at [Company]").
    9. Reference at least one specific responsibility or requirement from the JD to show you read it.
    ${feedback ? `\n    Context/Feedback provided: ${feedback}` : ""}

    Candidate CV:
    ---
    ${cvText}
    ---

    ${linksBlock ? `Candidate Links (use these EXACT URLs, do NOT make up URLs):\n    ${linksBlock}\n` : ""}
    ${draftCtx?.applicantName ? `Candidate Name: ${draftCtx.applicantName}` : ""}

    Job Requirements:
    ---
    Job Title: ${jobData.jobTitle}
    Company: ${jobData.companyName || "Not specified"}
    Required Experience: ${jobData.requiredExperience}
    Key Skills: ${jobData.keySkills.join(', ')}
    ${jobData.companyValues ? `Company Values/About: ${jobData.companyValues}` : ""}
    ---
  `;

  try {
    const ai = aiService.getClient();
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: draftSchema,
        temperature: 0.4, // Slightly higher temperature for more natural language generation
      }
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error("No text response from Gemini during email draft generation.");
    }

    const draft: EmailDraft = JSON.parse(resultText);
    return JSON.parse(resultText) as EmailDraft;
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
    You are an expert career advisor and professional copywriter.
    The user has provided an existing email draft that they've written, but they want you to revise it strictly according to their instructions.

    Existing Draft Subject: "${originalDraft.subject}"
    Existing Draft Body: 
    "${originalDraft.bodyText}"

    User's Revision Instructions: "${feedback}"

    Your task is to rewrite the email draft applying these instructions EXACTLY.
    If they ask you to remove something, remove it. If they ask you to add something, add it smoothly.
    Keep the rest of the tone identical to the original draft unless instructed otherwise.
    
    Return the result strictly as a JSON object matching this schema:
    {
      "subject": (the revised subject line),
      "bodyText": (the revised email body)
    }
  `;

  try {
    const ai = aiService.getClient();
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            subject: { type: Type.STRING },
            bodyText: { type: Type.STRING }
          },
          required: ["subject", "bodyText"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("Empty response from Gemini.");

    return JSON.parse(text) as EmailDraft;
  } catch (error) {
    console.error("Failed to revise email draft:", error);
    throw new Error("Could not revise the application email.");
  }
}
