import fs from "fs";
import { env } from "../config/env.js";
import { addUserApplication, getLatestUserAsset, getUserEmailAccount, getUserLinks, getUserProfile, logUserEvent, prisma } from "../data/db.js";
import { extractDisplayNameFromCvText } from "../data/profile.js";
import { sendApplicationEmailForUser } from "../integrations/email.js";
import type { DraftContext } from "../services/drafter.js";
import { buildCandidateBackground, extractFactList, extractPhone, extractResumeText } from "../services/resumeText.js";
import { ApolloClient } from "./apollo.js";
import { generateColdEmail, generateFollowUp } from "./coldEmail.js";
import { qualifyCompany } from "./qualify.js";
import { fetchHnCandidates } from "./sources/hn.js";
import { fetchRemoteOkCandidates, fetchRemotiveCandidates } from "./sources/remoteBoards.js";
import { fetchYcCandidates, hydrateYcCandidate } from "./sources/yc.js";
import {
  claimLead,
  countSentSince,
  getContactedDomains,
  getLead,
  getOutreachSettings,
  releaseLead,
  updateLead,
  type OutreachLead,
} from "./store.js";
import type { CompanyCandidate, Contact } from "./types.js";

/** Upper bound on companies screened per run, to stay inside Groq's free-tier limits. */
const MAX_COMPANIES_PER_RUN = 40;
/** Pause between sends so a batch doesn't leave the mailbox in one burst. */
const SEND_GAP_MS = { min: 90_000, max: 240_000 };

export interface OutreachDraft {
  company: string;
  domain: string;
  source: string;
  contact: Contact;
  subject: string;
  body: string;
  reason: string;
}

export interface OutreachRunReport {
  sent: OutreachLead[];
  /** Emails written but not sent, from a dry run */
  drafts: OutreachDraft[];
  skipped: { company: string; reason: string }[];
  stoppedReason?: string;
}

export interface OutreachRunOptions {
  /** Screen and write emails but don't send or record anything */
  dryRun?: boolean;
  /** Ignore the enabled flag (for a manual run) */
  force?: boolean;
  onSent?: (lead: OutreachLead) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

class StopRun extends Error {}

/** Apollo rejected the key, plan or credits; the run continues with companies that published an email. */
class ApolloUnavailable extends Error {}

const runningUsers = new Set<number>();

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Round-robin across sources so one source doesn't dominate a day's batch. */
function interleave(lists: CompanyCandidate[][]): CompanyCandidate[] {
  const out: CompanyCandidate[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]!);
  }
  return out;
}

async function loadCandidates(skipped: OutreachRunReport["skipped"]): Promise<CompanyCandidate[]> {
  const sources: [string, () => Promise<CompanyCandidate[]>][] = [
    ["YC", () => fetchYcCandidates()],
    ["Hacker News", () => fetchHnCandidates()],
    ["Remotive", () => fetchRemotiveCandidates()],
    ["RemoteOK", () => fetchRemoteOkCandidates()],
  ];
  const lists = await Promise.all(
    sources.map(async ([name, load]) => {
      try {
        return await load();
      } catch (error: any) {
        console.error(`Outreach source ${name} failed:`, error);
        skipped.push({ company: `(source) ${name}`, reason: `Source unavailable: ${error?.message || error}` });
        return [];
      }
    }),
  );
  return interleave(lists);
}

export interface OutreachSender {
  userId: number;
  background: string;
  allowedClaims: string[];
  signature: DraftContext;
  resumePath: string;
  fromAddress: string;
}

/** Everything needed to write and send as this user, or a reason why outreach can't run. */
export async function loadSender(userId: number): Promise<OutreachSender | string> {
  const [profile, account, resume, links, user] = await Promise.all([
    getUserProfile(userId),
    getUserEmailAccount(userId),
    getLatestUserAsset(userId, "resume"),
    getUserLinks(userId),
    prisma.users.findUnique({ where: { id: userId } }),
  ]);
  if (!account) return "Connect an email account with /set_email first.";
  if (!resume || !fs.existsSync(resume.path)) return "Upload your resume with /set_resume first.";
  if (!profile?.cv_text) return "Set your profile with /set_profile first.";

  const resumeText = await extractResumeText(resume.path);
  const name = extractDisplayNameFromCvText(profile.cv_text) || user?.name || undefined;
  const phone = extractPhone(resumeText);
  const signature: DraftContext = {
    ...(name ? { applicantName: name } : {}),
    ...(phone ? { phone } : {}),
  };
  for (const [label, key] of [["portfolio", "portfolioUrl"], ["linkedin", "linkedinUrl"], ["github", "githubUrl"]] as const) {
    const url = links.find((l) => l.label === label)?.url;
    if (url) signature[key] = url;
  }

  return {
    userId,
    background: buildCandidateBackground(profile.cv_text, resumeText),
    allowedClaims: extractFactList(profile.cv_text, resumeText),
    signature,
    resumePath: resume.path,
    fromAddress: account.email_address,
  };
}

