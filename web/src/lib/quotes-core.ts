// Quote logic: totals, versions, sending, approval and conversion to an order. No dependency on Next.js.
import { randomBytes } from "node:crypto";
import type { Q } from "./auth-core.ts";
import { CatalogError, checkVariants } from "./catalog-core.ts";

export * from "./quote-totals.ts";
import { computeTotals, VAT_RATE, DEFAULT_VALID_DAYS, type LineInput, type Totals } from "./quote-totals.ts";

export type DraftInput = {
  lines: LineInput[];
  discountPct: number;
  deliveryFee: number;
  deliveryDate: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  addressId: string | null;
  customerNotes: string | null;
  internalNotes: string | null;
  validUntil: string | null;
  paymentTerms: string | null;
};

export class QuoteError extends Error {}

const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: string | null | undefined): s is string => !!s && /^\d{2}:\d{2}$/.test(s);
const pct = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100;

export function validateDraft(d: DraftInput): string | null {
  if (!pct(d.discountPct)) return "ההנחה הכללית צריכה להיות בין 0 ל-100.";
  if (!Number.isFinite(d.deliveryFee) || d.deliveryFee < 0) return "דמי המשלוח אינם תקינים.";
  if (d.deliveryDate && !isDate(d.deliveryDate)) return "תאריך האספקה אינו תקין.";
  if ((d.windowFrom && !isTime(d.windowFrom)) || (d.windowTo && !isTime(d.windowTo))) return "שעת האספקה אינה תקינה.";
  if (d.validUntil && !isDate(d.validUntil)) return "תאריך התוקף אינו תקין.";
  for (const [i, l] of d.lines.entries()) {
    const n = i + 1;
    if (!l.sku) return `שורה ${n}: יש לבחור מוצר.`;
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) return `שורה ${n}: הכמות צריכה להיות גדולה מאפס.`;
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) return `שורה ${n}: המחיר אינו תקין.`;
    if (!pct(l.discountPct ?? 0)) return `שורה ${n}: ההנחה צריכה להיות בין 0 ל-100.`;
    if (l.deliveryDate && !isDate(l.deliveryDate)) return `שורה ${n}: תאריך האספקה אינו תקין.`;
  }
  return null;
}

type VersionRow = { id: string; version: number; sent_at: string | null; approved_at: string | null };

async function latestVersion(q: Q, quoteId: string): Promise<VersionRow> {
  const [v] = await q<VersionRow>("select id::text, version, sent_at::text, approved_at::text from quote_versions where quote_id = $1 order by version desc limit 1", [quoteId]);
  if (!v) throw new QuoteError("ההצעה לא נמצאה.");
  return v;
}

export async function createQuote(q: Q, customerId: string, ownerId: string, leadId: string | null = null): Promise<{ quoteId: string; number: number }> {
  const [c] = await q<{ payment_terms: string | null }>("select payment_terms from customers where id = $1 and active", [customerId]);
  if (!c) throw new QuoteError("הלקוח לא נמצא.");
  const [quote] = await q<{ id: string; number: number }>(
    `insert into quotes (customer_id, lead_id, owner_id, payment_terms, valid_until)
     values ($1, $2, $3, $4, current_date + ${DEFAULT_VALID_DAYS}) returning id::text, number`,
    [customerId, leadId, ownerId, c.payment_terms],
  );
  await q("insert into quote_versions (quote_id, version, vat_rate, total_before_vat, total_vat, total) values ($1, 1, $2, 0, 0, 0)", [quote.id, VAT_RATE]);
  return { quoteId: quote.id, number: quote.number };
}

/**
 * Saves the working draft. A version that was already sent is frozen: saving after that opens the next
 * version and leaves the sent one exactly as the customer saw it.
 */
