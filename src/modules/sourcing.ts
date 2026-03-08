import axios from 'axios';
import { env } from '../config/env.js';

const JSEARCH_API_URL = 'https://jsearch.p.rapidapi.com/search';

export interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  job_description: string;
  job_apply_link: string;
  job_apply_is_direct: boolean;
  job_apply_email?: string | null;
  job_is_remote: boolean;
  job_city?: string;
  job_state?: string;
  job_country?: string;
}

let currentKeyIndex = 0;

/**
 * Fetches recent job postings from the JSearch API based on a query.
 */
export async function fetchJobsFromAPI(query: string, numPages: number = 1): Promise<JSearchJob[]> {
  try {
    // Parse multiple keys from env and select the current one
    const apiKeys = env.JSEARCH_RAPIDAPI_KEY.split(',').map(k => k.trim()).filter(k => k.length > 0);
    const selectedKey = apiKeys[currentKeyIndex % apiKeys.length];
    currentKeyIndex++; // Rotate for the next API call

    const options = {
      method: 'GET',
      url: JSEARCH_API_URL,
      params: {
        query: query,
        page: '1',
        num_pages: numPages.toString(),
        date_posted: 'today' // Only fresh jobs
      },
      headers: {
        'x-rapidapi-key': selectedKey,
        'x-rapidapi-host': 'jsearch.p.rapidapi.com'
      }
    };

    const response = await axios.request(options);
    
    if (response.data && response.data.data) {
      return response.data.data as JSearchJob[];
    }
    
    return [];
  } catch (error) {
    console.error("Error fetching jobs from JSearch API:", error);
    return [];
  }
}
