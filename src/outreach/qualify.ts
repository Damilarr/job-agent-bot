import { aiService } from "../services/ai.js";
import type { CompanyCandidate } from "./types.js";

const AFRICAN_COUNTRIES = [
  "algeria", "angola", "benin", "botswana", "burkina faso", "burundi", "cabo verde", "cape verde", "cameroon",
  "central african republic", "chad", "comoros", "congo", "democratic republic of the congo", "djibouti", "egypt",
  "equatorial guinea", "eritrea", "eswatini", "swaziland", "ethiopia", "gabon", "gambia", "ghana", "guinea",
  "guinea-bissau", "ivory coast", "côte d'ivoire", "cote d'ivoire", "kenya", "lesotho", "liberia", "libya",
  "madagascar", "malawi", "mali", "mauritania", "mauritius", "morocco", "mozambique", "namibia", "niger", "nigeria",
  "rwanda", "sao tome and principe", "senegal", "seychelles", "sierra leone", "somalia", "south africa",
  "south sudan", "sudan", "tanzania", "togo", "tunisia", "uganda", "zambia", "zimbabwe",
];

export function isAfricanCountry(country: string | undefined | null): boolean {
  if (!country) return false;
  const c = country.trim().toLowerCase();
  if (c.includes("papua new guinea")) return false;
  return AFRICAN_COUNTRIES.some((a) => new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`).test(c));
}

export interface Qualification {
  qualified: boolean;
  /** The company's real name; sources sometimes put a job title where the name should be */
  companyName: string;
  reason: string;
  companyCountry: string | null;
  /** One sentence on what the company builds, in plain words, for the email opener */
  whatTheyBuild: string;
  /** Why this candidate is relevant to this company, grounded in the company data */
  angle: string;
}

/**
 * Decides whether a company is worth a cold email: a software product company outside Africa,
 * small enough for founders to decide, with web engineering needs, and not restricted to hiring in one country.
 */
export async function qualifyCompany(
  candidate: CompanyCandidate,
  targetRoles: string,
  candidateLocation: string,
): Promise<Qualification> {
  if (isAfricanCountry(candidate.country)) {
    return { qualified: false, reason: `Based in ${candidate.country}`, companyName: candidate.name, companyCountry: candidate.country ?? null, whatTheyBuild: "", angle: "" };
  }
  if (candidate.teamSize && candidate.teamSize > 200) {
    return { qualified: false, reason: `Too large (${candidate.teamSize} people)`, companyName: candidate.name, companyCountry: candidate.country ?? null, whatTheyBuild: "", angle: "" };
  }

  const prompt = `
You screen companies for a job seeker's cold outreach. Judge only from the data below; if something is not stated, treat it as unknown.

Job seeker: open to ${targetRoles}. Based in ${candidateLocation}, working remotely.

Company (as listed by the source, may be wrong): ${candidate.name} (${candidate.domain})
Country: ${candidate.country || "unknown"}
Team size: ${candidate.teamSize ?? "unknown"}
Description:
${candidate.description.slice(0, 2500)}

Hiring and location evidence:
${candidate.hiringNotes.slice(0, 2000)}

Answer these:
0. companyName: the company's actual name as it would appear in an email greeting (e.g. "Legal Ark AI"), never a job title.
1. companyCountry: the country where the company is headquartered, or null if unknown.
2. buildsSoftware: does the company build its own software product (not an agency, staffing firm, or non-tech business)?
3. needsWebEngineers: is it plausible they need frontend or full-stack web engineers?
4. remoteScope: "worldwide" if they hire remotely without country restrictions or across many regions; "restricted" if every role is limited to specific countries/regions that exclude ${candidateLocation} (e.g. "Remote (US)", "US citizen/visa only", "Europe only", onsite only); "unknown" otherwise.
5. tooSenior: true only if every engineering role requires 6+ years or staff/principal level.
6. whatTheyBuild: one plain sentence describing what they build.
7. angle: one sentence on why a ${targetRoles.split("(")[0]!.trim()} could help them, grounded only in the company data.

Return JSON: {"companyName": string, "companyCountry": string|null, "buildsSoftware": boolean, "needsWebEngineers": boolean, "remoteScope": "worldwide"|"restricted"|"unknown", "tooSenior": boolean, "whatTheyBuild": string, "angle": string}
`;

  const response = await aiService.complete({
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  const r = JSON.parse(response.choices[0]?.message?.content || "{}") as {
    companyName?: string;
    companyCountry?: string | null;
    buildsSoftware?: boolean;
    needsWebEngineers?: boolean;
    remoteScope?: "worldwide" | "restricted" | "unknown";
    tooSenior?: boolean;
    whatTheyBuild?: string;
    angle?: string;
  };

  const companyCountry = r.companyCountry || candidate.country || null;
  const companyName = r.companyName?.trim() && r.companyName.trim().length <= 60 ? r.companyName.trim() : candidate.name;
  const base = { companyName, companyCountry, whatTheyBuild: r.whatTheyBuild || "", angle: r.angle || "" };

  if (isAfricanCountry(companyCountry)) return { ...base, qualified: false, reason: `Based in ${companyCountry}` };
  if (!r.buildsSoftware) return { ...base, qualified: false, reason: "Not a software product company" };
  if (!r.needsWebEngineers) return { ...base, qualified: false, reason: "Unlikely to need web engineers" };
  if (r.remoteScope === "restricted") return { ...base, qualified: false, reason: "Remote hiring restricted to other countries" };
  if (r.tooSenior) return { ...base, qualified: false, reason: "Only hiring senior engineers" };
  if (!base.whatTheyBuild) return { ...base, qualified: false, reason: "Not enough company information" };

  return { ...base, qualified: true, reason: `Remote scope: ${r.remoteScope}` };
}
