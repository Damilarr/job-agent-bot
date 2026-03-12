import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Job } from '../types/job.js';

// Realistic user agents for rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const JOBS_PER_PAGE = 25;
const MAX_PAGES = 2; // Fetch up to 50 jobs per query
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 3000;

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

function randomDelay(): Promise<void> {
  const ms = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches job listings from LinkedIn's public guest API.
 * No login or browser required — uses direct HTTP requests to the guest endpoints.
 */
export async function fetchJobsFromLinkedIn(query: string): Promise<Job[]> {
  const jobs: Job[] = [];
  const headers = {
    'User-Agent': randomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  };

  try {
    // Step 1: Collect job IDs from the listing API (with pagination)
    const jobIds: string[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * JOBS_PER_PAGE;
      const listUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(query)}&f_TPR=r86400&start=${start}`;

      console.log(`      🔗 Fetching LinkedIn listing page ${page + 1}: ${listUrl}`);

      const response = await axios.get(listUrl, { headers, timeout: 15000 });

      if (response.status !== 200) {
        console.warn(`      ⚠️ LinkedIn listing API returned status ${response.status}. Stopping pagination.`);
        break;
      }

      const $ = cheerio.load(response.data);
      const pageJobIds: string[] = [];

      $('li').each((_i, el) => {
        const baseCardDiv = $(el).find('div.base-card');
        const entityUrn = baseCardDiv.attr('data-entity-urn');
        if (entityUrn) {
          const id = entityUrn.split(':').pop();
          if (id) pageJobIds.push(id);
        }
      });

      if (pageJobIds.length === 0) {
        console.log(`      📭 No more jobs found on page ${page + 1}. Stopping pagination.`);
        break;
      }

      jobIds.push(...pageJobIds);
      console.log(`      Found ${pageJobIds.length} job IDs on page ${page + 1} (total: ${jobIds.length})`);

      // Be polite between pagination requests
      if (page < MAX_PAGES - 1) await randomDelay();
    }

    console.log(`      📋 Total job IDs collected: ${jobIds.length}`);

    // Step 2: Fetch full details for each job via the detail API
    for (const jobId of jobIds) {
      try {
        await randomDelay();

        const detailUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
        const detailResponse = await axios.get(detailUrl, {
          headers: { ...headers, 'User-Agent': randomUserAgent() },
          timeout: 15000,
        });

        if (detailResponse.status !== 200) {
          console.warn(`      ⚠️ Detail API returned ${detailResponse.status} for job ${jobId}. Skipping.`);
          continue;
        }

        const $ = cheerio.load(detailResponse.data);

        const title = $('h2.top-card-layout__title').text().trim() || '';

        const company = $('a.topcard__org-name-link').text().trim()
          || $('span.topcard__flavor').first().text().trim()
          || '';

        const location = $('span.topcard__flavor--bullet').text().trim() || '';

        const descriptionHtml = $('div.description__text, div.show-more-less-html__markup').html() || '';
        const description = cheerio.load(descriptionHtml).text().trim() || '';

        // Extract external apply URL from hidden <code id="applyUrl"> element
        // LinkedIn embeds the actual apply link (Greenhouse, Lever, company site)
        // inside an HTML comment within this element.
        let applyUrl = '';
        const applyCodeEl = $('code#applyUrl');
        if (applyCodeEl.length > 0) {
          const rawHtml = applyCodeEl.html() || '';
          // The URL is inside an HTML comment like: <!--"https://...externalApply/...?url=ENCODED_URL&..."-->
          const commentMatch = rawHtml.match(/<!--"(https:\/\/[^"]+)"-->/);
          if (commentMatch && commentMatch[1]) {
            // Extract the actual external URL from the ?url= parameter
            try {
              const externalApplyUrl = new URL(commentMatch[1]);
              const realUrl = externalApplyUrl.searchParams.get('url');
              if (realUrl) {
                applyUrl = decodeURIComponent(realUrl);
              }
            } catch {
              // If URL parsing fails, skip
            }
          }
        }

        // Use external apply URL if available, otherwise LinkedIn view URL
        const url = applyUrl || `https://www.linkedin.com/jobs/view/${jobId}`;
        const hasExternalApply = !!applyUrl;

        if (!title) {
          continue; 
        }

        if (hasExternalApply) {
          console.log(`      🔗 Job "${title}" has external apply: ${applyUrl.substring(0, 60)}...`);
        }

        jobs.push({
          id: jobId,
          title,
          company,
          description,
          url,
          isDirect: hasExternalApply,
          location,
          source: 'LinkedIn',
        });

      } catch (err: any) {
        console.warn(`      ⚠️ Failed to fetch details for job ${jobId}: ${err.message}`);
      }
    }

  } catch (error: any) {
    console.error('Error scraping LinkedIn:', error.message);
  }

  console.log(`      ✅ LinkedIn scraping complete. Returning ${jobs.length} jobs.`);
  return jobs;
}
