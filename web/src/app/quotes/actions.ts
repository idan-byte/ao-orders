"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { query, withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { approveQuote, createQuote, findByToken, QuoteError, rejectQuote, saveDraft, sendQuote, type DraftInput } from "@/lib/quotes-core";

export type QuoteActionState = { error?: string; ok?: string };

const message = (e: unknown) => (e instanceof QuoteError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");

async function audit(userId: string, action: string, quoteId: string, after: unknown) {
  await query("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'quote', $3, $4)", [userId, action, quoteId, JSON.stringify(after)]);
}

export async function createQuoteAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const user = await assertPermission("quotes.edit");
  const customerId = String(formData.get("customer_id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) return { error: "יש לבחור לקוח." };
  let quoteId: string;
  try {
    const created = await withTransaction((q) => createQuote(q, customerId, user.id));
    quoteId = created.quoteId;
    await audit(user.id, "create_quote", quoteId, { customerId, number: created.number });
  } catch (e) {
    return { error: message(e) };
  }
  redirect(`/quotes/${quoteId}`);
}

function parseDraft(raw: string): DraftInput | null {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
    const lines = Array.isArray(p.lines) ? p.lines : [];
    return {
      lines: lines.map((l: Record<string, unknown>) => ({
        sku: String(l.sku ?? ""),
        variantId: null,
        description: String(l.description ?? ""),
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        discountPct: Number(l.discountPct ?? 0),
        deliveryDate: str(l.deliveryDate),
        vatExempt: l.vatExempt === true,
      })),
      discountPct: Number(p.discountPct ?? 0),
      deliveryFee: Number(p.deliveryFee ?? 0),
      deliveryDate: str(p.deliveryDate),
      windowFrom: str(p.windowFrom),
      windowTo: str(p.windowTo),
      addressId: str(p.addressId),
      customerNotes: str(p.customerNotes),
      internalNotes: str(p.internalNotes),
      validUntil: str(p.validUntil),
      paymentTerms: str(p.paymentTerms),
    };
  } catch {
    return null;
  }
}

export async function saveQuoteAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const user = await assertPermission("quotes.edit");
  const quoteId = String(formData.get("quote_id") ?? "");
  const send = formData.get("intent") === "send";
  const draft = parseDraft(String(formData.get("payload") ?? ""));
  if (!draft) return { error: "הנתונים שנשלחו אינם תקינים." };

  // The VAT-exempt flag of a line comes from the catalog, never from the browser.
  const exempt = new Set((await query<{ sku: string }>("select sku from products where vat_exempt")).map((r) => r.sku));
  draft.lines = draft.lines.map((l) => ({ ...l, vatExempt: exempt.has(l.sku) }));

  try {
    const result = await withTransaction(async (q) => {
      const saved = await saveDraft(q, quoteId, draft);
      const sent = send ? await sendQuote(q, quoteId) : null;
      return { saved, sent };
    });
    await audit(user.id, send ? "send_quote" : "save_quote", quoteId, { version: result.saved.version, total: result.saved.totals.total });
    refresh();
    return { ok: send ? `גרסה ${result.saved.version} נשלחה ונעולה לשינויים.` : `הטיוטה נשמרה (גרסה ${result.saved.version}).` };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function approveManualAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const user = await assertPermission("quotes.approve");
  const quoteId = String(formData.get("quote_id") ?? "");
  const versionId = String(formData.get("version_id") ?? "");
  const name = String(formData.get("name") ?? "");
  try {
    const r = await withTransaction((q) => approveQuote(q, quoteId, versionId, { method: "manual", name, userId: user.id }));
    refresh();
    return { ok: `ההצעה אושרה ונפתחה הזמנה ${r.orderNumber}.` };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function rejectQuoteAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const user = await assertPermission("quotes.edit");
  const quoteId = String(formData.get("quote_id") ?? "");
  const reason = String(formData.get("reason") ?? "");
  try {
    await withTransaction((q) => rejectQuote(q, quoteId, reason));
    await audit(user.id, "reject_quote", quoteId, { reason });
    refresh();
    return { ok: "ההצעה נסגרה כנדחתה." };
  } catch (e) {
    return { error: message(e) };
  }
}

/** Public: the customer approves through the link. No login; the secret link is the authorisation. */
export async function approveByLinkAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "");
  const found = await findByToken(query, token);
  if (!found) return { error: "הקישור אינו בתוקף. ייתכן שההצעה עודכנה. אפשר לפנות אלינו לקבלת קישור חדש." };
  try {
    await withTransaction((q) => approveQuote(q, found.quoteId, found.versionId, { method: "link", name }));
    await query("insert into audit_log (action, entity_type, entity_id, after) values ('approve_quote_by_link', 'quote', $1, $2)", [found.quoteId, JSON.stringify({ versionId: found.versionId, name: name.trim() })]);
    refresh();
    return { ok: "תודה, ההצעה אושרה." };
  } catch (e) {
    return { error: message(e) };
  }
}
