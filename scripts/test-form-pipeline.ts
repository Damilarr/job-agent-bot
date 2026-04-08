/**
 * Standalone test script for the AI-powered Google Form pipeline.
 * Tests scraping + AI answer generation WITHOUT needing Telegram.
 *
 * Usage:
 *   npx tsx scripts/test-form-pipeline.ts <google-form-url>
 *
 * Example:
 *   npx tsx scripts/test-form-pipeline.ts "https://docs.google.com/forms/d/e/xxxxx/viewform"
 */

import { config } from "dotenv";
config();

import {
  scrapeGoogleForm,
  generateFormAnswerPlan,
} from "../src/integrations/googleForms/index.js";

const url = process.argv[2];

if (!url) {
  console.error("❌ Usage: npx tsx scripts/test-form-pipeline.ts <google-form-url>");
  process.exit(1);
}

console.log("🔍 Scraping form:", url);
console.log("─".repeat(60));

const scrapeResult = await scrapeGoogleForm(url);

if (!scrapeResult.success || !scrapeResult.questions) {
  console.error("❌ Scrape failed:", scrapeResult.error);
  process.exit(1);
}

console.log(`\n✅ Form Title: "${scrapeResult.formTitle}"`);
console.log(`📋 Found ${scrapeResult.questions.length} question(s):\n`);

for (const q of scrapeResult.questions) {
  const opts = q.options ? ` [${q.options.join(", ")}]` : "";
  const req = q.required ? " *" : "";
  console.log(`  Q${q.index + 1} (${q.type}${req}): ${q.label}${opts}`);
}

console.log("\n" + "─".repeat(60));
console.log("🤖 Generating AI answer plan...\n");

// Use dummy profile data for testing — replace with real data if you want
const testProfile = `Name: Test User
Email: test@example.com
Phone: +1234567890
Skills: JavaScript, TypeScript, React, Node.js
Experience: 3 years as a Full Stack Developer
Education: BSc Computer Science`;

const testJD = "Software Developer position at a tech startup. Looking for someone with React and Node.js experience.";

try {
  const plan = await generateFormAnswerPlan(
    scrapeResult.questions,
    testProfile,
    testJD,
    scrapeResult.formTitle || "Google Form",
    {
      applicantName: "Test User",
      applicantEmail: "test@example.com",
      phone: "+1234567890",
      githubUrl: "https://github.com/testuser",
      linkedinUrl: "https://linkedin.com/in/testuser",
      roleTitle: "Software Developer",
      hasResume: true,
      hasCoverLetter: false,
    },
  );

  console.log(`✅ AI Answer Plan for "${plan.formTitle}":\n`);

  for (const a of plan.answers) {
    const fileTag = a.fileKind && a.fileKind !== "none" ? ` [📎 ${a.fileKind}]` : "";
    const answer = a.answer.length > 150 ? a.answer.slice(0, 147) + "..." : a.answer;
    console.log(`  Q${a.index + 1}: ${a.label}`);
    console.log(`     → ${answer}${fileTag}\n`);
  }

  console.log("─".repeat(60));
  console.log("✅ Pipeline test complete! Everything works.");
} catch (error: any) {
  console.error("❌ AI planning failed:", error.message);
  process.exit(1);
}
