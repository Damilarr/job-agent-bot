import nodemailer from "nodemailer";
import { getUserEmailAccount } from "../data/db.js";

export interface EmailPayload {
  to: string;
  subject: string;
  bodyText: string;
  attachments?: { filename: string; path: string }[];
}

function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sends an email using the per-user SMTP configuration stored in the database.
 */
export async function sendApplicationEmailForUser(
  userId: number,
  payload: EmailPayload,
): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const account = getUserEmailAccount(userId);
    if (!account) {
      return {
        success: false,
        error:
          "No email account configured for this user. Please run /set_email.",
      };
    }

    const textBody = normalizeLineBreaks(payload.bodyText);
    const htmlBody = `<div style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;">${escapeHtml(textBody)}</div>`;

    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: account.smtp_port === 465,
      auth: {
        user: account.smtp_user,
        pass: account.smtp_password,
      },
    });

    const info = await transporter.sendMail({
      from: account.email_address,
      to: payload.to,
      subject: payload.subject,
      text: textBody,
      html: htmlBody,
      attachments: payload.attachments,
    });

    console.log("Email sent successfully! MessageId:", info.messageId);
    return { success: true, id: info.messageId };
  } catch (err: any) {
    console.error("Error occurred while sending email via Nodemailer:", err);
    return { success: false, error: err.message || "Unknown error" };
  }
}
