/** Hosts that belong to job boards, ATS vendors or social sites rather than the hiring company. */
const NON_COMPANY_HOSTS = [
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "instagram.com", "youtube.com", "github.com", "medium.com",
  "ycombinator.com", "workatastartup.com", "news.ycombinator.com", "wellfound.com", "angel.co",
  "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "breezy.hr", "bamboohr.com", "recruitee.com",
  "smartrecruiters.com", "teamtailor.com", "jobvite.com", "myworkdayjobs.com", "workday.com", "notion.so",
  "notion.site", "google.com", "forms.gle", "docs.google.com", "typeform.com", "calendly.com", "remotive.com",
  "remoteok.com", "weworkremotely.com", "gmail.com", "bit.ly", "t.co", "rippling.com", "dover.com", "gem.com",
  "pinpointhq.com", "personio.de", "personio.com", "join.com", "welcometothejungle.com", "otta.com",
];

/** "https://www.Mux.com/jobs?x" -> "mux.com"; returns null for job boards, ATS vendors and invalid URLs. */
export function companyDomainFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".")) return null;
    if (NON_COMPANY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
    return host;
  } catch {
    return null;
  }
}

/** First company-looking domain among the links in a block of text. */
export function firstCompanyDomainInText(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) {
    const domain = companyDomainFromUrl(match[0]);
    if (domain) return domain;
  }
  return null;
}

/** Email addresses written plainly or lightly obfuscated, e.g. "jobs [at] acme [dot] com". */
export function extractEmails(text: string): string[] {
  const normalized = text
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".");
  const found = normalized.match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/\.$/, "")))];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>|<p>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>.*?<\/a>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}