export async function saveDraft(q: Q, quoteId: string, d: DraftInput): Promise<{ versionId: string; version: number; totals: Totals }> {
  const problem = validateDraft(d);
  if (problem) throw new QuoteError(problem);
  const [quote] = await q<{ status: string; customer_id: string; vat_exempt: boolean }>(
    "select qt.status::text, qt.customer_id::text, c.vat_exempt from quotes qt join customers c on c.id = qt.customer_id where qt.id = $1",
    [quoteId],
  );
  if (!quote) throw new QuoteError("ההצעה לא נמצאה.");
  if (quote.status === "approved") throw new QuoteError("הצעה שאושרה אינה ניתנת לשינוי. שינויים נעשים בהזמנה.");

  for (const l of d.lines) {
    const [p] = await q("select 1 from products where sku = $1", [l.sku]);
    if (!p) throw new QuoteError(`המק״ט ${l.sku} אינו קיים בקטלוג.`);
  }
  if (d.addressId) {
    const [a] = await q("select 1 from customer_addresses where id = $1 and customer_id = $2", [d.addressId, quote.customer_id]);
    if (!a) throw new QuoteError("כתובת האספקה אינה שייכת ללקוח.");
  }
  try {
    await checkVariants(q, d.lines);
  } catch (e) {
    throw new QuoteError(e instanceof CatalogError ? e.message : "בדיקת הסוגים נכשלה.");
  }

  let v = await latestVersion(q, quoteId);
  if (v.sent_at) {
    const [next] = await q<{ id: string; version: number }>(
      "insert into quote_versions (quote_id, version, vat_rate, total_before_vat, total_vat, total) values ($1, $2, $3, 0, 0, 0) returning id::text, version",
      [quoteId, v.version + 1, VAT_RATE],
    );
    v = { id: next.id, version: next.version, sent_at: null, approved_at: null };
    await q("update quotes set status = 'draft' where id = $1", [quoteId]);
  }

  const totals = computeTotals(d.lines, d.discountPct, d.deliveryFee, VAT_RATE, quote.vat_exempt);
  await q(
    `update quote_versions set discount_pct = $2, delivery_fee = $3, vat_rate = $4, total_before_vat = $5, total_vat = $6, total = $7,
       customer_notes = $8, internal_notes = $9, delivery_date = $10::date, window_from = $11::time, window_to = $12::time, address_id = $13
     where id = $1`,
    [v.id, d.discountPct, d.deliveryFee, VAT_RATE, totals.beforeVat, totals.vat, totals.total, d.customerNotes, d.internalNotes, d.deliveryDate, d.windowFrom, d.windowTo, d.addressId],
  );
  await q("update quotes set valid_until = $2::date, payment_terms = $3 where id = $1", [quoteId, d.validUntil, d.paymentTerms]);
  await q("delete from quote_lines where quote_version_id = $1", [v.id]);
  for (const [i, l] of d.lines.entries()) {
    await q(
      `insert into quote_lines (quote_version_id, position, sku, variant_id, description, quantity, unit_price, discount_pct, delivery_date, vat_exempt)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10)`,
      [v.id, i + 1, l.sku, l.variantId ?? null, l.description.trim() || l.sku, l.quantity, l.unitPrice, l.discountPct ?? 0, l.deliveryDate ?? null, l.vatExempt ?? false],
    );
  }
  return { versionId: v.id, version: v.version, totals };
}

/** Freezes the current draft version and issues the customer's approval link. */
export async function sendQuote(q: Q, quoteId: string): Promise<{ versionId: string; version: number; token: string }> {
  const v = await latestVersion(q, quoteId);
  if (v.sent_at) throw new QuoteError("הגרסה הזו כבר נשלחה. כדי לשלוח שוב יש לערוך ולשמור גרסה חדשה.");
  const [n] = await q<{ n: number; missing_date: number }>(
    `select count(*)::int as n, count(*) filter (where l.delivery_date is null and v.delivery_date is null)::int as missing_date
     from quote_lines l join quote_versions v on v.id = l.quote_version_id where v.id = $1`,
    [v.id],
  );
  if (n.n === 0) throw new QuoteError("אי אפשר לשלוח הצעה בלי שורות.");
  if (n.missing_date > 0) throw new QuoteError("יש לקבוע תאריך אספקה להצעה, או לכל שורה, לפני השליחה.");
  const token = randomBytes(24).toString("base64url");
  await q("update quote_versions set sent_at = now(), public_token = $2 where id = $1", [v.id, token]);
  // Links of earlier versions stop working: only the latest sent version can be approved.
  await q("update quote_versions set public_token = null where quote_id = $1 and id <> $2", [quoteId, v.id]);
  await q("update quotes set status = 'sent' where id = $1", [quoteId]);
  return { versionId: v.id, version: v.version, token };
}

export type Approval = { method: "link" | "manual"; name: string; userId?: string | null };
export type ApproveResult = { orderId: string; orderNumber: number; alreadyApproved: boolean };

/**
 * Approves the latest sent version and opens an order with the agreed prices. One delivery is created per
 * delivery date. Calling it again for the same version returns the order that already exists.
 */
