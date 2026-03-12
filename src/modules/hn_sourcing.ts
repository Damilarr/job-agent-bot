import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Job } from '../types/job.js';

const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

/**
 * Fetches jobs from the latest HN "Who is Hiring" monthly thread.
 * Uses the free Algolia HN Search API — no auth, no browser required.
 * Filters comments by the given search query keywords.
 */
export async function fetchJobsFromHN(query: string): Promise<Job[]> {
  const jobs: Job[] = [];

  try {
    // Step 1: Find the latest "Who is Hiring" thread
    console.log(`      🔗 Searching for latest HN "Who is Hiring" thread...`);
    const searchRes = await axios.get(`${ALGOLIA_BASE}/search_by_date`, {
      params: {
        query: '"Ask HN: Who is hiring"',
        tags: 'ask_hn',
        hitsPerPage: 1,
      },
      timeout: 15000,
    });

    const hits = searchRes.data?.hits;
    if (!hits || hits.length === 0) {
      console.warn('      ⚠️ Could not find HN "Who is Hiring" thread.');
      return [];
    }

    const threadId = hits[0].objectID;
    const threadTitle = hits[0].title;
    console.log(`      📋 Found thread: "${threadTitle}" (ID: ${threadId})`);

    // Step 2: Fetch all comments from the thread
    const threadRes = await axios.get(`${ALGOLIA_BASE}/items/${threadId}`, {
      timeout: 30000,
    });

    const children = threadRes.data?.children;
    if (!children || children.length === 0) {
      console.warn('      ⚠️ Thread has no comments.');
      return [];
    }

    console.log(`      📬 Thread has ${children.length} job posts. Filtering by "${query}"...`);

    // Step 3: Build search keywords from the query for flexible matching
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    // Step 4: Filter and parse matching comments
    for (const comment of children) {
      if (!comment.text || comment.text.length < 50) continue; // Skip empty/short comments

      // Strip HTML tags for text matching
      const plainText = stripHtml(comment.text);
      const lowerText = plainText.toLowerCase();

      // Check if any query keywords match
      const matchCount = queryWords.filter(w => lowerText.includes(w)).length;
      if (matchCount === 0) continue; // No keyword match at all

      // Extract email addresses
      const emails = plainText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      const validEmails = emails.filter(e => {
        const lower = e.toLowerCase();
        if (lower.includes('example.com')) return false;
        if (lower.match(/\.(png|jpg|jpeg|gif|webp)$/i)) return false;
        if (lower.length > 50) return false;
        return true;
      });

      // Extract company name (usually the first line before any pipe or vertical bar)
      const firstLine = plainText.split('\n')[0] || '';
      const company = firstLine.split('|')[0]?.trim() || comment.author || 'Unknown';

      // Build a readable title from the first line
      const title = firstLine.length > 80 ? firstLine.substring(0, 80) + '...' : firstLine;

      // Check for remote keyword
      const isRemote = /\bremote\b/i.test(plainText);
      const location = isRemote ? 'Remote' : extractLocation(firstLine);

      const jobUrl = `https://news.ycombinator.com/item?id=${comment.id}`;

      jobs.push({
        id: `hn-${comment.id}`,
        title,
        company,
        description: plainText,
        url: jobUrl,
        isDirect: validEmails.length > 0,
        email: validEmails[0] || null,
        location,
        source: 'HackerNews',
      });
    }

  } catch (error: any) {
    console.error('Error fetching HN jobs:', error.message);
  }

  console.log(`      ✅ HN sourcing complete. Found ${jobs.length} matching jobs for "${query}".`);
  return jobs;
}

/**
 * Strips HTML tags from a string and decodes HTML entities.
 */
function stripHtml(html: string): string {
  const $ = cheerio.load(html);
  // Replace <p> and <br> tags with newlines for structure
  $('p').each((_i, el) => {
    $(el).prepend('\n');
  });
  return $.text()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * Tries to extract a location from the first line of a HN job post.
 * HN posts typically follow: "Company | Role | Location | ..."
 */
function extractLocation(firstLine: string): string {
  const parts = firstLine.split('|').map(p => p.trim());
  // Location is usually the 2nd or 3rd segment after company and role
  for (const part of parts.slice(1)) {
    const lower = part.toLowerCase();
    // Heuristic: location segments often contain city/country names or keywords
    if (
      lower.includes('remote') ||
      lower.includes('onsite') ||
      lower.includes('hybrid') ||
      /\b(us|usa|uk|eu|canada|germany|london|nyc|sf|berlin)\b/i.test(part) ||
      /[A-Z][a-z]+,\s*[A-Z]{2}/.test(part) // "City, ST" pattern
    ) {
      return part;
    }
  }
  return '';
}
