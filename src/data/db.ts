import { PrismaClient } from '@prisma/client';
import type { users, user_profiles, user_assets, user_links, user_email_accounts } from '@prisma/client';
import crypto from 'crypto';

export type DBUser = users;
export type DBUserProfile = user_profiles;
export type DBUserAsset = user_assets;
export type DBUserLink = user_links;
export type DBUserEmailAccount = user_email_accounts;

import { PrismaNeonHttp } from '@prisma/adapter-neon';

// PrismaNeonHttp uses HTTPS REST calls instead of WebSocket —
// avoids WSS connection issues on restricted VM networks
const adapter = new PrismaNeonHttp(process.env.DATABASE_URL!, {
  arrayMode: false,
  fullResults: false
});

export const prisma = new PrismaClient({ adapter });

export interface DBJobRecord {
  id: string; 
  title: string;
  company: string;
  url: string;
  status: 'APPLIED' | 'SKIPPED' | 'FAILED';
  matchScore: number | null;
}

export type ApplicationStatus = 'sent' | 'replied' | 'interview' | 'offer' | 'rejected' | 'ghosted';

function deriveEncryptionKey(): Buffer | null {
  const raw = process.env.EMAIL_ENCRYPTION_KEY;
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptSecret(plaintext: string): string {
  const key = deriveEncryptionKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith('enc:v1:')) return stored;
  const key = deriveEncryptionKey();
  if (!key) {
    throw new Error('EMAIL_ENCRYPTION_KEY is required to decrypt stored email credentials');
  }
  const data = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

export async function hasJobBeenProcessed(jobId: string): Promise<boolean> {
  const job = await prisma.processed_jobs.findUnique({
    where: { id: jobId },
    select: { id: true }
  });
  return !!job;
}

export async function logProcessedJob(record: DBJobRecord): Promise<void> {
  await prisma.processed_jobs.upsert({
    where: { id: record.id },
    create: record,
    update: record
  });
}

export async function getTodaysProcessedJobs(): Promise<any[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return prisma.processed_jobs.findMany({
    where: { processedAt: { gte: today } }
  });
}

export async function getOrCreateUserByTelegramChat(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<any> {
  const existing = await prisma.users.findUnique({
    where: { telegram_chat_id: telegramChatId }
  });
  
  if (existing) return existing;
  
  return prisma.users.create({
    data: {
      telegram_chat_id: telegramChatId,
      name: name || null,
      username: username || null
    }
  });
}

export async function getUserProfile(userId: number): Promise<any | null> {
  return prisma.user_profiles.findUnique({ where: { user_id: userId } });
}

export async function upsertUserProfile(profile: any): Promise<void> {
  const data = {
    cv_text: profile.cv_text,
    portfolio_url: profile.portfolio_url,
    phone: profile.phone,
    github_url: profile.github_url,
    linkedin_url: profile.linkedin_url,
    location: profile.location,
    target_roles: profile.target_roles,
    updated_at: new Date()
  };

  await prisma.user_profiles.upsert({
    where: { user_id: profile.user_id },
    create: { user_id: profile.user_id, ...data },
    update: data
  });
}

export async function addUserAsset(userId: number, type: string, filePath: string): Promise<void> {
  await prisma.user_assets.create({
    data: {
      user_id: userId,
      type,
      path: filePath
    }
  });
}

export async function getLatestUserAsset(userId: number, type: string): Promise<any | null> {
  return prisma.user_assets.findFirst({
    where: { user_id: userId, type },
    orderBy: { created_at: 'desc' }
  });
}

export async function upsertUserProfileLinksFromCoreFields(profile: any): Promise<void> {
  await prisma.user_links.deleteMany({
    where: {
      user_id: profile.user_id,
      label: { in: ['github', 'linkedin', 'portfolio'] }
    }
  });

  const linksToCreate = [];
  if (profile.github_url) linksToCreate.push({ user_id: profile.user_id, label: 'github', url: profile.github_url });
  if (profile.linkedin_url) linksToCreate.push({ user_id: profile.user_id, label: 'linkedin', url: profile.linkedin_url });
  if (profile.portfolio_url) linksToCreate.push({ user_id: profile.user_id, label: 'portfolio', url: profile.portfolio_url });

  if (linksToCreate.length > 0) {
    await prisma.user_links.createMany({ data: linksToCreate });
  }
}

export async function addCustomUserLink(userId: number, label: string, url: string): Promise<void> {
  await prisma.user_links.create({
    data: { user_id: userId, label, url }
  });
}

export async function getUserLinks(userId: number): Promise<any[]> {
  return prisma.user_links.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' }
  });
}

