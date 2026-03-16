import Database from 'better-sqlite3';
import path from 'path';

// Define the database file location in the root of the project, or mounted volume
const dataDir = process.env.DATABASE_DIR || process.cwd();
const dbPath = path.resolve(dataDir, 'jobs.sqlite');

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL, -- 'APPLIED', 'SKIPPED', 'FAILED'
    matchScore INTEGER,
    processedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Multi-tenant core tables
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id INTEGER UNIQUE, -- nullable for non-Telegram users later
    name TEXT,
    username TEXT,
    email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id INTEGER PRIMARY KEY,
    cv_text TEXT NOT NULL, -- formatted CV/profile text for LLM prompts
    portfolio_url TEXT,
    phone TEXT,
    github_url TEXT,
    linkedin_url TEXT,
    location TEXT,
    target_roles TEXT, -- comma-separated list for now
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- e.g. 'resume'
    path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_email_accounts (
    user_id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    email_address TEXT NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_user TEXT NOT NULL,
    smtp_password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

export interface DBJobRecord {
  id: string; 
  title: string;
  company: string;
  url: string;
  status: 'APPLIED' | 'SKIPPED' | 'FAILED';
  matchScore: number | null;
}

export interface DBUser {
  id: number;
  telegram_chat_id: number | null;
  name: string | null;
  username: string | null;
  email: string | null;
}

export interface DBUserProfile {
  user_id: number;
  cv_text: string;
  portfolio_url: string | null;
  phone: string | null;
  github_url: string | null;
  linkedin_url: string | null;
  location: string | null;
  target_roles: string | null;
}

export interface DBUserAsset {
  id: number;
  user_id: number;
  type: string;
  path: string;
  created_at: string;
}

export interface DBUserLink {
  id: number;
  user_id: number;
  label: string;
  url: string;
  created_at: string;
}

export interface DBUserEmailAccount {
  user_id: number;
  provider: string;
  email_address: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  created_at: string;
  updated_at: string;
}

/**
 * Checks if a specific job ID has already been processed today (or ever).
 * To avoid re-applying, we check the global history.
 */
export function hasJobBeenProcessed(jobId: string): boolean {
  const stmt = db.prepare('SELECT id FROM processed_jobs WHERE id = ?');
  const row = stmt.get(jobId);
  return !!row;
}

/**
 * Logs a processed job into the database.
 */
export function logProcessedJob(record: DBJobRecord) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO processed_jobs (id, title, company, url, status, matchScore)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(record.id, record.title, record.company, record.url, record.status, record.matchScore);
}

/**
 * Retrieves all jobs processed today (local midnight to current time) for reporting.
 */
export function getTodaysProcessedJobs(): any[] {
  const stmt = db.prepare(`
    SELECT * FROM processed_jobs 
    WHERE date(processedAt, 'localtime') = date('now', 'localtime')
  `);
  return stmt.all();
}

/**
 * Resolves or creates a user row for a given Telegram chat.
 * This is the core primitive for multi-tenant behavior from the bot side.
 */
export function getOrCreateUserByTelegramChat(
  telegramChatId: number,
  name?: string,
  username?: string
): DBUser {
  const selectStmt = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?');
  const existing = selectStmt.get(telegramChatId) as DBUser | undefined;
  if (existing) {
    return existing;
  }

  const insertStmt = db.prepare(
    `INSERT INTO users (telegram_chat_id, name, username) VALUES (?, ?, ?)`
  );
  const result = insertStmt.run(telegramChatId, name || null, username || null);

  const createdId = Number(result.lastInsertRowid);
  const createdUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
  const created = createdUserStmt.get(createdId) as DBUser | undefined;
  if (!created) {
    throw new Error('Failed to create user record');
  }
  return created;
}

/**
 * Fetches a user profile if it exists.
 */
export function getUserProfile(userId: number): DBUserProfile | null {
  const stmt = db.prepare('SELECT * FROM user_profiles WHERE user_id = ?');
  const row = stmt.get(userId) as DBUserProfile | undefined;
  return row || null;
}

/**
 * Creates or updates a user profile row.
 * For now this is a simple upsert keyed by user_id.
 */
