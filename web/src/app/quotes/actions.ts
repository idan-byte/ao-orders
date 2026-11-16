"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { query, withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { logQuoteEvent } from "@/lib/crm-core";
import { approveQuote, createQuote, findByToken, QuoteError, rejectQuote, saveDraft, sendQuote, type DraftInput } from "@/lib/quotes-core";
import { createLocalCustomer, CustomerError } from "@/lib/customers-core";

export type QuoteActionState = { error?: string; ok?: string; id?: string; text?: string };

const message = (e: unknown) => (e instanceof QuoteError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");

async function audit(userId: string, action: string, quoteId: string, after: unknown) {
  await query("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'quote', $3, $4)", [userId, action, quoteId, JSON.stringify(after)]);
}

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

/** A customer typed from the quote screen: a name is enough. The new customer is marked until it is entered in Hashavshevet. */
export async function createCustomerAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const user = await assertPermission("quotes.edit");
  try {
    const r = await withTransaction((q) => createLocalCustomer(q, { name: text(formData, "name"), taxId: text(formData, "tax_id") || null, phone: text(formData, "phone") || null, email: text(formData, "email") || null }));
    await query("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'create_customer', 'customer', $2, $3)", [user.id, r.customerId, JSON.stringify({ source: "quote" })]);
    refresh();
    return { ok: "הלקוח נוצר. הוא ממתין להיכנס לחשבשבת.", id: r.customerId, text: text(formData, "name").replace(/\s+/g, " ") };
  } catch (e) {
    if (e instanceof CustomerError) return { error: e.message };
    console.error("[create customer]", e instanceof Error ? e.name : "error");
    return { error: "יצירת הלקוח נכשלה. שום דבר לא נשמר." };
  }
}

/** A delivery address added from the quote: the customer's addresses grow, and the quote can use the new one at once. */
export async function addQuoteAddressAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const user = await assertPermission("quotes.edit");
  const customerId = text(formData, "customer_id");
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) return { error: "הלקוח לא נמצא." };
  const street = text(formData, "street");
  const city = text(formData, "city");
  const area = text(formData, "delivery_area");
  const label = text(formData, "label");
  if (street.length < 2) return { error: "יש להזין כתובת." };
  try {
    const [first] = await query<{ n: number }>("select count(*)::int as n from customer_addresses where customer_id = $1", [customerId]);
    const [created] = await query<{ id: string; text: string }>(
      "insert into customer_addresses (customer_id, label, street, city, delivery_area, is_default) values ($1, $2, $3, $4, $5, $6) returning id::text, concat_ws(', ', street, city) as text",
      [customerId, label || null, street, city || null, area || null, first.n === 0],
    );
    await query("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'add_address', 'customer', $2, $3)", [user.id, customerId, JSON.stringify({ addressId: created.id, street, city, from: "quote" })]);
    refresh();
    return { ok: "הכתובת נוספה.", id: created.id, text: created.text };
  } catch (e) {
    console.error("[add quote address]", e instanceof Error ? e.name : "error");
    return { error: "הכתובת לא נשמרה." };
  }
}

export async function createQuoteAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const user = await assertPermission("quotes.edit");
  const customerId = String(formData.get("customer_id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) return { error: "יש לבחור לקוח." };
  const leadRaw = String(formData.get("lead_id") ?? "");
  const leadId = /^[0-9a-f-]{36}$/i.test(leadRaw) ? leadRaw : null;
  if (leadId) {
    const [lead] = await query("select 1 from leads where id = $1 and customer_id = $2", [leadId, customerId]);
    if (!lead) return { error: "הפנייה אינה שייכת ללקוח הזה." };
  }
  let quoteId: string;
  try {
    const created = await withTransaction(async (q) => {
      const c = await createQuote(q, customerId, user.id, leadId);
      await logQuoteEvent(q, c.quoteId, `נפתחה הצעת מחיר ${c.number}`, user.id);
      return c;
    });
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
        variantId: Number.isInteger(l.variantId) ? (l.variantId as number) : null,
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
      if (sent) await logQuoteEvent(q, quoteId, `הצעת מחיר נשלחה (גרסה ${sent.version}, ${saved.totals.total.toFixed(2)} ש״ח כולל מע״מ)`, user.id);
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
    const r = await withTransaction(async (q) => {
      const res = await approveQuote(q, quoteId, versionId, { method: "manual", name, userId: user.id });
      if (!res.alreadyApproved) await logQuoteEvent(q, quoteId, `הצעת מחיר אושרה ידנית (${name.trim()}). נפתחה הזמנה ${res.orderNumber}`, user.id);
      return res;
    });
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
    await withTransaction(async (q) => {
      await rejectQuote(q, quoteId, reason);
      await logQuoteEvent(q, quoteId, `הצעת מחיר נסגרה כנדחתה: ${reason.trim()}`, user.id);
    });
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
    await withTransaction(async (q) => {
      const res = await approveQuote(q, found.quoteId, found.versionId, { method: "link", name });
      if (!res.alreadyApproved) await logQuoteEvent(q, found.quoteId, `הלקוח אישר את ההצעה בקישור (${name.trim()}). נפתחה הזמנה ${res.orderNumber}`, null);
    });
    await query("insert into audit_log (action, entity_type, entity_id, after) values ('approve_quote_by_link', 'quote', $1, $2)", [found.quoteId, JSON.stringify({ versionId: found.versionId, name: name.trim() })]);
    refresh();
    return { ok: "תודה, ההצעה אושרה." };
  } catch (e) {
    return { error: message(e) };
  }
}
