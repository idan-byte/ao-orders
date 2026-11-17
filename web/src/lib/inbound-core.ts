// Incoming mail: what is kept of a message, the recommendation the AI made for it, and a person's approval that
// turns the recommendation into a quote draft or an order. Prices never come from the mail or from the AI: every
// line is priced by the customer's agreement, or the base price, exactly as in a document typed by hand.
// No dependency on Next.js, on the mail server or on the AI.
import type { Q } from "./auth-core.ts";
import { addActivity } from "./crm-core.ts";
import { resolvePrice } from "./customers-core.ts";
import { createOrder } from "./orders-core.ts";
import { createQuote, saveDraft, type DraftInput } from "./quotes-core.ts";
import { DEFAULT_VALID_DAYS } from "./quote-totals.ts";

export class InboundError extends Error {}

export type InboundKind = "quote_request" | "order" | "other";
export const KIND_LABEL: Record<InboundKind, string> = { quote_request: "בקשה להצעת מחיר", order: "הזמנה", other: "לא רלוונטי" };

export type Attachment = { name: string; size: number; mime: string };
export type RawMail = {
  mailbox: string;
  messageId: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  receivedAt: string;
  body: string;
  attachments: Attachment[];
  /** The content of the attachments that are kept (not every attachment is, see inbound-mail.ts). */
  files?: { name: string; mime: string; data: Buffer }[];
};

/** One line the sender asked for: their words, and the catalogue item it was matched to (never an item that does not exist). */
// `suggestion` is set when the line is a product the system proposes for a general request ("כיבוד"): the reason, in Hebrew.
export type AnalysisItem = { text: string; quantity: number | null; unit: string | null; sku: string | null; certain: boolean; candidates: { sku: string; name: string }[]; suggestion?: string | null };
export type Analysis = {
  kind: InboundKind;
  summary: string;
  deliveryDate: string | null;
  deliveryNote: string | null;
  items: AnalysisItem[];
  /** Names of the attached files that the AI read. */
  filesRead?: string[];
  /** Set when the attached files could not be read and the message was sorted from its text only. */
  filesNote?: string | null;
};

// The kinds of attached file the AI can read, and the largest size of each it accepts.
const READABLE: Record<string, number> = { "application/pdf": 10 * 1024 * 1024, "image/jpeg": 5 * 1024 * 1024, "image/png": 5 * 1024 * 1024, "image/gif": 5 * 1024 * 1024, "image/webp": 5 * 1024 * 1024 };
export const readableByAi = (mime: string, size: number): boolean => READABLE[mime] !== undefined && size <= READABLE[mime];

const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());

export async function isKnown(q: Q, messageId: string): Promise<boolean> {
  const [r] = await q("select 1 from inbound_emails where message_id = $1", [messageId]);
  return !!r;
}

/** The customer a sender belongs to: the one customer that has a contact with this email address. */
export async function customerOfSender(q: Q, email: string): Promise<string | null> {
  const rows = await q<{ id: string }>("select distinct c.id::text as id from customer_contacts cc join customers c on c.id = cc.customer_id where lower(btrim(cc.email)) = lower($1) and c.active", [email.trim()]);
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * Catalogue items whose name shares words with what the sender wrote, best first. Only items that can be ordered.
 * Items the customer has an agreed price for come first among equals.
 */
export async function productCandidates(q: Q, text: string, customerId: string | null, limit = 8): Promise<{ sku: string; name: string }[]> {
  const words = [...new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s%]/gu, " ").split(/\s+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w)))].slice(0, 12);
  if (words.length === 0) return [];
  const rows = await q<{ sku: string; name: string; mine: boolean }>(
    `select p.sku, p.name, exists (select 1 from customer_prices cp where cp.customer_id = $2 and cp.sku = p.sku and cp.approved_at is not null) as mine
     from products p join product_ops o on o.sku = p.sku
     where o.orderable and p.hash_active and lower(p.name) like any($1)`,
    [words.map((w) => `%${w.replace(/[%_\\]/g, "\\$&")}%`), customerId],
  );
  const score = (name: string) => words.filter((w) => name.toLowerCase().includes(w)).length;
  return rows
    .map((r) => ({ r, s: score(r.name) }))
    .sort((a, b) => b.s - a.s || Number(b.r.mine) - Number(a.r.mine) || a.r.name.length - b.r.name.length || a.r.sku.localeCompare(b.r.sku))
    .slice(0, limit)
    .map(({ r }) => ({ sku: r.sku, name: r.name }));
}

