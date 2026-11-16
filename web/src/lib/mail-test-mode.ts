// Test mode for outgoing mail. No dependency on Next.js or the mail server, so it can be checked on its own.
import type { QuoteEmail } from "./mail-core.ts";

// Test mode (AO_TEST_MODE=1): every message goes to one test address (AO_TEST_EMAIL), whoever the recipient is.
// The subject says so, and the body names the recipient it was meant for. Without a test address nothing is sent.
export const testMode = () => process.env.AO_TEST_MODE === "1";
export const testAddress = () => (process.env.AO_TEST_EMAIL ?? "").trim();
export function inTestMode(mail: QuoteEmail): QuoteEmail {
  return { ...mail, to: testAddress(), subject: `[טסט] ${mail.subject}`, text: `[מצב טסט: ההודעה נועדה במקור אל ${mail.to}, ונשלחה לכתובת הבדיקה בלבד.]

${mail.text}`, html: mail.html ? `<p dir="rtl">[מצב טסט: ההודעה נועדה במקור אל ${mail.to}, ונשלחה לכתובת הבדיקה בלבד.]</p>${mail.html}` : mail.html };
}
