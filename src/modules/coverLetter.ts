import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import type { ParsedJobDescription } from './parser.js';
import { mdToPdf } from 'md-to-pdf';
import fs from 'fs';
import path from 'path';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/**
 * Generates a tailored Cover Letter in Markdown format using Gemini, carefully crafted to sound human
 * and tie back to the company values and the applicant's CV. Then converts it to a PDF file.
 */
export async function generateCoverLetterPDF(jobData: ParsedJobDescription, cvText: string, outputPath: string): Promise<string> {
  const prompt = `
You are an expert career strategist and you are writing a cover letter for me.
My CV is below:
---
${cvText}
---

The job I am applying for is:
Job Title: ${jobData.jobTitle}
Company Name: ${jobData.companyName || 'the company'}
Company Values / About Us: ${jobData.companyValues || 'Not specified'}
Required Skills: ${jobData.keySkills.join(', ')}
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

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  const markdownContent = response.text;
  if (!markdownContent) {
    throw new Error("Gemini failed to generate cover letter markdown.");
  }

  // Convert the Markdown to PDF
  // We use md-to-pdf which utilizes Puppeteer under the hood to generate clean PDFs from Markdown
  const pdfOutput = await mdToPdf(
    { content: markdownContent }, 
    { 
      dest: outputPath,
      pdf_options: { format: 'A4', margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }, displayHeaderFooter: false },
      css: `
        body { font-family: 'Helvetica', 'Arial', sans-serif; font-size: 11pt; line-height: 1.6; color: #333; }
        h1, h2, h3 { color: #222; margin-bottom: 10px; }
        p { margin-bottom: 15px; }
      `
    }
  );

  if (pdfOutput) {
     fs.writeFileSync(outputPath, pdfOutput.content);
  }

  return outputPath;
}
