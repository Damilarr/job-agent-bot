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
