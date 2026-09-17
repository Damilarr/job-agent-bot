import { aiService, normalizeDashes } from "./ai.js";

/**
 * Second pass over generated application text: removes or softens any claim the candidate background does not support.
 * Models reliably embellish when asked to "match" a job, so this runs on everything that is sent to employers.
 * Falls back to the original text if the check fails, since a failed check should not block an application.
 */
export async function removeUnsupportedClaims(
  text: string,
  candidateBackground: string,
  options: { allowedClaims?: string[] } = {},
): Promise<string> {
  const claimsBlock = options.allowedClaims?.length
    ? `\nALLOWED CLAIMS (the only statements about the candidate's work that may appear; each is tied to the employer or project in brackets):\n${options.allowedClaims.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`
    : "";
  const prompt = `
You are a strict fact-checker for a job application written in the candidate's voice.

Compare every factual claim in the APPLICATION TEXT against the CANDIDATE BACKGROUND.
A claim is unsupported if it:
- mentions an employer, project, technology, metric, responsibility or outcome that the background does not state
- ties a technology or skill to a specific employer or project when the background does not tie them together
- describes work in stronger or different terms than the background (e.g. calling a media overlay UI a "data-heavy dashboard")
- states years of experience different from the PROFILE
- describes a past role (one with an end date) as current
- combines two separate pieces of work into one (e.g. "an authentication UI with real-time search overlays" when those are two different projects)
- adds a descriptor the source doesn't use, such as "dashboard", "real-time", "large-scale" or "production"
- says a technology was used ("both in React/Next.js") unless that exact technology is stated for that piece of work

Rewrite the text so that every unsupported claim is removed, or reduced to exactly what the background supports.
Keep everything else identical: greeting, structure, paragraph breaks, tone, wording of supported sentences, and any closing lines.
Statements about availability, interest in the role, or the company itself are not factual claims about the candidate; keep them.
Do not add anything new.

CANDIDATE BACKGROUND:
---
${candidateBackground}
---
${claimsBlock}
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
      // This check gates emails that may be sent without review, so it gets more reasoning than drafting
      reasoning_effort: "medium",
    });
    const content = response.choices[0]?.message?.content;
    const checked = content ? (JSON.parse(content) as { text?: string }).text?.trim() : undefined;
    return checked ? normalizeDashes(checked) : text;
  } catch (error) {
    console.error("Fact check failed, using unchecked text:", error);
    return text;
  }
}
