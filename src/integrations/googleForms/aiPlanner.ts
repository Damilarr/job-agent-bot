import { aiService } from "../../services/ai.js";
import type { ScrapedFormQuestion, FormAnswerPlanItem, FormAnswerPlan } from "./types.js";

/**
 * Use Gemini AI to generate an answer plan for all scraped form questions.
 */
export async function generateFormAnswerPlan(
  questions: ScrapedFormQuestion[],
  userProfileText: string,
  jobDescription: string,
  formTitle: string,
  context: {
    applicantName?: string | undefined;
    applicantEmail?: string | undefined;
    phone?: string | undefined;
    githubUrl?: string | undefined;
    linkedinUrl?: string | undefined;
    portfolioUrl?: string | undefined;
    roleTitle?: string | undefined;
    hasResume?: boolean | undefined;
    hasCoverLetter?: boolean | undefined;
  },
): Promise<FormAnswerPlan> {
  const ai = aiService.getClient();

  const questionsJSON = questions.map((q) => ({
    index: q.index,
    label: q.label,
    type: q.type,
    options: q.options || null,
    required: q.required,
  }));

  const prompt = `You are an expert job application assistant. A user is applying to a job through a Google Form.

FORM TITLE: "${formTitle}"

JOB DESCRIPTION:
${jobDescription || "Not provided"}

USER'S PROFILE/CV:
${userProfileText}

USER'S DETAILS:
- Name: ${context.applicantName || "Unknown"}
- Email: ${context.applicantEmail || "Unknown"}
- Phone: ${context.phone || "Not provided"}
- GitHub: ${context.githubUrl || "Not provided"}
- LinkedIn: ${context.linkedinUrl || "Not provided"}
- Portfolio: ${context.portfolioUrl || "Not provided"}
- Applying for: ${context.roleTitle || "Not specified"}
- Has resume file: ${context.hasResume ? "Yes" : "No"}
- Has cover letter file: ${context.hasCoverLetter ? "Yes" : "No"}

FORM QUESTIONS:
${JSON.stringify(questionsJSON, null, 2)}

For EACH question, provide the best answer. Rules:
1. For "radio" or "select" questions: pick the BEST option from the available options list. Return EXACTLY one of the listed options.
2. For "checkbox" questions: pick ALL applicable options, separated by " | ".
3. For "text" questions: provide a concise, factual answer (name, email, URL, phone, etc.).
4. For "textarea" questions: write a professional, well-crafted answer (2-4 sentences).
5. For "file" questions: set fileKind to "resume" if it asks for a CV/resume, "cover_letter" if it asks for a cover letter, or "none" if you're unsure.
6. For "date" or "time" questions, answer in YYYY-MM-DD or HH:MM format.
7. NEVER skip a question. Provide a reasonable answer for every single one.
8. Be careful to distinguish between fields asking about the APPLICANT vs the REFERRER or COMPANY.
9. For questions about salary expectations, availability, work authorization, etc. — give reasonable, professional answers.

Respond ONLY with a JSON array in this exact format, no other text:
[
  { "index": 0, "answer": "John Doe", "fileKind": null },
  { "index": 1, "answer": "Frontend Developer", "fileKind": null },
  { "index": 2, "answer": "", "fileKind": "resume" }
]`;

  const response = await ai.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  const rawText = response.choices[0]?.message?.content?.trim() || "[]";
  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("AI did not return valid JSON");
  }

  const aiAnswers = JSON.parse(jsonMatch[0]) as Array<{
    index: number;
    answer: string;
    fileKind?: string | null;
  }>;

  // Merge AI answers with question metadata
  const answers: FormAnswerPlanItem[] = questions.map((q) => {
    const aiAnswer = aiAnswers.find((a) => a.index === q.index);
    return {
      index: q.index,
      label: q.label,
      type: q.type,
      answer: aiAnswer?.answer || "",
      fileKind: (aiAnswer?.fileKind as "resume" | "cover_letter" | "none") || undefined,
    };
  });

  return { formTitle, answers };
}

/**
 * Revise an existing answer plan based on user feedback.
 */
export async function reviseFormAnswerPlan(
  currentPlan: FormAnswerPlan,
  userInstruction: string,
  userProfileText: string,
  jobDescription: string,
): Promise<FormAnswerPlan> {
  const ai = aiService.getClient();

  const prompt = `You are an expert job application assistant. You previously planned answers for a Google Form.

FORM TITLE: "${currentPlan.formTitle}"

CURRENT ANSWER PLAN:
${JSON.stringify(currentPlan.answers.map(a => ({ index: a.index, label: a.label, type: a.type, answer: a.answer })), null, 2)}

JOB DESCRIPTION:
${jobDescription || "Not provided"}

USER'S PROFILE/CV:
${userProfileText}

The user wants the following changes:
"${userInstruction}"

Apply the requested changes to the answer plan. Only change answers that the user specifically asks about — keep everything else the same.

Respond ONLY with the FULL updated JSON array (including unchanged answers), no other text:
[
  { "index": 0, "answer": "Updated answer" },
  { "index": 1, "answer": "Unchanged answer" }
]`;

  const response = await ai.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  const rawText = response.choices[0]?.message?.content?.trim() || "[]";
  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("AI did not return valid JSON for revision");

  const revised = JSON.parse(jsonMatch[0]) as Array<{
    index: number;
    answer: string;
  }>;

  // Merge revisions into existing plan
  const updatedAnswers = currentPlan.answers.map((existing) => {
    const rev = revised.find((r) => r.index === existing.index);
    return {
      ...existing,
      answer: rev?.answer ?? existing.answer,
    };
  });

  return { ...currentPlan, answers: updatedAnswers };
}