function resumeFilename(signature: DraftContext): string {
  const base = (signature.applicantName || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${base || "Applicant"}_Resume.pdf`;
}

async function findContact(company: CompanyCandidate, apollo: ApolloClient | null): Promise<Contact | null> {
  if (company.publishedEmail) {
    return { name: "", title: "Published hiring contact", email: company.publishedEmail, source: "published" };
  }
  if (!apollo) return null;
  try {
    return await apollo.findDecisionMaker(company.domain, (company.founders || []).map((f) => f.name));
  } catch (error: any) {
    const status = error?.response?.status;
    const detail = JSON.stringify(error?.response?.data ?? error?.message ?? error).slice(0, 300);
    // Auth, plan or credit problems affect every company, so stop using Apollo instead of burning through the list
    if (status === 401 || status === 403 || status === 422 || status === 429) {
      throw new ApolloUnavailable(`Apollo returned ${status}: ${detail}`);
    }
    throw error;
  }
}

/**
 * Finds, screens and emails up to the user's remaining daily cap of companies.
 * Every company is claimed in the database before work starts, so no company is ever contacted twice.
 */
export async function runOutreachForUser(userId: number, options: OutreachRunOptions = {}): Promise<OutreachRunReport> {
  const report: OutreachRunReport = { sent: [], drafts: [], skipped: [] };
  if (runningUsers.has(userId)) return { ...report, stoppedReason: "A run is already in progress." };
  runningUsers.add(userId);

  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  try {
    const settings = await getOutreachSettings(userId);
    if (!settings || (!settings.enabled && !options.force)) return { ...report, stoppedReason: "Outreach is turned off." };
    if (!settings.candidate_location || !settings.target_roles) {
      return { ...report, stoppedReason: "Set your location and target roles first (see /outreach)." };
    }

    const sender = await loadSender(userId);
    if (typeof sender === "string") return { ...report, stoppedReason: sender };

    const remaining = settings.daily_cap - (await countSentSince(userId, startOfUtcDay()));
    if (remaining <= 0) return { ...report, stoppedReason: `Daily cap of ${settings.daily_cap} already reached.` };

    let apollo = env.APOLLO_API_KEY ? new ApolloClient(env.APOLLO_API_KEY) : null;
    let apolloProblem: string | null = null;
    const contacted = await getContactedDomains(userId);
    const candidates = (await loadCandidates(report.skipped)).filter((c) => !contacted.has(c.domain));

    let screened = 0;
    for (const listed of candidates) {
      if (report.sent.length + report.drafts.length >= remaining || screened >= MAX_COMPANIES_PER_RUN) break;
      if (!listed.publishedEmail && !apollo) continue; // Nothing to contact them with; leave unclaimed for when Apollo is set up
      screened++;

      const lead = options.dryRun ? null : await claimLead(userId, listed);
      if (!options.dryRun && !lead) continue;

      try {
        const listedOrHydrated = listed.source === "yc" ? await hydrateYcCandidate(listed) : listed;
        const qualification = await qualifyCompany(listedOrHydrated, settings.target_roles, settings.candidate_location);
        const company = { ...listedOrHydrated, name: qualification.companyName };
        if (lead && company.name !== lead.company_name) await updateLead(lead.id, { company_name: company.name });
        if (!qualification.qualified) {
          report.skipped.push({ company: company.name, reason: qualification.reason });
          if (lead) await updateLead(lead.id, { status: "rejected", status_reason: qualification.reason, company_country: qualification.companyCountry });
          continue;
        }

        const contact = await findContact(company, apollo);
        if (!contact) {
          const reason = "No verified decision-maker email (or company outside 1-200 people)";
          report.skipped.push({ company: company.name, reason });
          if (lead) await updateLead(lead.id, { status: "no_contact", status_reason: reason, company_country: qualification.companyCountry });
          continue;
        }

        const email = await generateColdEmail({
          company,
          qualification,
          contact,
          background: sender.background,
          allowedClaims: sender.allowedClaims,
          targetRoles: settings.target_roles,
          candidateLocation: settings.candidate_location,
          signature: sender.signature,
        });

        const leadFields = {
          company_country: qualification.companyCountry,
          contact_name: contact.name || null,
          contact_title: contact.title || null,
          contact_email: contact.email,
          contact_email_source: contact.source,
          subject: email.subject,
          body: email.body,
          hiring_notes: company.hiringNotes.slice(0, 4000),
        };

        if (options.dryRun || !lead) {
          report.drafts.push({ company: company.name, domain: company.domain, source: company.source, contact, subject: email.subject, body: email.body, reason: qualification.reason });
          continue;
        }

        if (report.sent.length > 0) await sleep(SEND_GAP_MS.min + Math.random() * (SEND_GAP_MS.max - SEND_GAP_MS.min));

        const result = await sendApplicationEmailForUser(userId, {
          to: contact.email,
          ...(sender.signature.applicantName ? { fromName: sender.signature.applicantName } : {}),
          subject: email.subject,
          bodyText: email.body,
          attachments: [{ filename: resumeFilename(sender.signature), path: sender.resumePath }],
        });
        if (!result.success) {
          // Usually a mailbox problem (e.g. revoked app password) that affects every send, so stop and retry the company later
          throw new StopRun(`Email sending failed: ${result.error}`);
        }

        const application = await addUserApplication({
          userId,
          company: company.name,
          role: `Cold outreach: ${settings.target_roles.split("(")[0]!.trim()}`,
          method: "cold_email",
          destination: contact.email,
        });
        const sentLead = await updateLead(lead.id, {
          ...leadFields,
          status: "sent",
          status_reason: qualification.reason,
          message_id: result.id ?? null,
          application_id: application.id,
          sent_at: new Date(),
        });
        await logUserEvent(userId, "outreach_sent", `${company.name} <${contact.email}>`);
        report.sent.push(sentLead);
        if (options.onSent) await options.onSent(sentLead);
      } catch (error: any) {
        if (error instanceof ApolloUnavailable) {
          apollo = null;
          apolloProblem = error.message;
          report.skipped.push({ company: listed.name, reason: `Apollo unavailable, founder emails disabled for this run: ${error.message}` });
          if (lead) await releaseLead(lead.id).catch(() => {});
          continue;
        }
        if (error instanceof StopRun) {
          if (lead) await releaseLead(lead.id).catch(() => {});
          report.stoppedReason = error.message;
          break;
        }
        console.error(`Outreach failed for ${listed.name}:`, error);
        report.skipped.push({ company: listed.name, reason: `Error: ${error?.message || error}` });
        // Our own failures (network, model) shouldn't permanently rule a company out
        if (lead) await releaseLead(lead.id).catch(() => {});
      }
    }

    const written = report.sent.length + report.drafts.length;
    if (!report.stoppedReason && written < remaining) {
      report.stoppedReason = apolloProblem
        ? `Apollo stopped working during the run, so only companies that published a hiring email were contacted. ${apolloProblem}`
        : apollo
          ? `Screened ${screened} new companies; ${written} qualified with a verified contact.`
          : `Apollo isn't configured, so only companies that published a hiring email can be contacted (screened ${screened}).`;
    }
    return report;
  } finally {
    runningUsers.delete(userId);
  }
}

