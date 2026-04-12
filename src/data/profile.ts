import { formatCVForPrompt, myCV } from './cv.js';
import type { DBUser, DBUserProfile, DBUserAsset, DBUserLink, DBUserEmailAccount } from './db.js';
import {
  getOrCreateUserByTelegramChat,
  getUserProfile,
  upsertUserProfile,
  addUserAsset,
  getLatestUserAsset,
  upsertUserProfileLinksFromCoreFields,
  addCustomUserLink,
  getUserLinks,
  upsertUserEmailAccount,
  getUserEmailAccount,
} from './db.js';

export async function getOrCreateUserAndProfileForTelegram(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<{ user: any; profile: any }> {
  const user = await getOrCreateUserByTelegramChat(telegramChatId, name, username);

  let profile = await getUserProfile(user.id);
  if (!profile) {
    const cvText = formatCVForPrompt(myCV);
    const seededProfile = {
      user_id: user.id,
      cv_text: cvText,
      portfolio_url: myCV.portfolio || null,
      phone: null,
      github_url: null,
      linkedin_url: null,
      location: null,
      target_roles: null,
    };

    await upsertUserProfile(seededProfile);
    profile = seededProfile;
  }

  return { user, profile };
}

export async function getProfileTextForUserByTelegramChat(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<string> {
  const { profile } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );
  return profile.cv_text;
}

export async function updateProfileFromTextForTelegram(
  telegramChatId: number,
  text: string,
  name?: string,
  username?: string
): Promise<any> {
  const { user, profile } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  const urlMatch = text.match(/https?:\/\/\S+/);
  const portfolioUrl = urlMatch?.[0] ?? profile.portfolio_url ?? null;

  const updated = {
    ...profile,
    cv_text: text,
    portfolio_url: portfolioUrl,
  };

  await upsertUserProfile(updated);
  await upsertUserProfileLinksFromCoreFields(updated);
  return updated;
}

export async function saveResumeForTelegramUser(
  telegramChatId: number,
  localPath: string,
  name?: string,
  username?: string
): Promise<any> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  await addUserAsset(user.id, 'resume', localPath);
  const latest = await getLatestUserAsset(user.id, 'resume');
  if (!latest) {
    throw new Error('Failed to persist resume asset for user');
  }
  return latest;
}

export function extractDisplayNameFromCvText(cvText: string): string | null {
  const m = cvText.match(/^\s*Name:\s*(.+)$/im);
  const raw = m?.[1]?.trim();
  return raw || null;
}

export async function resolveApplicantDisplayNameForForms(
  telegramChatId: number,
  opts?: {
    telegramFirstName?: string;
    telegramLastName?: string;
    name?: string;
    username?: string;
  }
): Promise<string | undefined> {
  const { user, profile } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    opts?.name,
    opts?.username
  );
  const fromCv = extractDisplayNameFromCvText(profile.cv_text);
  if (fromCv) return fromCv;

  const tg = [opts?.telegramFirstName, opts?.telegramLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (tg) return tg;

  if (user.name?.trim()) return user.name.trim();

  return undefined;
}

export async function getLatestResumePathForTelegramUser(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<string | null> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  const asset = await getLatestUserAsset(user.id, 'resume');
  return asset ? asset.path : null;
}

export async function setCoreLinkForTelegramUser(
  telegramChatId: number,
  kind: 'github' | 'linkedin' | 'portfolio',
  url: string,
  name?: string,
  username?: string
): Promise<any> {
  const { user, profile } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  const updated = {
    ...profile,
    github_url: kind === 'github' ? url : profile.github_url,
    linkedin_url: kind === 'linkedin' ? url : profile.linkedin_url,
    portfolio_url: kind === 'portfolio' ? url : profile.portfolio_url,
  };

  await upsertUserProfile(updated);
  await upsertUserProfileLinksFromCoreFields(updated);
  return updated;
}

export async function addCustomLinkForTelegramUser(
  telegramChatId: number,
  label: string,
  url: string,
  name?: string,
  username?: string
): Promise<any> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  await addCustomUserLink(user.id, label, url);

  const links = await getUserLinks(user.id);
  return links[0]!;
}

export async function getLinksForTelegramUser(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<any[]> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );
  return getUserLinks(user.id);
}

export async function upsertEmailAccountForTelegramUser(
  telegramChatId: number,
  provider: string,
  emailAddress: string,
  smtpHost: string,
  smtpPort: number,
  smtpUser: string,
  smtpPassword: string,
  name?: string,
  username?: string
): Promise<any> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  await upsertUserEmailAccount({
    user_id: user.id,
    provider,
    email_address: emailAddress,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_user: smtpUser,
    smtp_password: smtpPassword,
  });

  const account = await getUserEmailAccount(user.id);
  if (!account) {
    throw new Error('Failed to save email account for user');
  }
  return account;
}

export async function getEmailAccountForTelegramUser(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<any | null> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );
  return getUserEmailAccount(user.id);
}