/**
 * Keeps a message with its recommendation. A message that is neither a request nor an order keeps no body and
 * needs no handling. Returns the new id, or null when the message was already kept.
 */
export async function storeMail(q: Q, mail: RawMail, analysis: Analysis): Promise<string | null> {
  if (await isKnown(q, mail.messageId)) return null;
  const relevant = analysis.kind !== "other";
  const customerId = relevant ? await customerOfSender(q, mail.fromEmail) : null;
  const [r] = await q<{ id: string }>(
    `insert into inbound_emails (mailbox, message_id, from_email, from_name, subject, received_at, body, attachments, kind, status, customer_id, analysis)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12) returning id::text`,
    [mail.mailbox, mail.messageId, mail.fromEmail.toLowerCase(), mail.fromName, mail.subject.slice(0, 300), mail.receivedAt, relevant ? mail.body.slice(0, 20000) : null, JSON.stringify(relevant ? mail.attachments.slice(0, 20) : []), analysis.kind, relevant ? "new" : "dismissed", customerId, JSON.stringify(relevant ? analysis : { kind: "other", summary: analysis.summary })],
  );
  if (relevant) {
    const read = analysis.filesRead ?? [];
    for (const f of (mail.files ?? []).slice(0, 20)) {
      await q("insert into inbound_files (inbound_id, name, mime, size, read_by_ai, data) values ($1, $2, $3, $4, $5, $6)", [r.id, f.name.slice(0, 300), f.mime.slice(0, 100), f.data.length, read.includes(f.name), f.data]);
    }
  }
  return r.id;
}

export type InboundFile = { id: string; name: string; mime: string; size: number; readByAi: boolean };

/** The kept file of a request or an order, for a person to open. */
export async function inboundFile(q: Q, id: string): Promise<{ name: string; mime: string; data: Buffer } | null> {
  if (!isUuid(id)) return null;
  const [r] = await q<{ name: string; mime: string; data: Uint8Array }>("select name, mime, data from inbound_files where id = $1", [id]);
  return r ? { name: r.name, mime: r.mime, data: Buffer.from(r.data) } : null;
}

/** The catalogue items that can be ordered, for the AI to propose from when a request names no product. */
export async function orderableCatalogue(q: Q, limit = 1500): Promise<{ sku: string; name: string }[]> {
  return q<{ sku: string; name: string }>("select p.sku, p.name from products p join product_ops o on o.sku = p.sku where o.orderable and p.hash_active order by p.name limit $1", [limit]);
}

export type InboundRow = { id: string; fromEmail: string; fromName: string | null; subject: string; receivedAt: string; kind: InboundKind; status: "new" | "approved" | "dismissed"; customerId: string | null; customer: string | null; summary: string | null; lines: number; quoteId: string | null; quoteNumber: number | null; orderId: string | null; orderNumber: number | null };

const ROW = `e.id::text, e.from_email as "fromEmail", e.from_name as "fromName", e.subject, e.received_at::text as "receivedAt", e.kind, e.status, e.customer_id::text as "customerId", c.name as customer,
  e.analysis->>'summary' as summary, coalesce(jsonb_array_length(e.analysis->'items'), 0) as lines, e.quote_id::text as "quoteId", qt.number as "quoteNumber", e.order_id::text as "orderId", o.number as "orderNumber"`;
const FROM = "from inbound_emails e left join customers c on c.id = e.customer_id left join quotes qt on qt.id = e.quote_id left join orders o on o.id = e.order_id";

export async function listInbound(q: Q, status: "new" | "approved" | "dismissed", limit = 100): Promise<InboundRow[]> {
  // Mail that was never a request is not a "dismissed recommendation": it is left out of the lists.
  return q<InboundRow>(`select ${ROW} ${FROM} where e.status = $1 and e.kind <> 'other' order by e.received_at desc limit ${Math.min(Math.max(limit, 1), 500)}`, [status]);
}