export function upsertUserProfile(profile: DBUserProfile): void {
  const stmt = db.prepare(
    `
      INSERT INTO user_profiles (user_id, cv_text, portfolio_url, phone, github_url, linkedin_url, location, target_roles, updated_at)
      VALUES (@user_id, @cv_text, @portfolio_url, @phone, @github_url, @linkedin_url, @location, @target_roles, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        cv_text = excluded.cv_text,
        portfolio_url = excluded.portfolio_url,
        phone = excluded.phone,
        github_url = excluded.github_url,
        linkedin_url = excluded.linkedin_url,
        location = excluded.location,
        target_roles = excluded.target_roles,
        updated_at = CURRENT_TIMESTAMP
    `
  );

  stmt.run(profile);
}

export function addUserAsset(userId: number, type: string, filePath: string): void {
  const stmt = db.prepare(
    `INSERT INTO user_assets (user_id, type, path) VALUES (?, ?, ?)`
  );
  stmt.run(userId, type, filePath);
}

export function getLatestUserAsset(userId: number, type: string): DBUserAsset | null {
  const stmt = db.prepare(`
      SELECT * FROM user_assets
      WHERE user_id = ? AND type = ?
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `);
  const row = stmt.get(userId, type) as DBUserAsset | undefined;
  return row || null;
}

export function upsertUserProfileLinksFromCoreFields(profile: DBUserProfile): void {
  // keep a simple mirror of core URLs in user_links for easier querying later if needed
  const stmtDelete = db.prepare('DELETE FROM user_links WHERE user_id = ? AND label IN (?, ?, ?)');
  stmtDelete.run(profile.user_id, 'github', 'linkedin', 'portfolio');

  const insert = db.prepare(
    'INSERT INTO user_links (user_id, label, url) VALUES (?, ?, ?)'
  );

  if (profile.github_url) insert.run(profile.user_id, 'github', profile.github_url);
  if (profile.linkedin_url) insert.run(profile.user_id, 'linkedin', profile.linkedin_url);
  if (profile.portfolio_url) insert.run(profile.user_id, 'portfolio', profile.portfolio_url);
}

export function addCustomUserLink(userId: number, label: string, url: string): void {
  const stmt = db.prepare(
    'INSERT INTO user_links (user_id, label, url) VALUES (?, ?, ?)'
  );
  stmt.run(userId, label, url);
}

export function getUserLinks(userId: number): DBUserLink[] {
  const stmt = db.prepare('SELECT * FROM user_links WHERE user_id = ? ORDER BY datetime(created_at) DESC');
  return stmt.all(userId) as DBUserLink[];
}

export function upsertUserEmailAccount(account: Omit<DBUserEmailAccount, 'created_at' | 'updated_at'>): void {
  const stmt = db.prepare(`
    INSERT INTO user_email_accounts (user_id, provider, email_address, smtp_host, smtp_port, smtp_user, smtp_password, created_at, updated_at)
    VALUES (@user_id, @provider, @email_address, @smtp_host, @smtp_port, @smtp_user, @smtp_password, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      provider = excluded.provider,
      email_address = excluded.email_address,
      smtp_host = excluded.smtp_host,
      smtp_port = excluded.smtp_port,
      smtp_user = excluded.smtp_user,
      smtp_password = excluded.smtp_password,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(account);
}

export function getUserEmailAccount(userId: number): DBUserEmailAccount | null {
  const stmt = db.prepare('SELECT * FROM user_email_accounts WHERE user_id = ?');
  const row = stmt.get(userId) as DBUserEmailAccount | undefined;
  return row || null;
}

/**
 * Saves the Admin Chat ID to the database so background jobs know who to message.
 */
export function saveAdminChatId(chatId: number) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO settings (key, value)
    VALUES ('ADMIN_CHAT_ID', ?)
  `);
  stmt.run(chatId.toString());
}

/**
 * Retrieves the Admin Chat ID. Returns null if not set.
 */
export function getAdminChatId(): string | null {
  const stmt = db.prepare(`SELECT value FROM settings WHERE key = 'ADMIN_CHAT_ID'`);
  const row = stmt.get() as { value: string } | undefined;
  return row ? row.value : null;
}
