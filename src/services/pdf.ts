import fs from "fs";
import path from "path";
import { chromium } from "playwright-chromium";
import { env } from "../config/env.js";

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/**
 * Renders HTML to a PDF file using Playwright's bundled Chromium.
 * Playwright is already used elsewhere in the project and is more reliable
 * in headless/server environments than Puppeteer (used by md-to-pdf).
 */
export async function renderHtmlToPdf(
  html: string,
  outputPath: string,
): Promise<string> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const browser = await chromium.launch({
    headless: env.HEADLESS,
    args: LAUNCH_ARGS,
    timeout: 60_000,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.pdf({
      path: outputPath,
      format: "A4",
      margin: { top: "20mm", right: "20mm", bottom: "20mm", left: "20mm" },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }

  return outputPath;
}

/** Minimal markdown → HTML for cover letters (paragraphs, bold, italic). */
export function markdownToHtml(markdown: string): string {
  const blocks = markdown.trim().split(/\n{2,}/);

  return blocks
    .map((block) => {
      let text = block.trim();
      if (!text) return "";

      text = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/\n/g, "<br>");

      return `<p>${text}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

export function wrapCoverLetterHtml(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: Helvetica, Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #333;
    }
    p { margin: 0 0 15px 0; }
    strong { color: #222; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;
}
