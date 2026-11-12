// What a quote email says, and the record kept of every email. No dependency on Next.js or on a mail server.
import type { Q } from "./auth-core.ts";

export class MailError extends Error {}

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const isEmail = (v: string) => v.length <= 254 && EMAIL.test(v);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type QuoteEmailInput = { to: string; number: number; customerName: string; senderName: string; businessName: string; message: string | null; approvalUrl: string | null };
export type QuoteEmail = { to: string; subject: string; text: string; html: string };

/** Builds the email. The employee's own words come first; the approval link is added only when the system has a public address. */
export function buildQuoteEmail(i: QuoteEmailInput): QuoteEmail {
  const to = i.to.trim();
  if (!isEmail(to)) throw new MailError("כתובת המייל אינה תקינה.");
  const message = (i.message ?? "").trim();
  if (message.length > 2000) throw new MailError("ההודעה ארוכה מדי (עד 2,000 תווים).");
  const subject = `הצעת מחיר ${i.number} · ${i.businessName}`;
  const paragraphs = [
    "שלום,",
    message || `מצורפת הצעת מחיר ${i.number} עבור ${i.customerName}.`,
    ...(i.approvalUrl ? [`לצפייה בהצעה ולאישורה: ${i.approvalUrl}`] : []),
    "ההצעה מצורפת כקובץ PDF.",
    `בברכה,\n${i.senderName}\n${i.businessName}`,
  ];
  const text = paragraphs.join("\n\n");
  const html =
    `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">` +
    paragraphs
      .map((p) => {
        const body = esc(p).replace(/\n/g, "<br>");
        return i.approvalUrl && p.includes(i.approvalUrl) ? `<p>לצפייה בהצעה ולאישורה: <a href="${esc(i.approvalUrl)}">${esc(i.approvalUrl)}</a></p>` : `<p>${body}</p>`;
      })
      .join("") +
    `</div>`;
  return { to, subject, text, html };
}

export type EmailStatus = "sent" | "not_sent_dev" | "failed";

export async function recordEmail(q: Q, e: { entityType: string; entityId: string; to: string; subject: string; body: string; attachment: string | null; status: EmailStatus; error: string | null; userId: string | null }): Promise<string> {
  const [row] = await q<{ id: string }>(
    "insert into emails (entity_type, entity_id, to_address, subject, body, attachment, status, error, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text",
    [e.entityType, e.entityId, e.to, e.subject, e.body, e.attachment, e.status, e.error?.slice(0, 500) ?? null, e.userId],
  );
  return row.id;
}

export type EmailRow = { id: string; to: string; subject: string; status: EmailStatus; error: string | null; at: string; by: string | null };

export async function emailsOf(q: Q, entityType: string, entityId: string): Promise<EmailRow[]> {
  return q<EmailRow>(
    `select e.id::text, e.to_address as to, e.subject, e.status, e.error, e.created_at::text as at, u.full_name as by
     from emails e left join users u on u.id = e.created_by where e.entity_type = $1 and e.entity_id = $2 order by e.created_at desc limit 20`,
    [entityType, entityId],
  );
}