export type InboundDetails = InboundRow & { body: string | null; attachments: Attachment[]; files: InboundFile[]; analysis: Analysis | null; dismissReason: string | null; handledBy: string | null; handledAt: string | null };

export async function getInbound(q: Q, id: string): Promise<InboundDetails | null> {
  if (!isUuid(id)) return null;
  const [r] = await q<InboundDetails>(`select ${ROW}, e.body, e.attachments, e.analysis, e.dismiss_reason as "dismissReason", u.full_name as "handledBy", e.handled_at::text as "handledAt" ${FROM} left join users u on u.id = e.handled_by where e.id = $1`, [id]);
  if (!r) return null;
  r.files = await q<InboundFile>(`select id::text, name, mime, size, read_by_ai as "readByAi" from inbound_files where inbound_id = $1 order by name, id`, [id]);
  return r;
}

export async function inboundCounts(q: Q): Promise<{ waiting: number; other: number }> {
  const [r] = await q<{ waiting: number; other: number }>("select count(*) filter (where status = 'new')::int as waiting, count(*) filter (where kind = 'other')::int as other from inbound_emails");
  return r;
}

/** `price` is typed by the person approving, for this document only. Null: the agreed price, or the base price. */
export type ApprovalLine = { sku: string; quantity: number; price: number | null };
export type Approval = { target: "quote" | "order"; customerId: string; deliveryDate: string | null; lines: ApprovalLine[] };

/**
 * A person approves a recommendation, as they corrected it: the customer, the lines and the date are theirs.
 * A quote is opened as a draft that was not sent; an order is opened approved, like one typed by an employee.
 */
/** The address a mail-made document starts with: the customer's default, or the only address they have. Otherwise none, and the person picks. */
export async function deliveryAddressOf(q: Q, customerId: string): Promise<string | null> {
  const rows = await q<{ id: string; is_default: boolean }>("select id::text, is_default from customer_addresses where customer_id = $1 order by is_default desc, id limit 2", [customerId]);
  if (rows.length === 0) return null;
  if (rows[0].is_default) return rows[0].id;
  return rows.length === 1 ? rows[0].id : null;
}

