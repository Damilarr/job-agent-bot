import { chromium, type Page } from "playwright-chromium";
import { env } from "../../config/env.js";
import { hasUserProfile, getUserProfileDir } from "./session.js";
import type { FormAnswerPlan, FormFillResult, GoogleFormFilledField } from "./types.js";
import path from "path";
import fs from "fs";

/**
 * Execute the planned answers: open the form, fill in all fields, and optionally submit.
 */
export async function fillGoogleFormFromPlan(
  url: string,
  plan: FormAnswerPlan,
  files: { resumePath?: string | undefined; coverLetterPath?: string | undefined },
  options: { submit: boolean; telegramUserId?: number },
): Promise<FormFillResult> {
  let browser: any;
  let persistentContext: any;
  const filledFields: GoogleFormFilledField[] = [];
  let uploadedResume = false;
  let uploadedCover = false;

  try {
    let page: Page;

    const userId = options.telegramUserId;
    if (userId && hasUserProfile(userId)) {
      persistentContext = await chromium.launchPersistentContext(
        getUserProfileDir(userId),
        {
          headless: env.HEADLESS,
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
          args: ["--disable-blink-features=AutomationControlled"],
        },
      );
      page = await persistentContext.newPage();
    } else {
      browser = await chromium.launch({ headless: env.HEADLESS });
      const ctx = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      });
      page = await ctx.newPage();
    }

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);

    let currentPage = 0;

    const fillCurrentPage = async () => {
      const items = page.locator('[role="listitem"]');
      const count = await items.count();

      // Build a map of questions on this page by matching labels
      const pageAnswers = plan.answers.filter((a) => a.type !== "unknown");

      let answerIdx = 0;
      for (let i = 0; i < count && answerIdx < pageAnswers.length; i++) {
        const item = items.nth(i);
        const headingEl = item.locator('[role="heading"]').first();
        const headingText = ((await headingEl.textContent().catch(() => "")) || "").replace(/\s*\*\s*$/, "").trim();

        if (!headingText) continue;

        // Find the matching answer by label
        const answer = pageAnswers.find(
          (a) => a.label === headingText && !filledFields.some((f) => f.label === a.label),
        );
        if (!answer) continue;

        try {
          switch (answer.type) {
            case "text":
            case "textarea": {
              const input = item.locator(
                'input[type="text"], input[type="email"], input[type="url"], input[type="tel"], input:not([type]), textarea',
              ).first();
              if (await input.isVisible().catch(() => false)) {
                await input.fill(answer.answer);
                filledFields.push({ label: answer.label, value: answer.answer, kind: "text" });
              }
              break;
            }
            case "radio": {
              const radios = item.locator('[role="radio"]');
              const n = await radios.count();
              const expected = answer.answer.trim().toLowerCase();
              for (let r = 0; r < n; r++) {
                const element = radios.nth(r);
                const dataVal = (await element.getAttribute("data-value") || "").trim().toLowerCase();
                const ariaLabel = (await element.getAttribute("aria-label") || "").trim().toLowerCase();
                const textContent = (await element.textContent().catch(() => "") || "").trim().toLowerCase();
                
                const matched = [dataVal, ariaLabel, textContent].some(value => 
                  value && (value === expected || (value.includes(expected) && expected.length > 0))
                );

                if (matched) {
                  await element.click({ force: true });
                  filledFields.push({ label: answer.label, value: answer.answer, kind: "radio" });
                  break;
                }
              }
              break;
            }
            case "checkbox": {
              const selections = answer.answer.split(" | ").map((s) => s.trim().toLowerCase());
              const checks = item.locator('[role="checkbox"]');
              const n = await checks.count();
              for (let c = 0; c < n; c++) {
                const element = checks.nth(c);
                const dataVal = (await element.getAttribute("data-value") || "").trim().toLowerCase();
                const ariaLabel = (await element.getAttribute("aria-label") || "").trim().toLowerCase();
                const textContent = (await element.textContent().catch(() => "") || "").trim().toLowerCase();
                
                const matched = selections.some(expected => 
                  [dataVal, ariaLabel, textContent].some(value => 
                    value && (value === expected || (value.includes(expected) && expected.length > 0))
                  )
                );

                if (matched) {
                  await element.click({ force: true });
                }
              }
              filledFields.push({ label: answer.label, value: answer.answer, kind: "radio" });
              break;
            }
            case "select": {
              const listbox = item.locator('[role="listbox"]').first();
              await listbox.click({ force: true }).catch(() => {});
              await page.waitForTimeout(500);
              const option = page.locator('[role="option"]', { hasText: answer.answer }).first();
              if (await option.isVisible().catch(() => false)) {
                await option.click({ force: true });
                filledFields.push({ label: answer.label, value: answer.answer, kind: "select" });
              } else {
                await page.keyboard.press("Escape").catch(() => {});
              }
              break;
            }
            case "file": {
              const fileInput = item.locator('input[type="file"]').first();
              let filePath: string | undefined;
              if (answer.fileKind === "resume" && files.resumePath && fs.existsSync(files.resumePath)) {
                filePath = files.resumePath;
              } else if (answer.fileKind === "cover_letter" && files.coverLetterPath && fs.existsSync(files.coverLetterPath)) {
                filePath = files.coverLetterPath;
              }
              if (filePath) {
                await fileInput.setInputFiles(filePath);
                if (answer.fileKind === "resume") uploadedResume = true;
                if (answer.fileKind === "cover_letter") uploadedCover = true;
                filledFields.push({ label: answer.label, value: path.basename(filePath), kind: "file" });
              }
              break;
            }
          }
        } catch (e) {
          console.warn(`      ⚠️ Failed to fill: "${answer.label}"`);
        }
      }
    };

    // Fill pages, clicking Next between them
    await fillCurrentPage();

    for (let step = 0; step < 10; step++) {
      const nextBtn = page.locator('div[role="button"]:has-text("Next")').first();
      if (!(await nextBtn.isVisible().catch(() => false))) break;

      await nextBtn.click({ force: true });
      await page.waitForTimeout(2000);
      currentPage++;
      await fillCurrentPage();
    }

    // Submit or stop
    if (options.submit) {
      const submitSelectors = [
        'div[role="button"]:has-text("Submit")',
        'span[role="button"]:has-text("Submit")',
        'button:has-text("Submit")',
      ];
      for (const sel of submitSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ force: true, noWaitAfter: true });
          await page.waitForTimeout(2000);
          break;
        }
      }
    }

    return {
      success: true,
      message: options.submit
        ? "Google Form submitted successfully!"
        : "Google Form filled (review mode — not submitted yet).",
      filledFields,
      fileUploads: { resume: uploadedResume, coverLetter: uploadedCover },
    };
  } catch (error: any) {
    console.error("      ❌ Error filling form from plan:", error);
    return { success: false, message: `Error: ${error.message}` };
  } finally {
    if (persistentContext) await persistentContext.close();
    else if (browser) await browser.close();
  }
}
