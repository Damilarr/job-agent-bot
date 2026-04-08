export function sanitizeGoogleFormQuestionLabel(raw: string): string {
  let t = raw.trim();
  t = t.replace(/\s*\*$/, "").trim();
  t = t.replace(/\s*Required\s*$/i, "").trim();
  const lines = t.split(/\n/).filter((l) => l.trim().length > 0);
  const first = (lines[0] ?? t).trim();
  return first.slice(0, 200);
}
