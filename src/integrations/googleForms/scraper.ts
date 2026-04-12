import { chromium, type Page } from "playwright-chromium";
import { env } from "../../config/env.js";
import { hasUserProfile, getUserProfileDir } from "./session.js";
import type { ScrapedFormQuestion } from "./types.js";
import { getFormFieldsCache, saveFormFieldsCache } from "../../data/db.js";
import { extractGoogleFormId } from "../../bot/utils.js";

/**
 * Scrape all questions from a Google Form (handles multi-page forms).
 * Opens the form using a persistent profile if available.
 */
export async function scrapeGoogleForm(
  url: string,
  telegramUserId?: number,
): Promise<{
  success: boolean;
  questions?: ScrapedFormQuestion[];
  formTitle?: string;
  error?: string;
}> {
  let browser: any;
  let persistentContext: any;
  const formId = extractGoogleFormId(url);
  
  if (formId) {
    const cached = await getFormFieldsCache(formId);
    if (cached) {
      console.log(`[Form Cache] Hit for scraped fields | ID: ${formId}`);
      return { success: true, questions: cached.questions, formTitle: cached.formTitle };
    }
  }

  try {
    let page: Page;

    if (telegramUserId && hasUserProfile(telegramUserId)) {
      const profileDir = getUserProfileDir(telegramUserId);
      persistentContext = await chromium.launchPersistentContext(profileDir, {
        headless: env.HEADLESS,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        args: ["--disable-blink-features=AutomationControlled"],
      });
      page = await persistentContext.newPage();
    } else {
      browser = await chromium.launch({ headless: env.HEADLESS });
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      });
      page = await context.newPage();
    }

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);

    // Check for sign-in wall
    const pageText = await page.textContent("body").catch(() => "") ?? "";
    if (
      page.url().includes("accounts.google.com") ||
      /sign\s*in\s+to\s+continue/i.test(pageText)
    ) {
      return {
        success: false,
        error: telegramUserId
          ? "Sign-in wall detected. Your session may have expired — use /connect_google to sign in again."
          : "This form requires Google sign-in. Use /connect_google first.",
      };
    }

    // Get form title
    const formTitle = await page
      .locator('[role="heading"]')
      .first()
      .textContent()
      .catch(() => "Google Form") ?? "Google Form";

    const allQuestions: ScrapedFormQuestion[] = [];
    let pageIndex = 0;

    const scrapeCurrentPage = async () => {
      // Each question is a listitem with role="listitem"
      const items = page.locator('[role="listitem"]');
      const count = await items.count();

      for (let i = 0; i < count; i++) {
        const item = items.nth(i);

        // Get question heading/label
        const headingEl = item.locator('[role="heading"]').first();
        const headingText = (await headingEl.textContent().catch(() => "")) || "";
        const label = headingText.replace(/\s*\*\s*$/, "").trim();

        if (!label) continue; // Skip non-question items (like section headers with no input)

        // Determine question type
        let type: ScrapedFormQuestion["type"] = "unknown";
        let options: string[] | undefined;

        // Check for file upload
        if ((await item.locator('input[type="file"]').count()) > 0) {
          type = "file";
        }
        // Check for radio buttons
        else if ((await item.locator('[role="radio"]').count()) > 0) {
          type = "radio";
          const radios = item.locator('[role="radio"]');
          const n = await radios.count();
          options = [];
          for (let r = 0; r < n; r++) {
            const t = ((await radios.nth(r).getAttribute("aria-label")) ||
              (await radios.nth(r).textContent().catch(() => "")) || "").trim();
            if (t) options.push(t);
          }
        }
        // Check for checkboxes
        else if ((await item.locator('[role="checkbox"]').count()) > 0) {
          type = "checkbox";
          const checks = item.locator('[role="checkbox"]');
          const n = await checks.count();
          options = [];
          for (let c = 0; c < n; c++) {
            const t = ((await checks.nth(c).getAttribute("aria-label")) ||
              (await checks.nth(c).textContent().catch(() => "")) || "").trim();
            if (t) options.push(t);
          }
        }
        // Check for dropdown/select
        else if ((await item.locator('[role="listbox"]').count()) > 0) {
          type = "select";
          // Click to open dropdown and read options
          const listbox = item.locator('[role="listbox"]').first();
          await listbox.click({ force: true }).catch(() => {});
          await page.waitForTimeout(500);
          const optEls = page.locator('[role="option"]');
          const optCount = await optEls.count();
          options = [];
          for (let o = 0; o < optCount; o++) {
            const t = ((await optEls.nth(o).textContent().catch(() => "")) || "").trim();
            if (t && t !== "Choose") options.push(t);
          }
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(300);
        }
        // Check for textarea
        else if ((await item.locator("textarea").count()) > 0) {
          type = "textarea";
        }
        // Check for date inputs
        else if ((await item.locator('input[type="date"]').count()) > 0 ||
                 (await item.locator('[data-supportsdate="true"]').count()) > 0) {
          type = "date";
        }
        // Check for time inputs
        else if ((await item.locator('input[aria-label="Hours"]').count()) > 0) {
          type = "time";
        }
        // Default: text input
        else if ((await item.locator('input[type="text"], input[type="email"], input[type="url"], input[type="tel"], input:not([type])').count()) > 0) {
          type = "text";
        }

        // Check if required
        const itemText = (await item.textContent().catch(() => "")) || "";
        const required = /\*/.test(headingText) || /required/i.test(itemText);

        allQuestions.push({
          index: allQuestions.length,
          label,
          type,
          options,
          required,
          pageIndex,
        });
      }
    };

    // Scrape first page
    await scrapeCurrentPage();

    // Handle multi-page forms: keep clicking "Next" to scrape all pages
    for (let step = 0; step < 10; step++) {
      const nextBtn = page
        .locator('div[role="button"]:has-text("Next")')
        .first();
      if (!(await nextBtn.isVisible().catch(() => false))) break;

      await nextBtn.click({ force: true });
      await page.waitForTimeout(2000);
      pageIndex++;
      await scrapeCurrentPage();
    }

    const result = {
      success: true,
      questions: allQuestions,
      formTitle: formTitle.trim(),
    };
    if (formId) {
      await saveFormFieldsCache(formId, { questions: allQuestions, formTitle: formTitle.trim() });
    }
    return result;
  } catch (error: any) {
    return { success: false, error: error.message };
  } finally {
    if (persistentContext) await persistentContext.close();
    else if (browser) await browser.close();
  }
}
