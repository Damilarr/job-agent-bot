import type { Job } from '../types/job.js';

/**
 * X/Twitter job sourcing.
 *
 * NOTE: X no longer has any reliable free scraping method.
 * - Nitter (open-source Twitter frontend) shut down after X revoked API access.
 * - Direct scraping is blocked by X's aggressive anti-bot measures.
 * - The official X API v2 requires a paid plan ($100+/month).
 *
 * This module is kept as a placeholder. If you obtain X API credentials
 * in the future, this can be re-implemented using the official API.
 *
 * For now, the bot relies on HN "Who is Hiring" as its primary
 * auto-apply source, which provides significantly better results
 * (high email presence, detailed job descriptions).
 */
export async function fetchJobsFromX(_query: string): Promise<Job[]> {
  console.log(`      📭 X sourcing: Skipped (no reliable free access to X/Twitter).`);
  return [];
}
