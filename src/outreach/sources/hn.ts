import axios from "axios";
import { companyDomainFromUrl, extractEmails, firstCompanyDomainInText, htmlToText } from "../domain.js";
import type { CompanyCandidate } from "../types.js";

interface HnItem {
  id: number;
  title?: string;
  text?: string | null;
  created_at: string;
  children?: HnItem[];
}

/** Top-level posts from the latest "Ask HN: Who is hiring?" thread that mention remote work, in random order. */
export async function fetchHnCandidates(): Promise<CompanyCandidate[]> {
  const search = await axios.get("https://hn.algolia.com/api/v1/search_by_date", {
    params: { tags: "story,author_whoishiring", query: "who is hiring", hitsPerPage: 5 },
    timeout: 20_000,
  });
  const story = (search.data.hits as { objectID: string; title: string }[]).find((h) =>
    /^Ask HN: Who is hiring\?/i.test(h.title),
  );
  if (!story) return [];

  const { data: thread } = await axios.get<HnItem>(`https://hn.algolia.com/api/v1/items/${story.objectID}`, {
    timeout: 60_000,
  });

  const candidates: CompanyCandidate[] = [];
  for (const post of thread.children || []) {
    if (!post.text) continue;
    const text = htmlToText(post.text);
    if (!/remote/i.test(text)) continue;

    // Posts conventionally start with "Company | Role | Location | ..."
    const header = text.split("\n")[0] ?? "";
    const name = header.split("|")[0]?.replace(/\(.*?\)/g, "").trim();
    if (!name || name.length > 60) continue;

    const headerUrl = header.match(/https?:\/\/\S+|\b[a-z0-9-]+\.(?:com|io|ai|co|dev|app|so|tech|org|net)\b/i)?.[0];
    const domain = companyDomainFromUrl(headerUrl) ?? firstCompanyDomainInText(text);
    if (!domain) continue;

    // Only trust addresses on the company's own domain; others are often recruiters or unrelated
    const publishedEmail = extractEmails(text).find((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));

    candidates.push({
      source: "hn",
      sourceUrl: `https://news.ycombinator.com/item?id=${post.id}`,
      name,
      domain,
      description: text.slice(0, 2500),
      hiringNotes: `HN "Who is hiring" post header: ${header}`,
      ...(publishedEmail ? { publishedEmail } : {}),
    });
  }

  return candidates.sort(() => Math.random() - 0.5);
}