export async function approveInbound(q: Q, id: string, a: Approval, userId: string, today: string): Promise<{ quoteId?: string; orderId?: string; number: number }> {
  const [mail] = await q<{ status: string; kind: string; from_email: string; from_name: string | null; subject: string; received_at: string; summary: string | null }>(
    "select status, kind, from_email, from_name, subject, received_at::date::text as received_at, analysis->>'summary' as summary from inbound_emails where id = $1 for update",
    [id],
  );
  if (!mail) throw new InboundError("ההודעה לא נמצאה.");
  if (mail.status !== "new") throw new InboundError("ההמלצה הזאת כבר טופלה.");
  if (!isUuid(a.customerId)) throw new InboundError("יש לבחור לקוח.");
  if (a.deliveryDate !== null && !isDay(a.deliveryDate)) throw new InboundError("תאריך האספקה אינו תקין.");
  if (a.target === "order" && !a.deliveryDate) throw new InboundError("להזמנה צריך תאריך אספקה.");
  if (a.lines.length === 0) throw new InboundError("אי אפשר לאשר המלצה בלי שורות. מסמנים לפחות שורה אחת עם מוצר וכמות.");
  const priceDay = a.deliveryDate ?? today;
  const lines: DraftInput["lines"] = [];
  for (const [i, l] of a.lines.entries()) {
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) throw new InboundError(`שורה ${i + 1}: הכמות צריכה להיות גדולה מאפס.`);
    const [p] = await q<{ name: string; vat_exempt: boolean; orderable: boolean }>("select p.name, p.vat_exempt, coalesce(o.orderable, false) as orderable from products p left join product_ops o on o.sku = p.sku where p.sku = $1", [l.sku]);
    if (!p) throw new InboundError(`שורה ${i + 1}: המק״ט ${l.sku} אינו קיים בקטלוג.`);
    if (!p.orderable) throw new InboundError(`שורה ${i + 1}: ${p.name} אינו מוצר שאפשר להזמין.`);
    let unitPrice: number;
    if (l.price != null) {
      if (!Number.isFinite(l.price) || l.price < 0) throw new InboundError(`שורה ${i + 1}: המחיר אינו תקין.`);
      unitPrice = l.price;
    } else {
      const price = await resolvePrice(q, a.customerId, l.sku, priceDay);
      if (!price) throw new InboundError(`שורה ${i + 1}: לא נמצא מחיר ל-${p.name}. יש להזין מחיר ידנית בשורה.`);
      unitPrice = price.price;
    }
    lines.push({ sku: l.sku, description: p.name, quantity: l.quantity, unitPrice, discountPct: 0, deliveryDate: null, vatExempt: p.vat_exempt });
  }
  const origin = `נוצר ממייל של ${mail.from_name ? `${mail.from_name} ` : ""}<${mail.from_email}> מתאריך ${mail.received_at.split("-").reverse().join("/")}: ${mail.subject}`.slice(0, 500);
  // The same validity a quote typed by hand gets. Saving a draft replaces the date, so it is set here.
  const [valid] = await q<{ d: string }>(`select (current_date + ${DEFAULT_VALID_DAYS})::text as d`);
  const draft: DraftInput = { lines, discountPct: 0, deliveryFee: 0, deliveryDate: a.deliveryDate, windowFrom: null, windowTo: null, addressId: await deliveryAddressOf(q, a.customerId), customerNotes: null, internalNotes: origin, validUntil: a.target === "quote" ? valid.d : null, paymentTerms: null };

  if (a.target === "quote") {
    const { quoteId, number } = await createQuote(q, a.customerId, userId);
    await saveDraft(q, quoteId, draft);
    await q("update inbound_emails set status = 'approved', customer_id = $2, quote_id = $3, handled_by = $4, handled_at = now() where id = $1", [id, a.customerId, quoteId, userId]);
    await addActivity(q, { customerId: a.customerId, kind: "email", body: `התקבלה בקשה להצעת מחיר במייל, ונפתחה ממנה טיוטת הצעה ${number}. ${mail.summary ?? ""}`.trim(), userId, entityType: "quote", entityId: quoteId });
    return { quoteId, number };
  }
  const { orderId, number } = await createOrder(q, a.customerId, userId, draft, "email");
  await q("update inbound_emails set status = 'approved', customer_id = $2, order_id = $3, handled_by = $4, handled_at = now() where id = $1", [id, a.customerId, orderId, userId]);
  await addActivity(q, { customerId: a.customerId, kind: "email", body: `התקבלה הזמנה במייל, ונפתחה ממנה הזמנה ${number}. ${mail.summary ?? ""}`.trim(), userId, entityType: "order", entityId: orderId });
  return { orderId, number };
}

export async function dismissInbound(q: Q, id: string, reason: string, userId: string): Promise<void> {
  const [mail] = await q<{ status: string }>("select status from inbound_emails where id = $1 for update", [id]);
  if (!mail) throw new InboundError("ההודעה לא נמצאה.");
  if (mail.status !== "new") throw new InboundError("ההמלצה הזאת כבר טופלה.");
  await q("update inbound_emails set status = 'dismissed', dismiss_reason = $2, handled_by = $3, handled_at = now() where id = $1", [id, reason.replace(/\s+/g, " ").trim().slice(0, 300) || null, userId]);
}

// ---------- where the reading of the mailbox stands

export type MailboxState = { uidValidity: number | null; lastUid: number; checkedAt: string | null; lastError: string | null };

export async function mailboxState(q: Q, mailbox: string): Promise<MailboxState | null> {
  const [s] = await q<MailboxState>(`select uid_validity::float8 as "uidValidity", last_uid::float8 as "lastUid", checked_at::text as "checkedAt", last_error as "lastError" from inbound_state where mailbox = $1`, [mailbox]);
  return s ?? null;
}

export async function saveMailboxState(q: Q, mailbox: string, uidValidity: number | null, lastUid: number, error: string | null): Promise<void> {
  await q(
    `insert into inbound_state (mailbox, uid_validity, last_uid, checked_at, last_error) values ($1, $2, $3, now(), $4)
     on conflict (mailbox) do update set uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, checked_at = now(), last_error = excluded.last_error`,
    [mailbox, uidValidity, lastUid, error?.slice(0, 500) ?? null],
  );
}