export async function upsertUserEmailAccount(account: any): Promise<void> {
  const encPass = encryptSecret(account.smtp_password);
  
  const data = {
    provider: account.provider,
    email_address: account.email_address,
    smtp_host: account.smtp_host,
    smtp_port: account.smtp_port,
    smtp_user: account.smtp_user,
    smtp_password: encPass,
    updated_at: new Date()
  };

  await prisma.user_email_accounts.upsert({
    where: { user_id: account.user_id },
    create: { user_id: account.user_id, ...data },
    update: data
  });
}

export async function getUserEmailAccount(userId: number): Promise<any | null> {
  const row = await prisma.user_email_accounts.findUnique({ where: { user_id: userId } });
  if (!row) return null;
  return { ...row, smtp_password: decryptSecret(row.smtp_password) };
}

export async function logUserEvent(userId: number, type: string, detail?: string): Promise<void> {
  await prisma.user_events.create({
    data: { user_id: userId, type, detail: detail || null }
  });
}

export async function getRecentUserEvents(userId: number, limit: number = 10): Promise<any[]> {
  return prisma.user_events.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    take: limit
  });
}

export async function addUserApplication(app: {
  userId: number;
  company: string;
  role: string;
  method: string;
  destination?: string;
  matchScore?: number;
  coverLetterPath?: string;
}): Promise<any> {
  return prisma.user_applications.create({
    data: {
      user_id: app.userId,
      company: app.company,
      role: app.role,
      method: app.method,
      destination: app.destination || null,
      match_score: app.matchScore ?? null,
      cover_letter_path: app.coverLetterPath || null
    }
  });
}

export async function getUserApplications(userId: number, limit: number = 20): Promise<any[]> {
  return prisma.user_applications.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    take: limit
  });
}

export async function updateApplicationStatus(applicationId: number, userId: number, status: ApplicationStatus): Promise<boolean> {
  try {
    await prisma.user_applications.updateMany({
      where: { id: applicationId, user_id: userId },
      data: { status, updated_at: new Date() }
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function getUserApplicationById(applicationId: number, userId: number): Promise<any | null> {
  const rows = await prisma.user_applications.findMany({
    where: { id: applicationId, user_id: userId }
  });
  return rows[0] || null;
}

export async function saveAdminChatId(chatId: number): Promise<void> {
  await prisma.settings.upsert({
    where: { key: 'ADMIN_CHAT_ID' },
    create: { key: 'ADMIN_CHAT_ID', value: chatId.toString() },
    update: { value: chatId.toString() }
  });
}

export async function getAdminChatId(): Promise<string | null> {
  const row = await prisma.settings.findUnique({ where: { key: 'ADMIN_CHAT_ID' } });
  return row ? row.value : null;
}

export async function getFormFieldsCache(formId: string): Promise<any | null> {
  const cache = await prisma.form_scraping_cache.findUnique({
    where: { form_id: formId }
  });
  return cache ? (cache.fields as any) : null;
}

export async function saveFormFieldsCache(formId: string, fields: any): Promise<void> {
  await prisma.form_scraping_cache.upsert({
    where: { form_id: formId },
    create: { form_id: formId, fields },
    update: { fields }
  });
}

export async function getUserFormPlanCache(userId: number, formId: string): Promise<any | null> {
  const cache = await prisma.user_form_answers_cache.findUnique({
    where: { user_id_form_id: { user_id: userId, form_id: formId } }
  });
  return cache ? (cache.plan as any) : null;
}

export async function saveUserFormPlanCache(userId: number, formId: string, plan: any): Promise<void> {
  await prisma.user_form_answers_cache.upsert({
    where: { user_id_form_id: { user_id: userId, form_id: formId } },
    create: { user_id: userId, form_id: formId, plan },
    update: { plan, updated_at: new Date() }
  });
}
