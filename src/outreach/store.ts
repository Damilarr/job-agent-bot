import type { outreach_leads, outreach_settings } from "@prisma/client";
import { prisma } from "../data/db.js";
import type { CompanyCandidate } from "./types.js";

export type OutreachLead = outreach_leads;
export type OutreachSettings = outreach_settings;
export type LeadStatus = "new" | "rejected" | "no_contact" | "sent";

export async function getOutreachSettings(userId: number): Promise<OutreachSettings | null> {
  return prisma.outreach_settings.findUnique({ where: { user_id: userId } });
}

export async function updateOutreachSettings(
  userId: number,
  changes: Partial<Pick<OutreachSettings, "enabled" | "daily_cap" | "candidate_location" | "target_roles">>,
): Promise<OutreachSettings> {
  const existing = await getOutreachSettings(userId);
  if (existing) {
    return prisma.outreach_settings.update({
      where: { user_id: userId },
      data: { ...changes, updated_at: new Date() },
    });
  }
  return prisma.outreach_settings.create({ data: { user_id: userId, ...changes } });
}

export async function getEnabledOutreachSettings(): Promise<OutreachSettings[]> {
  return prisma.outreach_settings.findMany({ where: { enabled: true } });
}

export async function getContactedDomains(userId: number): Promise<Set<string>> {
  const rows = await prisma.outreach_leads.findMany({ where: { user_id: userId }, select: { domain: true } });
  return new Set(rows.map((r) => r.domain));
}

export async function countSentSince(userId: number, since: Date): Promise<number> {
  return prisma.outreach_leads.count({ where: { user_id: userId, status: "sent", sent_at: { gte: since } } });
}

/**
 * Claims a company domain for this user before any work is done on it.
 * Returns null if another run already claimed it, which the unique (user_id, domain) index guarantees.
 */
export async function claimLead(userId: number, company: CompanyCandidate): Promise<OutreachLead | null> {
  try {
    return await prisma.outreach_leads.create({
      data: {
        user_id: userId,
        source: company.source,
        source_url: company.sourceUrl,
        company_name: company.name,
        domain: company.domain,
        description: company.description.slice(0, 4000),
        company_country: company.country ?? null,
        team_size: company.teamSize ?? null,
        hiring_notes: company.hiringNotes.slice(0, 4000),
      },
    });
  } catch (error: any) {
    if (error?.code === "P2002") return null;
    throw error;
  }
}

export async function updateLead(
  leadId: number,
  changes: Partial<Omit<OutreachLead, "id" | "user_id" | "created_at">>,
): Promise<OutreachLead> {
  return prisma.outreach_leads.update({ where: { id: leadId }, data: { ...changes, updated_at: new Date() } });
}

/** Releases a claim when the failure was on our side (e.g. Apollo down), so the company can be tried again later. */
export async function releaseLead(leadId: number): Promise<void> {
  await prisma.outreach_leads.delete({ where: { id: leadId } });
}

export async function getLead(leadId: number, userId: number): Promise<OutreachLead | null> {
  return prisma.outreach_leads.findFirst({ where: { id: leadId, user_id: userId } });
}

/** Sent at least `afterDays` ago, never followed up or reminded, and the tracked application is still "sent". */
export async function getLeadsDueForFollowUp(userId: number, afterDays: number): Promise<OutreachLead[]> {
  const cutoff = new Date(Date.now() - afterDays * 24 * 60 * 60 * 1000);
  const leads = await prisma.outreach_leads.findMany({
    where: {
      user_id: userId,
      status: "sent",
      sent_at: { lte: cutoff },
      followup_sent_at: null,
      followup_reminded_at: null,
    },
    orderBy: { sent_at: "asc" },
  });

  const due: OutreachLead[] = [];
  for (const lead of leads) {
    if (!lead.application_id) continue;
    const app = await prisma.user_applications.findUnique({ where: { id: lead.application_id }, select: { status: true } });
    if (app?.status === "sent") due.push(lead);
  }
  return due;
}

export async function getOutreachStats(userId: number): Promise<Record<string, number>> {
  const rows = await prisma.outreach_leads.findMany({ where: { user_id: userId }, select: { status: true } });
  return rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
}
