import { aiService, normalizeDashes } from "../services/ai.js";
import type { DraftContext } from "../services/drafter.js";
import { composeEmailBody, FACT_RULES, STYLE_RULES } from "../services/drafter.js";
import { removeUnsupportedClaims } from "../services/factCheck.js";
import type { Qualification } from "./qualify.js";
import type { CompanyCandidate, Contact } from "./types.js";

export interface ColdEmailInput {
  company: CompanyCandidate;
  qualification: Qualification;
  contact: Contact;
  /** Profile text combined with resume text */
  background: string;
  /** Resume and profile bullet points, labelled with their employer or project */
  allowedClaims: string[];
  targetRoles: string;
  candidateLocation: string;
  signature: DraftContext;
}

export interface ColdEmail {
  subject: string;
  body: string;
}

const OPT_OUT_LINE = "If this isn't relevant for you, just let me know and I won't follow up.";

/** Addresses like jobs@ or hello@ belong to a team, so the greeting shouldn't use a person's name. */
export function isRoleAddress(email: string): boolean {
  return /^(jobs|job|careers|career|hiring|hire|hr|talent|recruiting|recruitment|people|hello|hi|hey|team|info|contact|work|apply|founders|engineering)(\+[^@]*)?@/i.test(email);
}

/**
 * "rishi@quill.co" -> "Rishi"; null for team addresses, product-named addresses ("atlas@cyberatlas.ai")
 * and local parts that don't look like a first name.
 */
