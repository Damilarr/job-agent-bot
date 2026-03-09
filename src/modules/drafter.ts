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

/**
 * Generates an email draft customized to the job description and candidate's CV.
 */
export async function generateEmailDraft(
  jobData: ParsedJobDescription,
  cvText: string,
  feedback?: string
): Promise<EmailDraft> {
  const prompt = `
    You are an expert career advisor and professional copywriter.
    I will provide you with a candidate's Master CV, the parsed details of a job opportunity, and some optional context feedback.
    
    Your task is to write a highly conversational, ultra-concise, and extremely human job application email draft.
    
    CRITICAL CONSTRAINTS - YOU MUST OBEY THESE OR FAIL:
    1. NEVER use robotic AI buzzwords or formal clichés like: "I am writing to express my keen interest", "coupled with", "aligns perfectly with your requirements", "delve", "synergy", "thrilled to apply".
    2. Write like a real, competent software engineer sending a quick ping to a hiring manager or recruiter. 
    3. Keep it ultra-short. Maximum 3-4 sentences (under 50 words). 
    4. Start normally (e.g., "Hi Team,", "Hi there,", or just "Hello,").
    5. Directly mention 1 specific skill/achievement from my CV that proves I can do what they need.
    6. Include my portfolio link (from the CV) naturally in the text.
    7. Be confident and direct, not overly polite or desperate.
    ${feedback ? `\n    Context/Feedback provided: ${feedback}` : ""}

    Candidate CV:
    ---
    ${cvText}
    ---

    Job Requirements:
    ---
    Job Title: ${jobData.jobTitle}
    Required Experience: ${jobData.requiredExperience}
    Key Skills: ${jobData.keySkills.join(', ')}
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
