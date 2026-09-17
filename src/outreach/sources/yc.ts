import axios from "axios";
import { companyDomainFromUrl } from "../domain.js";
import type { CompanyCandidate } from "../types.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DIRECTORY_URL = "https://www.ycombinator.com/companies";

interface AlgoliaHit {
  name: string;
  slug: string;
  website?: string;
  one_liner?: string;
  long_description?: string;
  team_size?: number;
  all_locations?: string;
  regions?: string[];
  industries?: string[];
}

interface YcJobPosting {
  title: string;
  location?: string;
  visa?: string;
  role?: string;
  minExperience?: string;
}

interface YcFounder {
  full_name: string;
  title?: string;
  founder_bio?: string;
}

/** The directory's public, search-only Algolia key is embedded in the page and may rotate, so read it each run. */
async function getAlgoliaOptions(): Promise<{ app: string; key: string }> {
  const { data } = await axios.get<string>(DIRECTORY_URL, { headers: { "User-Agent": USER_AGENT }, timeout: 20_000 });
  const match = data.match(/window\.AlgoliaOpts\s*=\s*(\{[^}]+\})/);
  if (!match?.[1]) throw new Error("YC directory search key not found");
  return JSON.parse(match[1]);
}

/** Actively hiring, remote-friendly YC companies of 3-200 people, in random order. */
export async function fetchYcCandidates(limit = 200): Promise<CompanyCandidate[]> {
  const { app, key } = await getAlgoliaOptions();
  const { data } = await axios.post(
    `https://${app}-dsn.algolia.net/1/indexes/YCCompany_production/query`,
    {
      query: "",
      hitsPerPage: 1000,
      filters: 'isHiring:true AND status:Active AND team_size >= 3 AND team_size <= 200 AND regions:"Remote"',
    },
    {
      headers: { "X-Algolia-Application-Id": app, "X-Algolia-API-Key": key, "User-Agent": USER_AGENT },
      timeout: 30_000,
    },
  );

  const hits = (data.hits as AlgoliaHit[]).sort(() => Math.random() - 0.5);
  const candidates: CompanyCandidate[] = [];
  for (const hit of hits) {
    const domain = companyDomainFromUrl(hit.website);
    if (!domain) continue;
    candidates.push({
      source: "yc",
      sourceUrl: `${DIRECTORY_URL}/${hit.slug}`,
      name: hit.name,
      domain,
      description: [hit.one_liner, hit.long_description].filter(Boolean).join("\n\n"),
      ...(hit.team_size ? { teamSize: hit.team_size } : {}),
      hiringNotes: `Locations: ${hit.all_locations || "unknown"}. Regions: ${(hit.regions || []).join(", ")}.`,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/**
 * Loads founders, country and open roles from the company's YC page.
 * Job posting locations and visa notes show whether "remote" means worldwide or one country only.
 */
export async function hydrateYcCandidate(candidate: CompanyCandidate): Promise<CompanyCandidate> {
  const { data } = await axios.get<string>(candidate.sourceUrl, { headers: { "User-Agent": USER_AGENT }, timeout: 20_000 });
  const pageJson = data.match(/data-page="([^"]+)"/)?.[1];
  if (!pageJson) return candidate;

  const decoded = pageJson
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const props = JSON.parse(decoded).props as {
    company?: { country?: string; founders?: YcFounder[] };
    jobPostings?: YcJobPosting[];
  };

  const jobs = (props.jobPostings || [])
    .map((j) => `- ${j.title.trim()} | ${j.location || "location not stated"} | ${j.visa || "visa not stated"} | ${j.minExperience || ""}`)
    .join("\n");

  return {
    ...candidate,
    ...(props.company?.country ? { country: props.company.country } : {}),
    founders: (props.company?.founders || []).map((f) => ({
      name: f.full_name,
      title: [f.title, f.founder_bio?.slice(0, 160)].filter(Boolean).join(" - "),
    })),
    hiringNotes: `${candidate.hiringNotes}\nOpen roles on YC:\n${jobs || "none listed"}`,
  };
}
