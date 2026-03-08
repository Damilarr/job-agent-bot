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
`);

export interface DBJobRecord {
  id: string; 
  title: string;
  company: string;
  url: string;
  status: 'APPLIED' | 'SKIPPED' | 'FAILED';
  matchScore: number | null;
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