export async function approveQuote(q: Q, quoteId: string, versionId: string, approval: Approval, today?: string): Promise<ApproveResult> {
  const [quote] = await q<{ status: string; customer_id: string; owner_id: string | null; valid_until: string | null; today: string }>(
    "select status::text, customer_id::text, owner_id::text, valid_until::text, coalesce($2::date, (now() at time zone 'Asia/Jerusalem')::date)::text as today from quotes where id = $1",
    [quoteId, today ?? null],
  );
  if (!quote) throw new QuoteError("ההצעה לא נמצאה.");

  const [existing] = await q<{ id: string; number: number }>("select id::text, number from orders where quote_version_id = $1", [versionId]);
  if (existing) return { orderId: existing.id, orderNumber: existing.number, alreadyApproved: true };

  const latest = await latestVersion(q, quoteId);
  if (latest.id !== versionId) throw new QuoteError("ההצעה עודכנה מאז. יש לאשר את הגרסה העדכנית.");
  if (!latest.sent_at) throw new QuoteError("אי אפשר לאשר גרסה שעוד לא נשלחה.");
  if (quote.status === "rejected") throw new QuoteError("ההצעה נסגרה כנדחתה.");
  if (approval.method === "link" && quote.valid_until && quote.valid_until < quote.today) throw new QuoteError("תוקף ההצעה פג. אפשר לבקש הצעה מעודכנת.");
  if (approval.name.trim().length < 2) throw new QuoteError("יש להזין את שם המאשר.");

  const [v] = await q<{ discount_pct: string; delivery_fee: string; vat_rate: string; delivery_date: string | null; window_from: string | null; window_to: string | null; address_id: string | null; customer_notes: string | null }>(
    "select discount_pct::text, delivery_fee::text, vat_rate::text, delivery_date::text, window_from::text, window_to::text, address_id::text, customer_notes from quote_versions where id = $1",
    [versionId],
  );
  const lines = await q<{ sku: string; variant_id: number | null; quantity: string; unit_price: string; discount_pct: string; delivery_date: string | null }>(
    "select sku, variant_id, quantity::text, unit_price::text, discount_pct::text, delivery_date::text from quote_lines where quote_version_id = $1 order by position",
    [versionId],
  );

  await q("update quote_versions set approved_at = now(), approved_by_name = $2, approval_method = $3 where id = $1", [versionId, approval.name.trim(), approval.method]);
  await q("update quotes set status = 'approved' where id = $1", [quoteId]);

  const [order] = await q<{ id: string; number: number }>(
    `insert into orders (customer_id, source, quote_version_id, owner_id, discount_pct, vat_rate, delivery_fee, notes)
     values ($1, 'quote', $2, $3, $4, $5, $6, $7) returning id::text, number`,
    [quote.customer_id, versionId, quote.owner_id, v.discount_pct, v.vat_rate, v.delivery_fee, v.customer_notes],
  );
  let addressSnapshot: string | null = null;
  if (v.address_id) {
    const [a] = await q<{ street: string; city: string | null }>("select street, city from customer_addresses where id = $1", [v.address_id]);
    if (a) addressSnapshot = [a.street, a.city].filter(Boolean).join(", ");
  }
  const byDate = new Map<string, typeof lines>();
  for (const l of lines) {
    const date = l.delivery_date ?? v.delivery_date;
    if (!date) throw new QuoteError("חסר תאריך אספקה באחת השורות.");
    byDate.set(date, [...(byDate.get(date) ?? []), l]);
  }
  for (const [date, group] of [...byDate.entries()].sort()) {
    const [delivery] = await q<{ id: string }>(
      `insert into deliveries (order_id, delivery_date, window_from, window_to, address_id, address_snapshot, status)
       values ($1, $2::date, $3::time, $4::time, $5, $6, 'approved') returning id::text`,
      [order.id, date, v.window_from, v.window_to, v.address_id, addressSnapshot],
    );
    for (const l of group) {
      await q("insert into delivery_lines (delivery_id, sku, variant_id, quantity, unit_price, discount_pct) values ($1, $2, $3, $4, $5, $6)", [delivery.id, l.sku, l.variant_id, l.quantity, l.unit_price, l.discount_pct]);
    }
  }
  if (approval.userId) {
    await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'approve_quote', 'quote', $2, $3)", [approval.userId, quoteId, JSON.stringify({ versionId, orderId: order.id, method: approval.method, name: approval.name.trim() })]);
  }
  return { orderId: order.id, orderNumber: order.number, alreadyApproved: false };
}

export async function rejectQuote(q: Q, quoteId: string, reason: string): Promise<void> {
  const [quote] = await q<{ status: string }>("select status::text from quotes where id = $1", [quoteId]);
  if (!quote) throw new QuoteError("ההצעה לא נמצאה.");
  if (quote.status === "approved") throw new QuoteError("הצעה שאושרה אינה יכולה להיסגר כנדחתה.");
  if (reason.trim().length < 2) throw new QuoteError("יש לבחור סיבה.");
  await q("update quotes set status = 'rejected', lost_reason = $2 where id = $1", [quoteId, reason.trim()]);
  await q("update quote_versions set public_token = null where quote_id = $1", [quoteId]);
}

/** Looks up a quote by the customer's link. Returns null for an unknown, replaced or withdrawn link. */
export async function findByToken(q: Q, token: string): Promise<{ quoteId: string; versionId: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [r] = await q<{ quote_id: string; id: string }>("select quote_id::text, id::text from quote_versions where public_token = $1", [token]);
  return r ? { quoteId: r.quote_id, versionId: r.id } : null;
}
