import { chromium, type Page } from 'playwright-chromium';
import { env } from '../config/env.js';
import { aiService } from '../services/ai.js';
import type { ParsedJobDescription } from './parser.js';
import { formatCVForPrompt, myCV } from '../data/cv.js';
import path from 'path';

export interface FormFillResult {
  success: boolean;
  message: string;
}

/**
 * Automates logging in and filling out a job application on an ATS.
 */
export async function autoFillApplication(url: string, jobDesc: ParsedJobDescription): Promise<FormFillResult> {
  let browser;
  try {
    // Determine ATS Platform
    // IMPORTANT: LinkedIn URLs contain '/jobs/' but are NOT Greenhouse.
    // Only match '/jobs/' for non-LinkedIn domains.
    const isLinkedIn = url.includes('linkedin.com');
    const isGreenhouse = url.includes('boards.greenhouse.io') || (!isLinkedIn && url.includes('/jobs/')) || url.includes('dummy_greenhouse.html');
    const isLever = url.includes('jobs.lever.co');

    if (!isGreenhouse && !isLever) {
      return { success: false, message: `Unsupported ATS or form format for URL: ${url}` };
    }

    browser = await chromium.launch({ headless: env.HEADLESS });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    console.log(`      🤖 Navigating to form: ${url}`);
    
    // anti-scraping headers/stealth
    await page.setExtraHTTPHeaders({
       'Accept-Language': 'en-US,en;q=0.9',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (url.includes('linkedin.com/jobs')) {
      console.log(`      🛡️ Clearing LinkedIn popups...`);
      
      //close the sign-in modal
      try {
        const closeBtn = page.locator('button.artdeco-modal__dismiss, button[aria-label="Dismiss"], .modal__dismiss').first();
        if (await closeBtn.isVisible({ timeout: 3000 })) {
          await closeBtn.click({ force: true });
          console.log(`      ✅ Dismissed modal.`);
        }
      } catch (e) {
        // Not found, ignore
      }

      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    }

    const cvText = formatCVForPrompt(myCV);

    let targetPage = page;

    if (isGreenhouse) {
      return await handleGreenhouseForm(targetPage, context, jobDesc, cvText);
    } else if (isLever) {
      return await handleLeverForm(targetPage, context, jobDesc, cvText);
    }

    return { success: false, message: 'Detection logic fell through.' };

  } catch (error: any) {
    console.error("      ❌ Error during form autofill:", error);
    return { success: false, message: `Playwright error: ${error.message}` };
  } finally {
    if (browser) {
      if (env.HEADLESS) {
        await browser.close();
      }
    }
  }
}

/**
 * Handles Greenhouse Boards
 */
async function handleGreenhouseForm(initialPage: Page, context: any, jobDesc: ParsedJobDescription, cvText: string): Promise<FormFillResult> {
  console.log(`      🌿 Detected Greenhouse ATS (Attempting to interact)`);
  
  let page = initialPage;
  const applyButton = page.locator('button.apply-button, a#apply_button, button:has-text("Apply")').first();
  if (await applyButton.isVisible({ timeout: 15000 }).catch(() => false)) {
    console.log(`      🖱️ Clicking Apply button...`);
    
    // Listen for new tabs
    const [newPage] = await Promise.all([
      context.waitForEvent('page').catch(() => null),
      applyButton.click({ force: true })
    ]);

    if (newPage) {
      console.log(`      📑 Apply button opened a new tab. Switching to it.`);
      page = newPage;
      await page.waitForLoadState();
      await page.waitForTimeout(2000);
    } else {
      await page.waitForTimeout(2000);
    }
  }

  if (!(page.url().includes('greenhouse.io') || await page.locator('input[name="first_name"]').count() > 0)) {
     return { success: false, message: 'Could not reach the actual Greenhouse form.' };
  }

  await fillInputIfExists(page, 'input[name="first_name"]', myCV.name.split(' ')[0] || '');
  await fillInputIfExists(page, 'input[name="last_name"]', myCV.name.split(' ').slice(1).join(' ') || '');
  await fillInputIfExists(page, 'input[name="email"]', env.GMAIL_USER);
  await fillInputIfExists(page, 'input[name="phone"]', env.PHONE_NUMBER);

  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.isVisible()) {
    const resumePath = path.resolve(process.cwd(), 'resume.pdf');
    try {
      await fileInput.setInputFiles(resumePath);
      console.log(`      📎 Uploaded Resume successfully.`);
      await page.waitForTimeout(1000);
    } catch (e) {
      console.warn(`      ⚠️ Failed to upload resume automatically. Please do it manually if pausing.`);
    }
  }

  await fillInputByLabelFallback(page, /linkedin/i, env.LINKEDIN_URL);
  await fillInputByLabelFallback(page, /github|portfolio/i, env.GITHUB_URL);

  // Handle Custom Textareas (e.g., "Why do you want to work here?")
  await handleGenerateCustomAnswers(page, jobDesc, cvText);

  
  if(env.HEADLESS){
    await page.click('button#submit_app');
    await page.waitForSelector('text="Thank you for applying"', { timeout: 10000 });
    return { success: true, message: 'Greenhouse form submitted automatically.' };
  }

  return { success: true, message: 'Populated Greenhouse Form (Auto-Submit is disabled).' };
}

/**
 * Handles Lever Boards
 */
async function handleLeverForm(initialPage: Page, context: any, jobDesc: ParsedJobDescription, cvText: string): Promise<FormFillResult> {
  console.log(`      ⚙️ Detected Lever ATS`);
  
  let page = initialPage;

  const applyButton = page.locator('button.apply-button, a#apply_button, button:has-text("Apply"), a.postings-btn:has-text("Apply")').first();
  if (await applyButton.isVisible({ timeout: 15000 }).catch(() => false)) {
    console.log(`      🖱️ Clicking Apply button...`);
    
    const [newPage] = await Promise.all([
      context.waitForEvent('page').catch(() => null),
      applyButton.click({ force: true })
    ]);

    if (newPage) {
      console.log(`      📑 Apply button opened a new tab. Switching to it.`);
      page = newPage;
      await page.waitForLoadState();
      await page.waitForTimeout(2000); 
    } else {
      await page.waitForTimeout(2000); 
    }
  }

  if (!(page.url().includes('lever.co') || await page.locator('input[name="name"]').count() > 0)) {
     return { success: false, message: 'Could not reach the actual Lever form.' };
  }

  await fillInputIfExists(page, 'input[name="name"]', myCV.name);
  await fillInputIfExists(page, 'input[name="email"]', env.GMAIL_USER);
  await fillInputIfExists(page, 'input[name="phone"]', env.PHONE_NUMBER);
  await fillInputIfExists(page, 'input[name="org"]', 'Self'); 

  await fillInputIfExists(page, 'input[name="urls[LinkedIn]"]', env.LINKEDIN_URL);
  await fillInputIfExists(page, 'input[name="urls[GitHub]"]', env.GITHUB_URL);
  if (env.PORTFOLIO_URL) {
      await fillInputIfExists(page, 'input[name="urls[Portfolio]"]', env.PORTFOLIO_URL);
  }

  const fileInput = page.locator('input[type="file"][data-qa="resume-upload-input"]').first();
  if (await fileInput.isVisible({ timeout: 2000 })) {
     const resumePath = path.resolve(process.cwd(), 'resume.pdf');
     try {
       await fileInput.setInputFiles(resumePath);
       console.log(`      📎 Uploaded Resume successfully.`);
       await page.waitForTimeout(2000);
     } catch(e) { /* ignore */ }
  }

  //custom textareas
  await handleGenerateCustomAnswers(page, jobDesc, cvText);

  console.log(`      ✅ Lever form populated. Pausing before submit...`);

  if (env.HEADLESS) {
    await page.click('button[data-qa="btn-submit"]');
    await page.waitForSelector('.application-success', { timeout: 10000 });
    return { success: true, message: 'Lever form submitted automatically.' };
  }

  return { success: true, message: 'Populated Lever Form (Auto-Submit is disabled).' };
}

// === Helper Functions ===

async function fillInputIfExists(page: Page, selector: string, value: string) {
  const el = page.locator(selector).first();
  if (await el.count() > 0 && await el.isVisible()) {
    await el.fill(value);
  }
}

/**
 * Tries to find an input associated with a nearby label containing the text.
 * Useful for ATS systems where input names are randomly generated.
 */
async function fillInputByLabelFallback(page: Page, labelRegex: RegExp, value: string) {
  const labels = await page.locator('label').all();
  for (const label of labels) {
    const text = await label.textContent();
    if (text && labelRegex.test(text)) {
      const input = label.locator('xpath=..//input[not(@type="hidden")]').first();
      if (await input.count() > 0 && await input.isVisible()) {
        await input.fill(value);
        return;
      }
    }
  }
}

/**
 * Finds generic textareas and uses Gemini to generate answers based on the prompt label.
 */
async function handleGenerateCustomAnswers(page: Page, jobDesc: ParsedJobDescription, cvText: string) {
  // Find Custom Application Questions (usually textareas)
  const textareas = await page.locator('textarea').all();
  
  if (textareas.length > 0) {
    console.log(`      🤖 Found ${textareas.length} textareas for custom questions. Invoking AI...`);
    const ai = aiService.getClient();

    for (const ta of textareas) {
      if (await ta.isVisible()) {
        // Try to figure out what the question is by looking at the parent/sibling labels
        const container = ta.locator('xpath=./ancestor::div[contains(@class, "field") or contains(@class, "custom-question")]').first();
        
        let questionText = "Please write a brief, professional cover letter summary.";
        if (await container.count() > 0) {
           const labelText = await container.locator('label').first().textContent();
           if (labelText) questionText = labelText.trim();
        }

        console.log(`         ❓ Generating answer for: "${questionText.substring(0, 50)}..."`);

        const prompt = `
          You are an expert software engineer applying for the following role:
          Job Title: ${jobDesc.jobTitle}
          Company: ${jobDesc.companyName || 'A Tech Company'}
          
          The job application form asked the following question:
          "${questionText}"

          Here is my resume/CV:
          ---
          ${cvText}
          ---

          Write a concise, natural, and highly professional answer to this form question.
          Do NOT write a full cover letter unless the question explicitly asks for one.
          If the question asks for a link (like LinkedIn or GitHub), just output the URL.
          If it's a yes/no question about sponsorship or eligibility, look at the resume or assume authorized to work if remote.
          Provide ONLY the text answer with no quotes around it.
        `;

        try {
          const response = await ai.models.generateContent({
             model: 'gemini-2.5-flash',
             contents: prompt,
             config: { temperature: 0.3 }
          });
          const answer = response.text?.trim() || 'Please refer to my resume.';
          await ta.fill(answer);
        } catch (e) {
          console.warn(`         ⚠️ Failed to generate AI answer for field.`);
        }
      }
    }
  }
}
