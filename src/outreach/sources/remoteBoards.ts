import axios from "axios";
import { firstCompanyDomainInText, htmlToText } from "../domain.js";
import type { CompanyCandidate } from "../types.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ENGINEERING_TITLE = /engineer|developer|frontend|front-end|full[\s-]?stack|react|software|web/i;

const domainCache = new Map<string, string | null>();

/**
 * Resolves a company name to its domain via Clearbit's public autocomplete.
 * Only an exact (case-insensitive) name match is accepted, since near matches are usually different companies.
 */
async function lookupDomainByName(name: string): Promise<string | null> {
  const key = name.trim().toLowerCase();
  if (domainCache.has(key)) return domainCache.get(key)!;
  try {
    const { data } = await axios.get<{ name: string; domain: string }[]>(
      "https://autocomplete.clearbit.com/v1/companies/suggest",
      { params: { query: name.trim() }, timeout: 15_000 },
    );
    const exact = data.find((c) => c.name.trim().toLowerCase() === key);
    domainCache.set(key, exact?.domain ?? null);
    return exact?.domain ?? null;
  } catch {
    return null;
  }
}

function groupByCompany<T>(jobs: T[], companyOf: (job: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const job of jobs) {
    const company = companyOf(job).trim();
    if (!company) continue;
    groups.set(company, [...(groups.get(company) || []), job]);
  }
  return groups;
}

interface RemotiveJob {
  company_name: string;
  title: string;
  url: string;
  candidate_required_location: string;
  description: string;
}

/** Companies with engineering roles on Remotive. The board lists the regions each role accepts. */
export async function fetchRemotiveCandidates(): Promise<CompanyCandidate[]> {
  const { data } = await axios.get<{ jobs: RemotiveJob[] }>("https://remotive.com/api/remote-jobs", {
    params: { category: "software-dev" },
    headers: { "User-Agent": USER_AGENT },
    timeout: 30_000,
  });

  const candidates: CompanyCandidate[] = [];
  for (const [company, jobs] of groupByCompany(data.jobs, (j) => j.company_name)) {
    const engJobs = jobs.filter((j) => ENGINEERING_TITLE.test(j.title));
    if (!engJobs.length) continue;
    const description = htmlToText(engJobs[0]!.description);
    // Name lookup first: descriptions often link to a product site rather than the company domain
    const domain = (await lookupDomainByName(company)) ?? firstCompanyDomainInText(description);
    if (!domain) continue;
    candidates.push({
      source: "remotive",
      sourceUrl: engJobs[0]!.url,
      name: company,
      domain,
      description: description.slice(0, 2500),
      hiringNotes: `Remote roles on Remotive:\n${engJobs.map((j) => `- ${j.title} | accepts: ${j.candidate_required_location}`).join("\n")}`,
    });
  }
  return candidates;
}

interface RemoteOkJob {
  company?: string;
  position?: string;
  location?: string;
  description?: string;
  url?: string;
}

/** Companies with engineering roles on RemoteOK. */
export async function fetchRemoteOkCandidates(): Promise<CompanyCandidate[]> {
  const { data } = await axios.get<RemoteOkJob[]>("https://remoteok.com/api", {
    params: { tag: "dev" },
    headers: { "User-Agent": USER_AGENT },
    timeout: 30_000,
  });

  const jobs = data.filter((j) => j.company && j.position && ENGINEERING_TITLE.test(j.position));
  const candidates: CompanyCandidate[] = [];
  for (const [company, companyJobs] of groupByCompany(jobs, (j) => j.company!)) {
    const description = htmlToText(companyJobs[0]!.description || "");
    // Name lookup first: descriptions often link to a product site rather than the company domain
    const domain = (await lookupDomainByName(company)) ?? firstCompanyDomainInText(description);
    if (!domain) continue;
    candidates.push({
      source: "remoteok",
      sourceUrl: companyJobs[0]!.url || "https://remoteok.com",
      name: company,
      domain,
      description: description.slice(0, 2500),
      hiringNotes: `Remote roles on RemoteOK:\n${companyJobs.map((j) => `- ${j.position} | location: ${j.location || "not stated"}`).join("\n")}`,
    });
  }
  return candidates;
}
