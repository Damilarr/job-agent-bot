import type { DraftContext, DraftTone, EmailDraft } from "../services/drafter.js";
import type { ParsedJobDescription } from "../services/parser.js";
import type { PendingFormReview, PendingGoogleFormSession } from "./types.js";

const GLOBAL_CONCURRENCY = 2;
let globalActive = 0;
const globalQueue: Array<() => void> = [];

async function withGlobalLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (globalActive >= GLOBAL_CONCURRENCY) {
    await new Promise<void>((resolve) => globalQueue.push(resolve));
  }
  globalActive++;
  try {
    return await fn();
  } finally {
    globalActive--;
    const next = globalQueue.shift();
    if (next) next();
  }
}

const userChains = new Map<number, Promise<unknown>>();
function queueForUser<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = userChains.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn);
  userChains.set(
    userId,
    next.finally(() => {
      if (userChains.get(userId) === next) userChains.delete(userId);
    }),
  );
  return next;
}
const pendingMultiRole = new Map<string, PendingGoogleFormSession>();
const pendingFormReviews = new Map<number, PendingFormReview>();

const pendingEmails = new Map<
  string,
  {
    jobData: ParsedJobDescription;
    match: any;
    draft: EmailDraft;
    customResumeName?: string;
    coverLetterPath?: string;
    userId: number;
    cvText?: string;
    draftCtx?: DraftContext;
    tone?: DraftTone;
  }
>();
const activeSignInSessions = new Map<number, { close: () => Promise<void> }>();

export { activeSignInSessions, globalActive, globalQueue, pendingEmails, pendingFormReviews, pendingMultiRole, queueForUser, userChains, withGlobalLimit };
