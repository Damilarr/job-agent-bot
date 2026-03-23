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

/**
 * High-level helper to resolve a user + profile for a Telegram chat.
 * For now, if no profile exists, we seed it from the existing single-user CV (myCV),
 * so current behavior stays the same while allowing per-user overrides later.
 */

export async function getOrCreateUserAndProfileForTelegram(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<{ user: DBUser; profile: DBUserProfile }> {
  const user = getOrCreateUserByTelegramChat(telegramChatId, name, username);

  let profile = getUserProfile(user.id);
  if (!profile) {
    const cvText = formatCVForPrompt(myCV);
    const seededProfile: DBUserProfile = {
      user_id: user.id,
      cv_text: cvText,
      portfolio_url: myCV.portfolio || null,
      phone: null,
      github_url: null,
      linkedin_url: null,
      location: null,
      target_roles: null,
    };

    upsertUserProfile(seededProfile);
    profile = seededProfile;
  }

  return { user, profile };
}

/**
 * Convenience accessor that just returns the cv_text for a user,
 * ensuring it exists (again seeding from myCV if needed).
 */
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

/**
 * Updates the stored profile text (and optionally portfolio URL) for a Telegram user
 * based on raw text they send (e.g. pasted CV, bio, links).
 */
export async function updateProfileFromTextForTelegram(
  telegramChatId: number,
  text: string,
  name?: string,
  username?: string
): Promise<DBUserProfile> {
  const { user, profile } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  // Naive URL extraction: first http(s) URL in the text is treated as portfolio link
  const urlMatch = text.match(/https?:\/\/\S+/);
  const portfolioUrl = urlMatch?.[0] ?? profile.portfolio_url ?? null;

  const updated: DBUserProfile = {
    ...profile,
    cv_text: text,
    portfolio_url: portfolioUrl,
  };

  upsertUserProfile(updated);
  upsertUserProfileLinksFromCoreFields(updated);
  return updated;
}

export async function saveResumeForTelegramUser(
  telegramChatId: number,
  localPath: string,
  name?: string,
  username?: string
): Promise<DBUserAsset> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  addUserAsset(user.id, 'resume', localPath);
  const latest = getLatestUserAsset(user.id, 'resume');
  if (!latest) {
    throw new Error('Failed to persist resume asset for user');
  }
  return latest;
}

/**
 * Parses a display/legal name from profile CV text.
 * Expects a line like `Name: Jane Doe` (common in /set_profile and seeded CV format).
 */
export function extractDisplayNameFromCvText(cvText: string): string | null {
  const m = cvText.match(/^\s*Name:\s*(.+)$/im);
  const raw = m?.[1]?.trim();
  return raw || null;
}

/**
 * Prefer the name from your stored profile/CV; fall back to Telegram first/last only if no Name: line exists.
 * Does not use Telegram @username as your legal name.
 */
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

  const asset = getLatestUserAsset(user.id, 'resume');
  return asset ? asset.path : null;
}

export async function setCoreLinkForTelegramUser(
  telegramChatId: number,
  kind: 'github' | 'linkedin' | 'portfolio',
  url: string,
  name?: string,
  username?: string
): Promise<DBUserProfile> {
  const { user, profile } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  const updated: DBUserProfile = {
    ...profile,
    github_url: kind === 'github' ? url : profile.github_url,
    linkedin_url: kind === 'linkedin' ? url : profile.linkedin_url,
    portfolio_url: kind === 'portfolio' ? url : profile.portfolio_url,
  };

  upsertUserProfile(updated);
  upsertUserProfileLinksFromCoreFields(updated);
  return updated;
}

export async function addCustomLinkForTelegramUser(
  telegramChatId: number,
  label: string,
  url: string,
  name?: string,
  username?: string
): Promise<DBUserLink> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  addCustomUserLink(user.id, label, url);

  const links = getUserLinks(user.id);
  return links[0]!;
}

export async function getLinksForTelegramUser(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<DBUserLink[]> {
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
): Promise<DBUserEmailAccount> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );

  upsertUserEmailAccount({
    user_id: user.id,
    provider,
    email_address: emailAddress,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_user: smtpUser,
    smtp_password: smtpPassword,
  });

  const account = getUserEmailAccount(user.id);
  if (!account) {
    throw new Error('Failed to save email account for user');
  }
  return account;
}

export async function getEmailAccountForTelegramUser(
  telegramChatId: number,
  name?: string,
  username?: string
): Promise<DBUserEmailAccount | null> {
  const { user } = await getOrCreateUserAndProfileForTelegram(
    telegramChatId,
    name,
    username
  );
  return getUserEmailAccount(user.id);
}


