import { aiService } from "../services/ai.js";
import type { ParsedJobDescription } from "./parser.js";
import {
  markdownToHtml,
  renderHtmlToPdf,
  wrapCoverLetterHtml,
} from "./pdf.js";

/**
 * Generates a tailored Cover Letter in Markdown format using Groq, then converts it to PDF.
 */
export async function generateCoverLetterPDF(
  jobData: ParsedJobDescription,
  cvText: string,
  outputPath: string,
): Promise<string> {
  const prompt = `
You are an expert career strategist and you are writing a cover letter for me.
My CV is below:
---
${cvText}
---

The job I am applying for is:
Job Title: ${jobData.jobTitle}
Company Name: ${jobData.companyName || "the company"}
Company Values / About Us: ${jobData.companyValues || "Not specified"}
Required Skills: ${jobData.keySkills.join(", ")}
Required Experience: ${jobData.requiredExperience}

WRITE A COVER LETTER matching my CV to this job.

CRITICAL CONSTRAINTS - YOU MUST OBEY THESE OR FAIL:
1. DO NOT use robotic AI buzzwords like: "synergy", "delve", "testament", "tapestry", "I am writing to express my interest", "thrilled to apply", "pivotal".
2. Use a conversational, confident, and professional tone. Sound like a real, competent human being.
3. Keep it concise. Max 3-4 short paragraphs.
4. CONNECT MY CV TO THEM: Explicitly mention 1 or 2 specific achievements from my CV that prove I can solve the problems they are hiring for. 
5. ALIGN WITH THEIR VALUES: If company values/about us info is provided above, subtly align my motivation with those values. Do not aggressively parrot their values back to them.
6. Return the raw output in clean Markdown format (no markdown codeblock wrapping ticks \`\`\`markdown). Do not include placeholder brackets like [Date] or [Company Address] at the top, just jump straight into the greeting (e.g., "Dear Hiring Team,").
7. Sign off with my name from the CV.
`;

  const ai = aiService.getClient();
  const response = await ai.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
  });

  const markdownContent = response.choices[0]?.message?.content;
  if (!markdownContent) {
    throw new Error("Groq failed to generate cover letter markdown.");
  }

  const html = wrapCoverLetterHtml(markdownToHtml(markdownContent));
  await renderHtmlToPdf(html, outputPath);

  return outputPath;
}
