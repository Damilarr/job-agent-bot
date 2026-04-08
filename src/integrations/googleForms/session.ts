import { chromium } from "playwright-chromium";
import path from "path";
import fs from "fs";

/**
 * Returns the path to a per-user Playwright browser profile directory.
 * The profile stores cookies/session data so Google sign-in persists.
 */
export function getUserProfileDir(telegramUserId: number): string {
  return path.resolve(process.cwd(), ".browser_profiles", String(telegramUserId));
}

/**
 * Check whether a user has a saved browser profile directory (i.e., they ran /connect_google).
 * NOTE: This only checks that the directory exists, which happens at the START of sign-in.
 * Use `isGoogleSessionValid()` to verify the sign-in was actually completed.
 */
export function hasUserProfile(telegramUserId: number): boolean {
  return fs.existsSync(getUserProfileDir(telegramUserId));
}

/**
 * Check whether a user's Google sign-in has been verified and marked as valid.
 * Uses a lightweight marker file approach — the marker is only created after
 * the browser-based verification in /connect_google_done succeeds.
 */
export async function isGoogleSessionValid(telegramUserId: number): Promise<boolean> {
  const profileDir = getUserProfileDir(telegramUserId);
  return fs.existsSync(path.join(profileDir, ".google_connected"));
}

/**
 * Mark a user's Google session as verified.
 * Called after /connect_google_done confirms a successful sign-in.
 */
export function markGoogleSessionValid(telegramUserId: number): void {
  const profileDir = getUserProfileDir(telegramUserId);
  fs.writeFileSync(path.join(profileDir, ".google_connected"), new Date().toISOString());
}

/**
 * Remove the verified marker (e.g. when we detect an expired session or user wants to re-authenticate).
 */
export function clearGoogleSessionMarker(telegramUserId: number): void {
  const markerPath = path.join(getUserProfileDir(telegramUserId), ".google_connected");
  if (fs.existsSync(markerPath)) {
    fs.unlinkSync(markerPath);
  }
}

/**
 * Verify the Google session by actually launching the browser profile
 * headlessly and navigating to a Google page. Only call this when the
 * user finishes sign-in (/connect_google_done), not on every status check.
 */
export async function verifyGoogleSessionViaBrowser(telegramUserId: number): Promise<boolean> {
  const profileDir = getUserProfileDir(telegramUserId);
  if (!fs.existsSync(profileDir)) return false;

  let context: any;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const page = await context.newPage();
    await page.goto("https://myaccount.google.com", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    const url = page.url();
    // If we ended up on accounts.google.com it means the session is invalid
    const isSignedIn = !url.includes("accounts.google.com/") &&
      !url.includes("/signin") &&
      !url.includes("/ServiceLogin");

    return isSignedIn;
  } catch {
    return false;
  } finally {
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Launch a visible (non-headless) browser for the user to sign into Google.
 * The session is saved to a per-user profile directory for future reuse.
 * Returns a cleanup function to call when done.
 */
export async function launchGoogleSignIn(telegramUserId: number): Promise<{
  close: () => Promise<void>;
}> {
  const profileDir = getUserProfileDir(telegramUserId);
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, // Must be visible for the user to sign in
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = await context.newPage();
  await page.goto("https://accounts.google.com/signin", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  return {
    close: async () => {
      await context.close();
    },
  };
}
