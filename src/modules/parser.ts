import { Type } from '@google/genai';
import { aiService } from '../services/ai.js';

// Define the expected output structure using Gemini's Schema
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    jobTitle: {
      type: Type.STRING,
      description: "The official title or role of the job."
    },
    companyName: {
      type: Type.STRING,
      description: "The name of the company hiring, if explicitly stated. Null if not found.",
      nullable: true
    },
    companyValues: {
      type: Type.STRING,
      description: "A short summary of any company values, mission, or 'about us' information mentioned in the JD. Null if not found.",
      nullable: true
    },
    keySkills: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "A list of essential technical and soft skills required for the job."
    },
    requiredExperience: {
      type: Type.STRING,
      description: "The level or years of experience required (e.g., '3+ years', 'Senior level')."
    },
    applicationEmail: {
      type: Type.STRING,
      description: "The email address to send the application to, if specified. Return null or empty string if not found."
    },
    requiresCoverLetter: {
      type: Type.BOOLEAN,
      description: "True if the job explicitly requests a cover letter. False otherwise."
    },
    requiresResume: {
      type: Type.BOOLEAN,
      description: "True if the job explicitly requests a resume or CV. False otherwise."
    }
  },
  required: ["jobTitle", "keySkills", "requiredExperience"]
};

export interface ParsedJobDescription {
  jobTitle: string;
  companyName: string | null;
  companyValues: string | null;
  keySkills: string[];
  requiredExperience: string;
  applicationEmail?: string | null;
  requiresCoverLetter: boolean;
  requiresResume: boolean;
}

/**
 * Parses a messy job description string into a structured JSON object.
 */
export async function parseJobDescription(text: string): Promise<ParsedJobDescription> {
  const prompt = `
    You are an expert technical recruiter and data extractor.
    Your task is to analyze the provided job description and extract specific key information.
    The input might be messy, unstructured text from platforms like LinkedIn, Twitter, or informal messages.
    
    Extract the following details:
    1. Job Title.
    2. Key Skills (as a list).
    3. Required Experience level.
    4. The Application Email address (if it exists).
    5. Whether a Cover Letter is requested.
    6. Whether a Resume/CV is requested.

    Here is the job description:
    ---
    ${text}
    ---
  `;

  try {
    const ai = aiService.getClient();
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        temperature: 0.1, // Low temperature for more deterministic extraction
      }
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error("No text response from Gemini.");
    }

    const parsedData: ParsedJobDescription = JSON.parse(resultText);
    return parsedData;
  } catch (error) {
    console.error("Error parsing job description:", error);
    throw new Error("Failed to parse job description via Gemini API.");
  }
}
