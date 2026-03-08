import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

// Initialize the Nodemailer transporter for Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: env.GMAIL_USER,
    pass: env.GMAIL_APP_PASSWORD,
  },
});

export interface EmailPayload {
  to: string;
  subject: string;
  bodyText: string;
  attachments?: { filename: string; path: string }[];
}

/**
 * Sends an email using Nodemailer via Gmail.
 */
export async function sendApplicationEmail(payload: EmailPayload): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const info = await transporter.sendMail({
      from: env.GMAIL_USER,
      to: payload.to,
      subject: payload.subject,
      text: payload.bodyText,
      attachments: payload.attachments,
    });

    console.log("Email sent successfully! MessageId:", info.messageId);
    return { success: true, id: info.messageId };
  } catch (err: any) {
    console.error("Error occurred while sending email via Nodemailer:", err);
    return { success: false, error: err.message || "Unknown error" };
  }
}
