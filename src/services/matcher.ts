import { aiService } from '../services/ai.js';
import type { ParsedJobDescription } from './parser.js';

const evaluationSchema = {
  type: "object",
  properties: {
    matchScore: {
      type: "number",
      description: "An integer percentage (0-100) representing how well the candidate's CV matches the job requirements."
    },
    feedback: {
      type: "string",
      description: "A short, actionable insight for the user explaining the score, highlighting matching/missing skills, and suggesting summary tweaks if necessary."
    }
  },
  required: ["matchScore", "feedback"]
};

export interface MatchEvaluation {
  matchScore: number;
  feedback: string;
}

/**
 * Evaluates the parsed job description against the provided Master CV.
 */
export async function evaluateMatch(
  jobData: ParsedJobDescription,
  cvText: string
): Promise<MatchEvaluation> {
  const prompt = `
    You are an expert technical recruiter and career coach.
    I will provide you with a candidate's Master CV and the parsed details of a job opportunity.
    
    Your task is to:
    1. Compare the job requirements (Title, Skills, Experience) with the candidate's CV.
    2. Calculate a "Match Score" as a percentage (integer from 0 to 100).
    3. Generate a concise, constructive piece of "Feedback" (max 3 sentences).
       - If the match is poor, emphasize what key skills are missing.
       - If the match is decent but imperfect (e.g., ~70%), suggest how the candidate might tweak their CV summary to highlight relevant experience.
       - Provide the feedback as if speaking directly to the candidate (e.g., "Hey, they want Next.js...").

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
    const response = await ai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Output ONLY a valid JSON object matching this schema:\n' + JSON.stringify(evaluationSchema, null, 2) }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    const resultText = response.choices[0]?.message?.content;
    if (!resultText) {
      throw new Error("No text response from Groq during match evaluation.");
    }

    const evaluation: MatchEvaluation = JSON.parse(resultText);
    return evaluation;
  } catch (error) {
    console.error("Error evaluating match:", error);
    throw new Error("Failed to evaluate match via Groq API.");
  }
}
