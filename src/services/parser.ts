import { aiService } from '../services/ai.js';

// Define the expected output structure using standard JSON schema format
const responseSchema = {
  type: "object",
  properties: {
    jobTitle: {
      type: "string",
      description: "The official title or role of the job."
    },
    companyName: {
      type: "string",
      description: "The name of the company hiring, if explicitly stated. Null if not found.",
      nullable: true
    },
    companyValues: {
      type: "string",
      description: "A short summary of any company values, mission, or 'about us' information mentioned in the JD. Null if not found.",
      nullable: true
    },
    keySkills: {
      type: "array",
      items: { type: "string" },
      description: "A list of essential technical and soft skills required for the job."
    },
    requiredExperience: {
      type: "string",
      description: "The level or years of experience required (e.g., '3+ years', 'Senior level')."
    },
    applicationEmail: {
      type: "string",
      description: "The email address to send the application to, if specified. Return null or empty string if not found."
    },
    requiresCoverLetter: {
      type: "boolean",
      description: "True if the job requests or would benefit from a cover letter. For email applications, default to true unless it's clearly a quick referral."
    },
    requiresResume: {
      type: "boolean",
      description: "True if this is a job application where attaching a resume would be expected. This includes any role where an application email is provided. Only false for informal referral requests or info-gathering forms."
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
    2. Company Name — if not stated explicitly, try to infer it from the application email domain (e.g. admin@hotspotsbeauty.com → HotSpotsBeauty). Return null ONLY if truly unidentifiable.
    3. Key Skills (as a list).
    4. Required Experience level.
    5. The Application Email address (if it exists).
    6. Whether a Resume/CV should be attached — for any real job application (especially when an email is provided to send the application to), default to TRUE. Only set false for informal referral requests or info forms.
    7. Whether a Cover Letter should be included — for any direct email application to a company, default to TRUE. Only set false for quick referral pings or forms.

    Here is the job description:
    ---
    ${text}
    ---
  `;

  try {
    const ai = aiService.getClient();
    const response = await ai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Output ONLY a valid JSON object matching this schema:\n' + JSON.stringify(responseSchema, null, 2) }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const resultText = response.choices[0]?.message?.content;
    if (!resultText) {
      throw new Error("No text response from Groq.");
    }

    const parsedData: ParsedJobDescription = JSON.parse(resultText);

    if (!parsedData.companyName && parsedData.applicationEmail) {
      const domain = parsedData.applicationEmail.split("@")[1];
      if (domain && !/(gmail|yahoo|outlook|hotmail|proton|icloud)\./i.test(domain)) {
        const namePart = domain.split(".")[0] ?? "";
        parsedData.companyName =
          namePart.charAt(0).toUpperCase() + namePart.slice(1);
      }
    }

    if (parsedData.applicationEmail && !parsedData.requiresResume) {
      parsedData.requiresResume = true;
    }

    return parsedData;
  } catch (error) {
    console.error("Error parsing job description:", error);
    throw new Error("Failed to parse job description via Groq API.");
  }
}