export function firstNameFromAddress(email: string, companyName = ""): string | null {
  if (isRoleAddress(email)) return null;
  const [localPart, host = ""] = email.toLowerCase().split("@");
  const first = localPart!.split("+")[0]!.split(/[._-]/)[0]!;
  if (!/^[a-z]{2,15}$/.test(first)) return null;
  const companyWords = `${host} ${companyName.toLowerCase()}`.replace(/[^a-z]/g, "");
  if (companyWords.includes(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function greeting(input: ColdEmailInput): string {
  const firstName = input.contact.name.split(" ")[0] || firstNameFromAddress(input.contact.email, input.company.name);
  return firstName && !isRoleAddress(input.contact.email) ? `Hi ${firstName},` : `Hi ${input.company.name} team,`;
}

export function buildColdSubject(company: CompanyCandidate, targetRoles: string): string {
  const role = targetRoles.split("(")[0]!.trim();
  return `${role.charAt(0).toUpperCase()}${role.slice(1)} interested in ${company.name}`;
}

/** Rejects drafts with placeholders, wrong length or missing specifics, so a bad generation is never auto-sent. */
function validateColdBody(body: string, input: ColdEmailInput): void {
  const locationWord = input.candidateLocation.split(/[\s,(]/)[0]!;
  if (!body.includes(locationWord)) throw new Error(`Cold email doesn't say the candidate is in ${locationWord}`);
  if (/(^|[.!?]\s+|\n)(Built|Developed|Engineered|Designed|Implemented|Created|Integrated|Optimized|Shipped|Maintained|Collaborated)\b/.test(body)) {
    throw new Error("Cold email has a sentence fragment without a subject");
  }
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < 60 || words > 180) throw new Error(`Cold email has ${words} words, expected 60-180`);
  if (/[[\]{}]|<[^>]+>/.test(body)) throw new Error("Cold email contains placeholder brackets");
  if (!body.toLowerCase().includes(input.company.name.toLowerCase())) throw new Error("Cold email doesn't mention the company");
  if (/best regards|sincerely|cheers,|attached/i.test(body)) throw new Error("Cold email includes a sign-off or attachment note");
}

export async function generateColdEmail(input: ColdEmailInput): Promise<ColdEmail> {
  const prompt = `
You are writing a short cold email from a job seeker to someone at a company that has not necessarily advertised a matching role.
The email is sent to ${input.contact.source === "published" ? `the address the company published for hiring (${input.contact.email})` : `${input.contact.name}, ${input.contact.title}`}.

GOAL: a founder or engineering lead reads it in 20 seconds, sees a specific reason this person could help them, and replies to set up a chat.

Company: ${input.company.name}
What they build: ${input.qualification.whatTheyBuild}
Why the candidate could help: ${input.qualification.angle}
Company details:
${input.company.description.slice(0, 1500)}

The candidate is open to: ${input.targetRoles}.
The candidate is based in ${input.candidateLocation} and works remotely; they are open to full-time or contract work, including through an employer-of-record service.

STRUCTURE (plain text, paragraphs separated by one blank line, 80-140 words in total):
1. Greeting, exactly: "${greeting(input)}"
2. Paragraph 1 (1-2 sentences): "I'm a frontend and full-stack engineer based in ${input.candidateLocation.split("(")[0]!.trim()}" (or close to it), then a specific reason for writing to ${input.company.name} based on what the company builds. The reason must be about the company; don't make any claim about the candidate's interests, habits or work here. No flattery.
3. Paragraph 2 (2-3 sentences): pick the 1-2 ALLOWED CLAIMS most relevant to this company. Write each as its own first-person sentence ("At <employer>, I ..." or "In a personal project, <name>, I ..."), in natural wording but with exactly the same meaning: no merging claims, no added technologies, and no added descriptors like "dashboard", "real-time" or "production" unless that claim says so. Prefer paid work over personal projects when both fit.
4. Paragraph 3 (1-2 sentences): say they work remotely${/\(([^)]+)\)/.test(input.candidateLocation) ? ` (${input.candidateLocation.match(/\(([^)]+)\)/)![1]})` : ""} and are open to full-time or contract work, without repeating the country. Ask if there is room for a short call, even if no role is posted. Don't propose specific work on their product (e.g. "help polish your UI").
Do NOT write a sign-off, name, contact details, links, or a note about attachments. Those are added automatically.
Do NOT claim the company is hiring for a specific role unless the company details say so.
Do NOT mention years of experience; the attached resume shows the dates.
${FACT_RULES}
${STYLE_RULES}

ALLOWED CLAIMS (the only statements about the candidate's work you may use):
${input.allowedClaims.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Return JSON: {"body": "<the email body>"}
`;

  // One retry: generations vary, and a draft that fails validation is usually fixed by a second attempt
  let checked = "";
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await aiService.complete({
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.3,
      });
      const raw = (JSON.parse(response.choices[0]?.message?.content || "{}") as { body?: string }).body;
      if (!raw) throw new Error("Model returned no cold email body");

      checked = normalizeDashes(await removeUnsupportedClaims(normalizeDashes(raw.trim()), input.background, { allowedClaims: input.allowedClaims }));
      validateColdBody(checked, input);
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }

  const body = composeEmailBody(
    { subject: "", bodyText: `${checked}\n\n${OPT_OUT_LINE}` },
    input.signature,
    { resume: true, coverLetter: false },
  );
  return { subject: buildColdSubject(input.company, input.targetRoles), body };
}

/** A two or three sentence nudge sent in the same thread about a week later. */
export async function generateFollowUp(params: {
  companyName: string;
  contactName: string | null;
  contactEmail: string;
  originalBody: string;
  signature: DraftContext;
}): Promise<string> {
  const firstName = params.contactName?.split(" ")[0] || firstNameFromAddress(params.contactEmail, params.companyName);
  const hello = firstName && !isRoleAddress(params.contactEmail) ? `Hi ${firstName},` : `Hi ${params.companyName} team,`;

  const prompt = `
Write a brief, polite follow-up to a cold job-seeking email that got no reply a week ago.
It is sent as a reply in the same thread, so do not repeat the whole pitch.

Original email:
---
${params.originalBody}
---

Rules:
- Start with exactly: "${hello}"
- 2-3 sentences, under 60 words after the greeting.
- Mention one concrete thing from the original email so it doesn't read as generic.
- Offer an easy out: no reply needed if it's not a fit.
- No sign-off, name, links or attachment note. Those are added automatically.
${STYLE_RULES}

Return JSON: {"body": "<the follow-up body>"}
`;

  const response = await aiService.complete({
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });
  const raw = (JSON.parse(response.choices[0]?.message?.content || "{}") as { body?: string }).body;
  if (!raw) throw new Error("Model returned no follow-up body");

  return composeEmailBody(
    { subject: "", bodyText: normalizeDashes(raw.trim()) },
    params.signature,
    { resume: false, coverLetter: false },
  );
}
