import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";
import type { EmailStatus, QuoteEmail } from "@/lib/mail-core";
import { inTestMode, testAddress, testMode } from "@/lib/mail-test-mode";

export { inTestMode, testAddress, testMode };

// Sending email through the company's own mail server (SMTP). Settings come from the environment:
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM.
// Without SMTP_HOST nothing is sent. In development the message and its attachment are saved under
// web/.data/outbox so they can be looked at; in production that is an error, never a silent skip.

export type Attachment = { filename: string; content: Buffer; contentType: string };
export type SendResult = { status: EmailStatus; error: string | null; savedTo?: string; /** The address the message really went to, when it differs from the intended one (test mode). */ deliveredTo?: string };


// A server that needs a login counts as configured only once its password is filled in.
export const mailConfigured = () => !!process.env.SMTP_HOST && (!process.env.SMTP_USER || !!process.env.SMTP_PASSWORD);

export async function sendEmail(intended: QuoteEmail, attachments: Attachment[], saveAs: string, sender: { from: string; replyTo: string } | null = null): Promise<SendResult> {
  let mail = intended;
  if (testMode()) {
    if (!testAddress()) return { status: "failed", error: "במצב טסט חייבת להיות מוגדרת כתובת הבדיקה (AO_TEST_EMAIL). לא נשלח כלום." };
    mail = inTestMode(intended);
  }
  const deliveredTo = testMode() ? mail.to : undefined;
  if (!mailConfigured()) {
    if (process.env.NODE_ENV === "production") return { status: "failed", error: "לא הוגדר שרת דואר (SMTP_HOST, ואם יש שם משתמש גם SMTP_PASSWORD)." };
    const dir = path.join(process.cwd(), ".data", "outbox");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${saveAs}.txt`), `${sender ? `From: ${sender.from}\n` : ""}To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`, "utf8");
    for (const a of attachments) await writeFile(path.join(dir, `${saveAs}-${a.filename}`), a.content);
    return { status: "not_sent_dev", error: null, savedTo: dir, deliveredTo };
  }
  // The sender chosen in the communication settings wins over the server's default.
  const from = sender?.from || process.env.MAIL_FROM || process.env.SMTP_USER;
  if (!from) return { status: "failed", error: "לא הוגדרה כתובת שולח (MAIL_FROM)." };
  const port = Number(process.env.SMTP_PORT) || 587;
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? "" } : undefined,
    });
    await transport.sendMail({ from, replyTo: testMode() ? undefined : sender?.replyTo, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, attachments });
    return { status: "sent", error: null, deliveredTo };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e), deliveredTo };
  }
}
