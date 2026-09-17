import axios from "axios";
import type { Contact } from "./types.js";

const API = "https://api.apollo.io/api/v1";

/** Companies up to 200 people; larger ones tend to route candidates through recruiters. */
const EMPLOYEE_RANGES = ["1,10", "11,20", "21,50", "51,100", "101,200"];

const DECISION_MAKER_TITLES = [
  "CTO", "Chief Technology Officer", "Co-Founder", "Founder", "CEO", "Chief Executive Officer",
  "VP Engineering", "VP of Engineering", "Head of Engineering", "Engineering Manager",
];

interface ApolloSearchPerson {
  id: string;
  first_name?: string;
  title?: string | null;
  has_email?: boolean;
}

interface ApolloMatchPerson {
  id: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string | null;
  email?: string | null;
  email_status?: string | null;
}

/** Lower is better: technical decision-makers first, since they feel the need for engineers most directly. */
function titleRank(title: string): number {
  const t = title.toLowerCase();
  if (/\bcto\b|chief technology/.test(t)) return 0;
  if (/(co-?)?founder/.test(t) && /engineer|tech|product/.test(t)) return 1;
  if (/vp.*engineering|head of engineering/.test(t)) return 2;
  if (/\bceo\b|chief executive|(co-?)?founder/.test(t)) return 3;
  if (/engineering manager/.test(t)) return 4;
  return 9;
}

function isCompanyEmail(email: string, domain: string): boolean {
  const host = email.toLowerCase().split("@")[1] || "";
  return host === domain || host.endsWith(`.${domain}`);
}

function toQuery(params: Record<string, string | number | boolean | string[]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => query.append(`${key}[]`, v));
    else query.append(key, String(value));
  }
  return query.toString();
}

export class ApolloClient {
  constructor(private readonly apiKey: string) {}

  private async post<T>(path: string, params: Record<string, string | number | boolean | string[]>): Promise<T> {
    const { data } = await axios.post<T>(`${API}${path}?${toQuery(params)}`, undefined, {
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json", "Cache-Control": "no-cache" },
      timeout: 30_000,
    });
    return data;
  }

  /**
   * Finds the best decision-maker at a company with 1-200 employees and reveals their work email.
   * Search is free; revealing the email costs one credit, and only verified emails are returned.
   * Returns null when the company is outside the size range, nobody suitable is listed, or no verified email exists.
   */
  async findDecisionMaker(domain: string, preferredNames: string[] = []): Promise<Contact | null> {
    const search = await this.post<{ people?: ApolloSearchPerson[] }>("/mixed_people/api_search", {
      q_organization_domains_list: [domain],
      person_titles: DECISION_MAKER_TITLES,
      include_similar_titles: true,
      organization_num_employees_ranges: EMPLOYEE_RANGES,
      per_page: 25,
      page: 1,
    });

    // Founders named by the source (e.g. YC) win ties within the same title rank
    const preferred = new Set(preferredNames.map((n) => n.split(" ")[0]!.toLowerCase()));
    const isPreferred = (p: ApolloSearchPerson) => preferred.has((p.first_name || "").toLowerCase());
    const people = (search.people || [])
      .filter((p) => p.has_email && p.title && titleRank(p.title) < 9)
      .sort((a, b) => titleRank(a.title!) - titleRank(b.title!) || Number(isPreferred(b)) - Number(isPreferred(a)));

    // Reveal at most two people, so a stale record doesn't burn many credits
    for (const person of people.slice(0, 2)) {
      const match = await this.post<{ person?: ApolloMatchPerson }>("/people/match", {
        id: person.id,
        reveal_personal_emails: false,
      });
      const p = match.person;
      if (p?.email && p.email_status === "verified" && isCompanyEmail(p.email, domain)) {
        return {
          name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" "),
          title: p.title || person.title || "",
          email: p.email.toLowerCase(),
          source: "apollo",
        };
      }
    }
    return null;
  }
}