/** Sends a short follow-up in the original thread. */
export async function sendFollowUp(userId: number, leadId: number): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  const lead = await getLead(leadId, userId);
  if (!lead || lead.status !== "sent" || !lead.contact_email || !lead.body) return { ok: false, error: "Lead not found or not sent." };
  if (lead.followup_sent_at) return { ok: false, error: "A follow-up was already sent." };

  const sender = await loadSender(userId);
  if (typeof sender === "string") return { ok: false, error: sender };

  const body = await generateFollowUp({
    companyName: lead.company_name,
    contactName: lead.contact_name,
    contactEmail: lead.contact_email,
    originalBody: lead.body,
    signature: sender.signature,
  });

  const result = await sendApplicationEmailForUser(userId, {
    to: lead.contact_email,
    ...(sender.signature.applicantName ? { fromName: sender.signature.applicantName } : {}),
    subject: `Re: ${lead.subject}`,
    bodyText: body,
    ...(lead.message_id ? { inReplyTo: lead.message_id } : {}),
  });
  if (!result.success) return { ok: false, error: result.error || "Send failed" };

  await updateLead(lead.id, { followup_sent_at: new Date() });
  await logUserEvent(userId, "outreach_followup_sent", `${lead.company_name} <${lead.contact_email}>`);
  return { ok: true, body };
}
