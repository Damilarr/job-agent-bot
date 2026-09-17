import fs from "fs";
import { extractText, getDocumentProxy } from "unpdf";

const cache = new Map<string, { mtimeMs: number; text: string }>();

/**
 * Extracts plain text from an uploaded resume PDF.
 * Returns null when the file is missing or unreadable so callers can fall back to the profile text.
 */
export async function extractResumeText(resumePath: string | null | undefined): Promise<string | null> {
  if (!resumePath || !fs.existsSync(resumePath)) return null;

  try {
    const { mtimeMs } = fs.statSync(resumePath);
    const cached = cache.get(resumePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.text;

    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(resumePath)));
    const { text } = await extractText(pdf, { mergePages: true });
    const trimmed = text.trim();
    if (!trimmed) return null;

    cache.set(resumePath, { mtimeMs, text: trimmed });
    return trimmed;
  } catch (error) {
    console.error("Failed to extract resume text:", error);
    return null;
  }
}

/** Finds the first phone number in the resume header, e.g. "+2348121615245" or "+1 (555) 123-4567". */
export function extractPhone(resumeText: string | null | undefined): string | undefined {
  const match = resumeText?.slice(0, 500).match(/\+?\d[\d\s().-]{8,}\d/);
  return match?.[0].trim();
}

/**
 * Combines the user's profile text and resume text into the candidate background given to the model.
 * The profile is the user's own framing (years of experience, target roles); the resume holds the concrete history.
 */
export function buildCandidateBackground(profileText: string, resumeText: string | null): string {
  if (!resumeText) return profileText;
  return `PROFILE (the candidate's own summary; use it for years of experience and target roles):
${profileText}

RESUME (the candidate's full resume; use it for employers, dates, projects and achievements):
${resumeText}`;
}

const SECTION_TITLES = /^(experience|work experience|projects|education|skills|technical skills|professional summary|summary|recent highlights|certifications|awards)\s*:?$/i;
const BULLET = /^\s*[–—•*-]\s+/;

/**
 * Turns resume and profile bullet points into standalone claims, each labelled with its employer or project,
 * e.g. "[MyAI Robotics LLC Oct 2024 – Nov 2025 | Fullstack Developer] Built a custom web search module ...".
 * Cold emails may only use these claims, which stops the model from merging or embellishing work.
 */
export function extractFactList(profileText: string, resumeText: string | null): string[] {
  const facts: string[] = [];

  const collect = (text: string, fallbackLabel: string) => {
    let pendingHeading: string[] = [];
    let blockLabel = fallbackLabel;
    let inProjects = false;
    let current: { label: string; text: string } | null = null;
    const flush = () => {
      const isKeyValue = current && /^[A-Za-z /&]+:\s/.test(current.text); // e.g. "Languages: JavaScript, ..."
      if (current && !isKeyValue && current.text.split(/\s+/).length >= 5) facts.push(`[${current.label}] ${current.text.trim()}`);
      current = null;
    };

    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (BULLET.test(line)) {
        flush();
        if (pendingHeading.length) blockLabel = `${inProjects ? "Personal project: " : ""}${pendingHeading.join(" | ")}`;
        pendingHeading = [];
        current = { label: blockLabel, text: line.replace(BULLET, "") };
      } else if (current && /^[a-z(]/.test(line)) {
        current.text += ` ${line}`; // wrapped continuation of the previous bullet
      } else {
        flush();
        if (SECTION_TITLES.test(line)) {
          pendingHeading = [];
          blockLabel = fallbackLabel;
          inProjects = /^projects/i.test(line);
        } else {
          pendingHeading = [...pendingHeading, line.replace(/:$/, "")].slice(-2);
        }
      }
    }
    flush();
  };

  if (resumeText) collect(resumeText, "Resume");
  collect(profileText, "Profile highlight");
  return facts;
}
