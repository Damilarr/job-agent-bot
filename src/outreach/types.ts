export type LeadSource = "yc" | "hn" | "remotive" | "remoteok";

export interface CompanyCandidate {
  source: LeadSource;
  sourceUrl: string;
  name: string;
  /** Bare company domain, e.g. "mux.com" */
  domain: string;
  description: string;
  country?: string;
  teamSize?: number;
  /** Evidence about where and how the company hires, e.g. job locations or "Remote (Worldwide)" */
  hiringNotes: string;
  /** Founders listed publicly by the source, used to pick who to email */
  founders?: { name: string; title: string }[];
  /** An address the company published for applications, e.g. in an HN hiring post */
  publishedEmail?: string;
}

export interface Contact {
  name: string;
  title: string;
  email: string;
  source: "apollo" | "published";
}
