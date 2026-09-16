import { aiService, normalizeDashes } from "./ai.js";

/**
 * Second pass over generated application text: removes or softens any claim the candidate background does not support.
 * Models reliably embellish when asked to "match" a job, so this runs on everything that is sent to employers.
 * Falls back to the original text if the check fails, since a failed check should not block an application.
 */
export async function removeUnsupportedClaims(text: string, candidateBackground: string): Promise<string> {
  const prompt = `
You are a strict fact-checker for a job application written in the candidate's voice.

Compare every factual claim in the APPLICATION TEXT against the CANDIDATE BACKGROUND.
A claim is unsupported if it:
- mentions an employer, project, technology, metric, responsibility or outcome that the background does not state
- ties a technology or skill to a specific employer or project when the background does not tie them together
- describes work in stronger or different terms than the background (e.g. calling a media overlay UI a "data-heavy dashboard")
- states years of experience different from the PROFILE
- describes a past role (one with an end date) as current

Rewrite the text so that every unsupported claim is removed, or reduced to exactly what the background supports.
Keep everything else identical: greeting, structure, paragraph breaks, tone, wording of supported sentences, and any closing lines.
Statements about availability, interest in the role, or the company itself are not factual claims about the candidate; keep them.
Do not add anything new.

CANDIDATE BACKGROUND:
---
${candidateBackground}
---

APPLICATION TEXT:
---
${text}
---

Return JSON: {"text": "<the corrected application text>"}
`;

  try {
    const response = await aiService.complete({
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    });
    const content = response.choices[0]?.message?.content;
    const checked = content ? (JSON.parse(content) as { text?: string }).text?.trim() : undefined;
    return checked ? normalizeDashes(checked) : text;
  } catch (error) {
    console.error("Fact check failed, using unchecked text:", error);
    return text;
  }
}
