import { aiService, normalizeDashes } from "../services/ai.js";
import { FACT_RULES, STYLE_RULES } from "./drafter.js";
import { removeUnsupportedClaims } from "./factCheck.js";
import type { ParsedJobDescription } from "./parser.js";
import {
  markdownToHtml,
  renderHtmlToPdf,
  wrapCoverLetterHtml,
} from "./pdf.js";

/**
 * Generates a tailored Cover Letter in Markdown format using Groq, fact-checks it, then converts it to PDF.
 */
export async function generateCoverLetterPDF(
  jobData: ParsedJobDescription,
  cvText: string,
  outputPath: string,
): Promise<string> {
  const prompt = `
You are writing a cover letter in the first person on behalf of the candidate.
Today's date is ${new Date().toISOString().slice(0, 10)}.
${FACT_RULES}
${STYLE_RULES}

Candidate background:
---
${cvText}
---

Job:
---
Job Title: ${jobData.jobTitle}
Company Name: ${jobData.companyName || "Not specified"}
Company Values / About Us: ${jobData.companyValues || "Not specified"}
Required Skills: ${jobData.keySkills.join(", ")}
Required Experience: ${jobData.requiredExperience}
---

STRUCTURE (3 short paragraphs, 180-250 words in total):
1. Greeting: "Dear ${jobData.companyName ? `${jobData.companyName} Hiring Team` : "Hiring Team"},"
2. Paragraph 1: the role being applied for and a one-line summary of who the candidate is.
3. Paragraph 2: the 2 most relevant pieces of work from the background for this job, described exactly as the background describes them. Name the employer or project.
4. Paragraph 3: why this role${jobData.companyName ? ` at ${jobData.companyName}` : ""} is a fit, using only the job details above and real overlap with the background, then a simple closing line.
5. Sign-off: "Best regards," on its own line, followed by the candidate's name from the background.

Output clean Markdown with no code fences and no placeholders like [Date] or [Company Address]. Start directly with the greeting.
`;

  const response = await aiService.complete({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  const markdownContent = response.choices[0]?.message?.content;
  if (!markdownContent) {
    throw new Error("Groq failed to generate cover letter markdown.");
  }

  const checked = await removeUnsupportedClaims(normalizeDashes(markdownContent), cvText);
  const html = wrapCoverLetterHtml(markdownToHtml(checked));
  await renderHtmlToPdf(html, outputPath);

  return outputPath;
}
