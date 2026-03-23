import { chromium, type Page } from "playwright-chromium";
import { env } from "../config/env.js";
import { aiService } from "../services/ai.js";
import type { ParsedJobDescription } from "./parser.js";
import { formatCVForPrompt, myCV } from "../data/cv.js";
import path from "path";
import fs from "fs";

/** One row for the review: a question on the form and what we used */
export interface GoogleFormFilledField {
  label: string;
  value: string;
  kind: "text" | "file" | "radio" | "select";
}

export interface FormFillResult {
  success: boolean;
  message: string;
  /** Best-effort: whether file inputs were satisfied */
  fileUploads?: { resume: boolean; coverLetter: boolean };
  /** Only fields on the form that we matched and filled (or uploaded) */
  filledFields?: GoogleFormFilledField[];
}

export interface GoogleFormFillContext {
  roleTitle?: string;
  applicantName?: string;
  applicantEmail?: string;
  applicantPhone?: string;
  referrerName?: string;
  referrerEmail?: string;
  githubUrl?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  /** Absolute paths for Google Forms file-upload questions */
  resumePath?: string;
  coverLetterPath?: string;
}

export interface GoogleFormFillOptions {
  submit?: boolean;
}

function sanitizeGoogleFormQuestionLabel(raw: string): string {
  let t = raw.trim();
  t = t.replace(/\s*\*$/, "").trim();
  t = t.replace(/\s*Required\s*$/i, "").trim();
  const lines = t.split(/\n/).filter((l) => l.trim().length > 0);
  const first = (lines[0] ?? t).trim();
  return first.slice(0, 200);
}

/**
 * Automates logging in and filling out a job application on an ATS.
 */
