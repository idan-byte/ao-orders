"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { query, withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { logQuoteEvent } from "@/lib/crm-core";
import { loadQuoteDoc } from "@/lib/quotes-data";
import { buildQuoteEmail, MailError, recordEmail } from "@/lib/mail-core";
import { sendEmail } from "@/lib/mail";
import { getOutgoing, mailSender } from "@/lib/comm-core";
import { renderQuotePdf } from "@/lib/quote-pdf";

type State = { error?: string; ok?: string };

/**
 * Emails the version that is waiting for the customer, with the PDF attached. A person presses the button
 * and sees the recipient and the text first: the system never sends a quote by itself.
 */
export async function emailQuoteAction(_prev: State, fd: FormData): Promise<State> {
  const user = await assertPermission("quotes.edit");
  const quoteId = String(fd.get("quote_id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) return { error: "ההצעה לא נמצאה." };
  const [v] = await query<{ id: string; version: number; public_token: string | null; status: string }>(
    `select v.id::text, v.version, v.public_token, qt.status::text from quote_versions v join quotes qt on qt.id = v.quote_id
     where v.quote_id = $1 and v.sent_at is not null order by v.version desc limit 1`,
    [quoteId],
  );
  if (!v || v.status !== "sent" || !v.public_token) return { error: "אפשר לשלוח במייל רק הצעה שננעלה לשליחה וממתינה ללקוח." };
  const doc = await loadQuoteDoc(v.id);
  if (!doc) return { error: "ההצעה לא נמצאה." };

  // The approval link is included only when the system has an address customers can reach.
  const publicBase = (process.env.AO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  let mail;
  try {
    mail = buildQuoteEmail({
      to: String(fd.get("to") ?? ""),
      number: doc.number,
      customerName: doc.customerName,
      senderName: user.fullName,
      businessName: doc.letterhead.title,
      message: String(fd.get("message") ?? ""),
      approvalUrl: publicBase ? `${publicBase}/q/${v.public_token}` : null,
    });
  } catch (e) {
    return { error: e instanceof MailError ? e.message : "ההודעה אינה תקינה." };
  }

  const filename = `quote-${doc.number}-v${doc.version}.pdf`;
  let pdf: Buffer;
  try {
    const origin = process.env.AO_INTERNAL_BASE_URL || `http://${(await headers()).get("host")}`;
    pdf = await renderQuotePdf(v.id, origin);
  } catch (e) {
    console.error("[quote email] pdf", e);
    return { error: "יצירת ה-PDF נכשלה, ולכן המייל לא נשלח." };
  }
  const [{ id: saveAs }] = await query<{ id: string }>("select gen_random_uuid()::text as id");
  const result = await sendEmail(mail, [{ filename, content: pdf, contentType: "application/pdf" }], saveAs, mailSender(await getOutgoing(query)));
  await withTransaction(async (q) => {
    await recordEmail(q, { entityType: "quote", entityId: quoteId, to: mail.to, subject: mail.subject, body: mail.text, attachment: filename, status: result.status, error: result.error, userId: user.id });
    if (result.status === "sent") await logQuoteEvent(q, quoteId, `הצעת מחיר ${doc.number} (גרסה ${doc.version}) נשלחה במייל אל ${mail.to}`, user.id);
  });
  refresh();
  if (result.status === "failed") return { error: `המייל לא נשלח: ${result.error}` };
  if (result.status === "not_sent_dev") return { ok: "לא הוגדר שרת דואר, ולכן המייל לא נשלח. ההודעה וה-PDF נשמרו בתיקיית outbox לבדיקה." };
  return { ok: `המייל נשלח אל ${mail.to}.` };
}
