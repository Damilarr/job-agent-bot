import type { DraftContext, DraftTone, EmailDraft } from "../services/drafter.js";
import type { MatchEvaluation } from "../services/matcher.js";
import type { ParsedJobDescription } from "../services/parser.js";

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

export interface PendingEmail {
  jobData: ParsedJobDescription;
  match: MatchEvaluation;
  draft: EmailDraft;
  userId: number;
  /** Profile text combined with the extracted resume text */
  cvText: string;
  draftCtx: DraftContext;
  tone: DraftTone;
  /** Resume found on disk when the draft was created */
  resumePath?: string;
  customResumeName?: string;
  coverLetterPath?: string;
  coverLetterError?: string;
}

const pendingEmails = new Map<string, PendingEmail>();

export { globalActive, globalQueue, pendingEmails, queueForUser, userChains, withGlobalLimit };