export async function autoFillApplication(
  url: string,
  jobDesc: ParsedJobDescription,
): Promise<FormFillResult> {
  let browser;
  try {
    // Determine ATS Platform
    // IMPORTANT: LinkedIn URLs contain '/jobs/' but are NOT Greenhouse.
    // Only match '/jobs/' for non-LinkedIn domains.
    const isLinkedIn = url.includes("linkedin.com");
    const isGreenhouse =
      url.includes("boards.greenhouse.io") ||
      (!isLinkedIn && url.includes("/jobs/")) ||
      url.includes("dummy_greenhouse.html");
    const isLever = url.includes("jobs.lever.co");

    if (!isGreenhouse && !isLever) {
      return {
        success: false,
        message: `Unsupported ATS or form format for URL: ${url}`,
      };
    }

    browser = await chromium.launch({ headless: env.HEADLESS });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    console.log(`      🤖 Navigating to form: ${url}`);

    // anti-scraping headers/stealth
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    if (url.includes("linkedin.com/jobs")) {
      console.log(`      🛡️ Clearing LinkedIn popups...`);

      //close the sign-in modal
      try {
        const closeBtn = page
          .locator(
            'button.artdeco-modal__dismiss, button[aria-label="Dismiss"], .modal__dismiss',
          )
          .first();
        if (await closeBtn.isVisible({ timeout: 3000 })) {
          await closeBtn.click({ force: true });
          console.log(`      ✅ Dismissed modal.`);
        }
      } catch (e) {
        // Not found, ignore
      }

      await page.keyboard.press("Escape");
      await page.waitForTimeout(1000);
    }

    const cvText = formatCVForPrompt(myCV);

    let targetPage = page;

    if (isGreenhouse) {
      return await handleGreenhouseForm(targetPage, context, jobDesc, cvText);
    } else if (isLever) {
      return await handleLeverForm(targetPage, context, jobDesc, cvText);
    }

    return { success: false, message: "Detection logic fell through." };
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
 * Best-effort Google Forms filler for referral / application forms.
 * This is intentionally heuristic-based and will not handle every form perfectly.
 */
export async function autoFillGoogleForm(
  url: string,
  ctx: GoogleFormFillContext,
  options: GoogleFormFillOptions = {},
): Promise<FormFillResult> {
  let browser;
  let uploadedResume = false;
  let uploadedCover = false;
  const filledFields: GoogleFormFilledField[] = [];
  try {
    if (!/https?:\/\/docs\.google\.com\/forms\//i.test(url)) {
      return { success: false, message: `Not a Google Forms URL: ${url}` };
    }

    browser = await chromium.launch({ headless: env.HEADLESS });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const pageText = await page.textContent("body").catch(() => "") ?? "";
    const isSignInWall =
      currentUrl.includes("accounts.google.com") ||
      /sign\s*in\s+to\s+continue/i.test(pageText) ||
      (await page.locator('input[type="email"][name="identifier"]').count()) >
        0;

    if (isSignInWall) {
      return {
        success: false,
        message:
          "This Google Form requires sign-in to a Google account. Playwright cannot authenticate automatically — please open the form in your browser and fill it manually.",
      };
    }

    const activePage = page;

    const fillFileInputsOnPage = async () => {
      const fileInputs = activePage.locator('input[type="file"]');
      const n = await fileInputs.count();
      let resumeSlotUsed = false;
      let coverSlotUsed = false;

      for (let i = 0; i < n; i++) {
        const input = fileInputs.nth(i);
        const container = input.locator(
          'xpath=ancestor::*[@role="listitem"][1]',
        );
        const qRaw = (await container.textContent().catch(() => "")) || "";
        const headingEl = container.locator('[role="heading"]').first();
        const headingText = (await headingEl.textContent().catch(() => "")) || "";
        const label =
          sanitizeGoogleFormQuestionLabel(headingText) ||
          sanitizeGoogleFormQuestionLabel(qRaw);
        const qText = qRaw.toLowerCase();

        const looksCover =
          /\b(cover\s*letter|covering\s*letter)\b/i.test(qText) ||
          (/\bcover\b/i.test(qText) &&
            /\b(upload|file|attach|pdf)\b/i.test(qText));
        const looksCv =
          /\b(cv|curriculum|vitae|résumé|resumé)\b/i.test(qText) ||
          (/\bresume\b/i.test(qText) && !/\bcover\b/i.test(qText));

        let filePath: string | null = null;

        if (
          looksCover &&
          ctx.coverLetterPath &&
          fs.existsSync(ctx.coverLetterPath)
        ) {
          filePath = ctx.coverLetterPath;
        } else if (looksCv && ctx.resumePath && fs.existsSync(ctx.resumePath)) {
          filePath = ctx.resumePath;
        } else {
          // Unlabeled or generic: first file field → resume, second → cover letter
          if (
            !resumeSlotUsed &&
            ctx.resumePath &&
            fs.existsSync(ctx.resumePath)
          ) {
            filePath = ctx.resumePath;
            resumeSlotUsed = true;
          } else if (
            !coverSlotUsed &&
            ctx.coverLetterPath &&
            fs.existsSync(ctx.coverLetterPath)
          ) {
            filePath = ctx.coverLetterPath;
            coverSlotUsed = true;
          }
        }

        if (!filePath) continue;

        try {
          await input.setInputFiles(filePath);
          if (filePath === ctx.resumePath) uploadedResume = true;
          if (filePath === ctx.coverLetterPath) uploadedCover = true;
          const display =
            path.basename(filePath) ||
            (filePath === ctx.resumePath ? "Resume" : "Cover letter");
          filledFields.push({
            label: label || "File upload",
            value: display,
            kind: "file",
          });
        } catch {
          // hidden inputs / permission — ignore
        }
      }
    };

    const locateSubmitButton = async () => {
      const selectors = [
        'div[role="button"]:has-text("Submit")',
        'span[role="button"]:has-text("Submit")',
        'button:has-text("Submit")',
        '[jsname]:has-text("Submit")',
        'div[role="button"]:has-text("submit")',
      ];
      for (const sel of selectors) {
        const loc = activePage.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return loc;
      }
      return activePage.locator('div[role="button"]:has-text("Submit")').first();
    };

    const fillInputsOnPage = async () => {
      const inputs = activePage.locator(
        'input[type="text"], input[type="email"], input[type="url"], input[type="tel"], textarea, input:not([type])',
      );
      const count = await inputs.count();

      for (let i = 0; i < count; i++) {
        const input = inputs.nth(i);
        if (!(await input.isVisible().catch(() => false))) continue;

        const aria = (await input.getAttribute("aria-label")) || "";
        const container = input.locator(
          'xpath=ancestor::*[@role="listitem"][1]',
        );
        const qTextRaw = (await container.textContent().catch(() => "")) || "";
        const headingEl = container.locator('[role="heading"]').first();
        const headingText = (await headingEl.textContent().catch(() => "")) || "";
        const questionLabel =
          aria ||
          sanitizeGoogleFormQuestionLabel(headingText) ||
          sanitizeGoogleFormQuestionLabel(qTextRaw);
        const combined = `${aria}\n${qTextRaw}`.toLowerCase();

        const pick = (): string | null => {
          const email = ctx.applicantEmail || ctx.referrerEmail || null;
          if (combined.includes("github") && ctx.githubUrl)
            return ctx.githubUrl;
          if (
            (combined.includes("linkedin") || combined.includes("linked in")) &&
            ctx.linkedinUrl
          )
            return ctx.linkedinUrl;
          if (
            (combined.includes("portfolio") || combined.includes("website")) &&
            ctx.portfolioUrl
          )
            return ctx.portfolioUrl;

          if (
            combined.includes("referrer") &&
            combined.includes("name") &&
            ctx.referrerName
          )
            return ctx.referrerName;
          if (
            combined.includes("referrer") &&
            (combined.includes("email") || combined.includes("e-mail")) &&
            ctx.referrerEmail
          )
            return ctx.referrerEmail;

          const looksApplicantName =
            /\b(applicant|your)\s+name\b/i.test(combined) ||
            /\bfull\s+name\b/i.test(combined) ||
            /\byour\s+name\b/i.test(combined) ||
            (/\bname\b/i.test(combined) &&
              !/\b(company|business|firm|referrer|username|user\s+name)\b/i.test(
                combined,
              ));

          if (looksApplicantName && ctx.applicantName) return ctx.applicantName;
          if (
            (combined.includes("email") || combined.includes("e-mail")) &&
            email
          )
            return email;
          if (combined.includes("phone") || combined.includes("mobile")) {
            return ctx.applicantPhone || (email ?? "");
          }
          if (
            combined.includes("role") ||
            combined.includes("position") ||
            combined.includes("applying for")
          ) {
            return ctx.roleTitle || null;
          }
          return null;
        };

        const val = pick();
        if (!val) continue;

        await input.fill(val).catch(() => undefined);
        filledFields.push({
          label: questionLabel || "Question",
          value: val,
          kind: "text",
        });
      }
    };

    const tryPickRoleRadio = async () => {
      if (!ctx.roleTitle) return;
      const roleLower = ctx.roleTitle.toLowerCase();
      const radios = activePage.locator('[role="radio"]');
      const n = await radios.count();
      for (let i = 0; i < n; i++) {
        const r = radios.nth(i);
        const t = ((await r.textContent().catch(() => "")) || "").toLowerCase();
        if (t.includes(roleLower) || roleLower.includes(t)) {
          await r.click({ force: true }).catch(() => undefined);
          const listItem = r.locator(
            'xpath=ancestor::*[@role="listitem"][1]',
          );
          const qRaw =
            (await listItem.textContent().catch(() => "")) || "";
          const label = sanitizeGoogleFormQuestionLabel(qRaw);
          filledFields.push({
            label: label || "Choice",
            value: ctx.roleTitle,
            kind: "radio",
          });
          return;
        }
      }
    };

    const tryPickRoleSelect = async () => {
      if (!ctx.roleTitle) return;
      const selects = activePage.locator("div[role='listbox']");
      const n = await selects.count();
      for (let i = 0; i < n; i++) {
        const s = selects.nth(i);
        const parentText = (
          (await s
            .locator('xpath=ancestor::*[@role=\"listitem\"][1]')
            .textContent()
            .catch(() => "")) || ""
        ).toLowerCase();
        if (
          !parentText.includes("role") &&
          !parentText.includes("position") &&
          !parentText.includes("applying")
        )
          continue;
        await s.click({ force: true }).catch(() => undefined);
        const option = activePage.locator(`[role="option"]`, {
          hasText: ctx.roleTitle,
        });
        if (
          await option
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          await option
            .first()
            .click({ force: true })
            .catch(() => undefined);
          const qRaw =
            (await s
              .locator('xpath=ancestor::*[@role="listitem"][1]')
              .textContent()
              .catch(() => "")) || "";
          const label = sanitizeGoogleFormQuestionLabel(qRaw);
          filledFields.push({
            label: label || "Role / position",
            value: ctx.roleTitle,
            kind: "select",
          });
          return;
        }
        await activePage.keyboard.press("Escape").catch(() => undefined);
      }
    };

    const shouldSubmit = options.submit === true;

    // Multi-page forms: keep clicking Next if present, then stop at Submit (review) or click Submit (submit mode).
    const fileSummary = () => ({
      resume: uploadedResume,
      coverLetter: uploadedCover,
    });

    const withFields = (base: FormFillResult): FormFillResult => ({
      ...base,
      filledFields: [...filledFields],
      fileUploads: fileSummary(),
    });

    for (let step = 0; step < 6; step++) {
      await fillInputsOnPage();
      await fillFileInputsOnPage();
      await tryPickRoleRadio();
      await tryPickRoleSelect();

      const nextBtn = activePage
        .locator('div[role="button"]:has-text("Next")')
        .first();
      const submitBtn = await locateSubmitButton();

      if (await submitBtn.isVisible().catch(() => false)) {
        if (shouldSubmit) {
          await submitBtn.click({ force: true }).catch(() => undefined);
          await activePage.waitForTimeout(1500);
          return withFields({
            success: true,
            message: "Submitted Google Form successfully.",
          });
        }
        return withFields({
          success: true,
          message:
            "Filled Google Form and stopped at review (Submit button is ready).",
        });
      }

      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click({ force: true }).catch(() => undefined);
        await activePage.waitForTimeout(1500);
        continue;
      }

      // No next/submit found – we did our best.
      return withFields({
        success: true,
        message:
          "Filled Google Form fields (could not find Submit button to finalize).",
      });
    }

    return withFields({
      success: false,
      message: "Google Form flow exceeded max steps.",
    });
  } catch (error: any) {
    console.error("      ❌ Error during Google Form autofill:", error);
    return { success: false, message: `Playwright error: ${error.message}` };
  } finally {
    if (browser && env.HEADLESS) {
      await browser.close();
    }
  }
}

/**
 * Handles Greenhouse Boards
 */
async function handleGreenhouseForm(
  initialPage: Page,
  context: any,
  jobDesc: ParsedJobDescription,
  cvText: string,
): Promise<FormFillResult> {
  console.log(`      🌿 Detected Greenhouse ATS (Attempting to interact)`);

  let page = initialPage;
  const applyButton = page
    .locator('button.apply-button, a#apply_button, button:has-text("Apply")')
    .first();
  if (await applyButton.isVisible({ timeout: 15000 }).catch(() => false)) {
    console.log(`      🖱️ Clicking Apply button...`);

    // Listen for new tabs
    const [newPage] = await Promise.all([
      context.waitForEvent("page").catch(() => null),
      applyButton.click({ force: true }),
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

  if (
    !(
      page.url().includes("greenhouse.io") ||
      (await page.locator('input[name="first_name"]').count()) > 0
    )
  ) {
    return {
      success: false,
      message: "Could not reach the actual Greenhouse form.",
    };
  }

  await fillInputIfExists(
    page,
    'input[name="first_name"]',
    myCV.name.split(" ")[0] || "",
  );
  await fillInputIfExists(
    page,
    'input[name="last_name"]',
    myCV.name.split(" ").slice(1).join(" ") || "",
  );
  await fillInputIfExists(page, 'input[name="email"]', env.GMAIL_USER ?? "");
  await fillInputIfExists(page, 'input[name="phone"]', env.PHONE_NUMBER);

  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.isVisible()) {
    const resumePath = path.resolve(process.cwd(), "resume.pdf");
    try {
      await fileInput.setInputFiles(resumePath);
      console.log(`      📎 Uploaded Resume successfully.`);
      await page.waitForTimeout(1000);
    } catch (e) {
      console.warn(
        `      ⚠️ Failed to upload resume automatically. Please do it manually if pausing.`,
      );
    }
  }

  await fillInputByLabelFallback(page, /linkedin/i, env.LINKEDIN_URL);
  await fillInputByLabelFallback(page, /github|portfolio/i, env.GITHUB_URL);

  // Handle Custom Textareas (e.g., "Why do you want to work here?")
  await handleGenerateCustomAnswers(page, jobDesc, cvText);

  if (env.HEADLESS) {
    await page.click("button#submit_app");
    await page.waitForSelector('text="Thank you for applying"', {
      timeout: 10000,
    });
    return {
      success: true,
      message: "Greenhouse form submitted automatically.",
    };
  }

  return {
    success: true,
    message: "Populated Greenhouse Form (Auto-Submit is disabled).",
  };
}

/**
 * Handles Lever Boards
 */
async function handleLeverForm(
  initialPage: Page,
  context: any,
  jobDesc: ParsedJobDescription,
  cvText: string,
): Promise<FormFillResult> {
  console.log(`      ⚙️ Detected Lever ATS`);

  let page = initialPage;

  const applyButton = page
    .locator(
      'button.apply-button, a#apply_button, button:has-text("Apply"), a.postings-btn:has-text("Apply")',
    )
    .first();
  if (await applyButton.isVisible({ timeout: 15000 }).catch(() => false)) {
    console.log(`      🖱️ Clicking Apply button...`);

    const [newPage] = await Promise.all([
      context.waitForEvent("page").catch(() => null),
      applyButton.click({ force: true }),
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

  if (
    !(
      page.url().includes("lever.co") ||
      (await page.locator('input[name="name"]').count()) > 0
    )
  ) {
    return {
      success: false,
      message: "Could not reach the actual Lever form.",
    };
  }

  await fillInputIfExists(page, 'input[name="name"]', myCV.name);
  await fillInputIfExists(page, 'input[name="email"]', env.GMAIL_USER ?? "");
  await fillInputIfExists(page, 'input[name="phone"]', env.PHONE_NUMBER);
  await fillInputIfExists(page, 'input[name="org"]', "Self");

  await fillInputIfExists(
    page,
    'input[name="urls[LinkedIn]"]',
    env.LINKEDIN_URL,
  );
  await fillInputIfExists(page, 'input[name="urls[GitHub]"]', env.GITHUB_URL);
  if (env.PORTFOLIO_URL) {
    await fillInputIfExists(
      page,
      'input[name="urls[Portfolio]"]',
      env.PORTFOLIO_URL,
    );
  }

  const fileInput = page
    .locator('input[type="file"][data-qa="resume-upload-input"]')
    .first();
  if (await fileInput.isVisible({ timeout: 2000 })) {
    const resumePath = path.resolve(process.cwd(), "resume.pdf");
    try {
      await fileInput.setInputFiles(resumePath);
      console.log(`      📎 Uploaded Resume successfully.`);
      await page.waitForTimeout(2000);
    } catch (e) {
      /* ignore */
    }
  }

  //custom textareas
  await handleGenerateCustomAnswers(page, jobDesc, cvText);

  console.log(`      ✅ Lever form populated. Pausing before submit...`);

  if (env.HEADLESS) {
    await page.click('button[data-qa="btn-submit"]');
    await page.waitForSelector(".application-success", { timeout: 10000 });
    return { success: true, message: "Lever form submitted automatically." };
  }

  return {
    success: true,
    message: "Populated Lever Form (Auto-Submit is disabled).",
  };
}

// === Helper Functions ===

async function fillInputIfExists(page: Page, selector: string, value: string) {
  const el = page.locator(selector).first();
  if ((await el.count()) > 0 && (await el.isVisible())) {
    await el.fill(value);
  }
}

/**
 * Tries to find an input associated with a nearby label containing the text.
 * Useful for ATS systems where input names are randomly generated.
 */
async function fillInputByLabelFallback(
  page: Page,
  labelRegex: RegExp,
  value: string,
) {
  const labels = await page.locator("label").all();
  for (const label of labels) {
    const text = await label.textContent();
    if (text && labelRegex.test(text)) {
      const input = label
        .locator('xpath=..//input[not(@type="hidden")]')
        .first();
      if ((await input.count()) > 0 && (await input.isVisible())) {
        await input.fill(value);
        return;
      }
    }
  }
}

/**
 * Finds generic textareas and uses Gemini to generate answers based on the prompt label.
 */
async function handleGenerateCustomAnswers(
  page: Page,
  jobDesc: ParsedJobDescription,
  cvText: string,
) {
  // Find Custom Application Questions (usually textareas)
  const textareas = await page.locator("textarea").all();

  if (textareas.length > 0) {
    console.log(
      `      🤖 Found ${textareas.length} textareas for custom questions. Invoking AI...`,
    );
    const ai = aiService.getClient();

    for (const ta of textareas) {
      if (await ta.isVisible()) {
        // Try to figure out what the question is by looking at the parent/sibling labels
        const container = ta
          .locator(
            'xpath=./ancestor::div[contains(@class, "field") or contains(@class, "custom-question")]',
          )
          .first();

        let questionText =
          "Please write a brief, professional cover letter summary.";
        if ((await container.count()) > 0) {
          const labelText = await container
            .locator("label")
            .first()
            .textContent();
          if (labelText) questionText = labelText.trim();
        }

        console.log(
          `         ❓ Generating answer for: "${questionText.substring(0, 50)}..."`,
        );

        const prompt = `
          You are an expert software engineer applying for the following role:
          Job Title: ${jobDesc.jobTitle}
          Company: ${jobDesc.companyName || "A Tech Company"}
          
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
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { temperature: 0.3 },
          });
          const answer = response.text?.trim() || "Please refer to my resume.";
          await ta.fill(answer);
        } catch (e) {
          console.warn(`         ⚠️ Failed to generate AI answer for field.`);
        }
      }
    }
  }
}
