import { chromium, type Page } from "playwright-chromium";
import { env } from "../../config/env.js";
import { aiService } from "../../services/ai.js";
import { hasUserProfile, getUserProfileDir, clearGoogleSessionMarker } from "./session.js";
import { sanitizeGoogleFormQuestionLabel } from "./utils.js";
import type { ParsedJobDescription } from "../../services/parser.js";
import type { GoogleFormFillContext, GoogleFormFillOptions, FormFillResult, GoogleFormFilledField } from "./types.js";
import path from "path";
import fs from "fs";

/**
 * Best-effort Google Forms filler for referral / application forms.
 * This is intentionally heuristic-based and will not handle every form perfectly.
 *
 * If a telegramUserId is provided and has a saved browser profile, uses it to
 * bypass Google sign-in walls. Otherwise, falls back to an ephemeral browser.
 */
export async function autoFillGoogleForm(
  url: string,
  ctx: GoogleFormFillContext,
  options: GoogleFormFillOptions = {},
): Promise<FormFillResult> {
  let browser: any;
  let persistentContext: any;
  let uploadedResume = false;
  let uploadedCover = false;
  const filledFields: GoogleFormFilledField[] = [];
  try {
    if (!/https?:\/\/docs\.google\.com\/forms\//i.test(url)) {
      return { success: false, message: `Not a Google Forms URL: ${url}` };
    }

    let page;

    // Use persistent profile if user has one (for sign-in-required forms)
    const userId = options.telegramUserId;
    if (userId && hasUserProfile(userId)) {
      const profileDir = getUserProfileDir(userId);
      persistentContext = await chromium.launchPersistentContext(profileDir, {
        headless: env.HEADLESS,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        args: ["--disable-blink-features=AutomationControlled"],
      });
      page = await persistentContext.newPage();
      console.log(`      🔑 Using saved browser profile for user ${userId}`);
    } else {
      // Ephemeral browser (no saved session)
      browser = await chromium.launch({ headless: env.HEADLESS });
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      });
      page = await context.newPage();
    }

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
      // If we had a profile but hit a sign-in wall, the session has expired
      if (userId) {
        clearGoogleSessionMarker(userId);
      }
      return {
        success: false,
        message: userId
          ? "Sign-in wall detected even with saved profile. Your session may have expired — use /connect_google to sign in again."
          : "This Google Form requires sign-in. Use /connect_google to link your Google account first.",
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
    if (persistentContext) {
      await persistentContext.close();
    } else if (browser && env.HEADLESS) {
      await browser.close();
    }
  }
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
          const response = await ai.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
          });
          const answer = response.choices[0]?.message?.content?.trim() || "Please refer to my resume.";
          await ta.fill(answer);
        } catch (e) {
          console.warn(`         ⚠️ Failed to generate AI answer for field.`);
        }
      }
    }
  }
}
