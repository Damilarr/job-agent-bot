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
  /** Telegram user ID — used to load a persistent browser profile with Google sign-in */
  telegramUserId?: number;
}

/** A single question scraped from a Google Form */
export interface ScrapedFormQuestion {
  index: number;
  label: string;
  type: "text" | "textarea" | "radio" | "checkbox" | "select" | "file" | "date" | "time" | "unknown";
  options?: string[] | undefined;
  required: boolean;
  pageIndex: number;
}

/** A planned answer for one form question */
export interface FormAnswerPlanItem {
  index: number;
  label: string;
  type: string;
  answer: string;
  /** For file-type questions: which file to upload */
  fileKind?: "resume" | "cover_letter" | "none";
}

/** Full answer plan for a form */
export interface FormAnswerPlan {
  formTitle: string;
  answers: FormAnswerPlanItem[];
}
