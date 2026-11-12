// Order logic: manual entry, changes with history, and delivery status transitions. No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { CatalogError, checkVariants } from "./catalog-core.ts";
import { VAT_RATE } from "./quote-totals.ts";
import { validateDraft, type DraftInput } from "./quotes-core.ts";

export class OrderError extends Error {}

export const DELIVERY_STATUSES = ["draft", "pending_approval", "approved", "in_production", "ready_to_ship", "shipped", "delivered", "exception", "delayed", "cancelled"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const STATUS_LABEL: Record<string, string> = {
  draft: "טיוטה",
  pending_approval: "ממתינה לאישור",
  approved: "מאושרת",
  in_production: "בייצור",
  ready_to_ship: "מוכנה לשילוח",
  shipped: "יצאה לשילוח",
  delivered: "סופקה",
  exception: "חריגה לטיפול",
  delayed: "מעוכבת",
  cancelled: "מבוטלת",
  partially_delivered: "הושלמה חלקית",
};

// The normal path, one step at a time. "shipped" is reached only through the shipping action, which also issues the delivery note.
const NEXT: Partial<Record<DeliveryStatus, DeliveryStatus>> = { draft: "approved", pending_approval: "approved", approved: "in_production", in_production: "ready_to_ship", shipped: "delivered" };
const HOLDABLE: DeliveryStatus[] = ["approved", "in_production", "ready_to_ship"];
const CANCELLABLE: DeliveryStatus[] = ["draft", "pending_approval", "approved", "in_production", "ready_to_ship", "exception", "delayed"];
const EDITABLE: DeliveryStatus[] = ["draft", "pending_approval", "approved", "in_production", "exception", "delayed"];

export const nextStatus = (s: DeliveryStatus) => NEXT[s] ?? null;
export const canHold = (s: DeliveryStatus) => HOLDABLE.includes(s);
export const canCancel = (s: DeliveryStatus) => CANCELLABLE.includes(s);
export const canEdit = (s: DeliveryStatus) => EDITABLE.includes(s);

const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

async function audit(q: Q, userId: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, $2, $3, $4, $5, $6)", [userId, action, entityType, entityId, before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
}

async function addressSnapshot(q: Q, addressId: string | null, customerId: string): Promise<string | null> {
  if (!addressId) return null;
  const [a] = await q<{ street: string; city: string | null }>("select street, city from customer_addresses where id = $1 and customer_id = $2", [addressId, customerId]);
  if (!a) throw new OrderError("כתובת האספקה אינה שייכת ללקוח.");
  return [a.street, a.city].filter(Boolean).join(", ");
}

async function variantsOk(q: Q, lines: { sku: string; variantId?: number | null }[], allowInactive?: Set<string>) {
  try {
    await checkVariants(q, lines, allowInactive);
  } catch (e) {
    throw new OrderError(e instanceof CatalogError ? e.message : "בדיקת הסוגים נכשלה.");
  }
}

async function checkSkus(q: Q, skus: string[]) {
  for (const sku of new Set(skus)) {
    const [p] = await q("select 1 from products where sku = $1", [sku]);
    if (!p) throw new OrderError(`המק״ט ${sku} אינו קיים בקטלוג.`);
  }
}

/**
 * Opens an order entered by an employee. It is approved at once (the employee is the approval) and gets one
 * delivery per delivery date. In the form, "customer notes" are the shipping notes and "internal notes" are for production.
 */
export async function createOrder(q: Q, customerId: string, userId: string, d: DraftInput): Promise<{ orderId: string; number: number; deliveries: number }> {
  const problem = validateDraft(d);
  if (problem) throw new OrderError(problem);
  if (d.lines.length === 0) throw new OrderError("אי אפשר לפתוח הזמנה בלי פריטים.");
  const [c] = await q("select 1 from customers where id = $1 and active", [customerId]);
  if (!c) throw new OrderError("הלקוח לא נמצא.");
  if (d.lines.some((l) => !l.deliveryDate) && !d.deliveryDate) throw new OrderError("יש לקבוע תאריך אספקה להזמנה, או לכל שורה.");
  await checkSkus(q, d.lines.map((l) => l.sku));
  await variantsOk(q, d.lines);
  const snapshot = await addressSnapshot(q, d.addressId, customerId);

  const [order] = await q<{ id: string; number: number }>(
    "insert into orders (customer_id, source, owner_id, discount_pct, vat_rate, delivery_fee) values ($1, 'manual', $2, $3, $4, $5) returning id::text, number",
    [customerId, userId, d.discountPct, VAT_RATE, d.deliveryFee],
  );
  const byDate = new Map<string, typeof d.lines>();
  for (const l of d.lines) {
    const date = l.deliveryDate ?? d.deliveryDate!;
    byDate.set(date, [...(byDate.get(date) ?? []), l]);
  }
  for (const [date, group] of [...byDate.entries()].sort()) {
    const [delivery] = await q<{ id: string }>(
      `insert into deliveries (order_id, delivery_date, window_from, window_to, address_id, address_snapshot, status, production_notes, shipping_notes)
       values ($1, $2::date, $3::time, $4::time, $5, $6, 'approved', $7, $8) returning id::text`,
      [order.id, date, d.windowFrom, d.windowTo, d.addressId, snapshot, clean(d.internalNotes), clean(d.customerNotes)],
    );
    for (const l of group) {
      await q("insert into delivery_lines (delivery_id, sku, variant_id, quantity, unit_price, discount_pct) values ($1, $2, $3, $4, $5, $6)", [delivery.id, l.sku, l.variantId ?? null, l.quantity, l.unitPrice, l.discountPct ?? 0]);
    }
  }
  await audit(q, userId, "create_order", "order", order.id, null, { number: order.number, customerId, deliveries: byDate.size, lines: d.lines.length });
  return { orderId: order.id, number: order.number, deliveries: byDate.size };
}

export type DeliveryInput = {
  lines: { sku: string; variantId?: number | null; quantity: number; unitPrice: number; discountPct?: number }[];
  deliveryDate: string;
  windowFrom: string | null;
  windowTo: string | null;
  addressId: string | null;
  productionNotes: string | null;
  shippingNotes: string | null;
};
export type DeliveryChange = { what: string; before: string | number | null; after: string | number | null };

/**
 * Changes a delivery and records exactly what changed. Quantities are compared per product (and variant),
 * so the history reads "50002: 60 -> 80" rather than "lines replaced".
 */
export async function updateDelivery(q: Q, deliveryId: string, input: DeliveryInput, userId: string): Promise<DeliveryChange[]> {
  const [del] = await q<{ status: DeliveryStatus; customer_id: string; delivery_date: string; window_from: string | null; window_to: string | null; address_id: string | null; production_notes: string | null; shipping_notes: string | null }>(
    `select d.status::text as status, o.customer_id::text, d.delivery_date::text, to_char(d.window_from, 'HH24:MI') as window_from, to_char(d.window_to, 'HH24:MI') as window_to,
            d.address_id::text, d.production_notes, d.shipping_notes
     from deliveries d join orders o on o.id = d.order_id where d.id = $1`,
    [deliveryId],
  );
  if (!del) throw new OrderError("האספקה לא נמצאה.");
  if (!canEdit(del.status)) throw new OrderError(`אספקה במצב ״${STATUS_LABEL[del.status]}״ אינה ניתנת לשינוי.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate)) throw new OrderError("תאריך האספקה אינו תקין.");
  if (input.lines.length === 0) throw new OrderError("אספקה חייבת לכלול לפחות פריט אחד. כדי לבטל אותה יש להשתמש בביטול.");
  for (const [i, l] of input.lines.entries()) {
    if (!l.sku) throw new OrderError(`שורה ${i + 1}: יש לבחור מוצר.`);
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) throw new OrderError(`שורה ${i + 1}: הכמות צריכה להיות גדולה מאפס.`);
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) throw new OrderError(`שורה ${i + 1}: המחיר אינו תקין.`);
    const disc = l.discountPct ?? 0;
    if (!Number.isFinite(disc) || disc < 0 || disc > 100) throw new OrderError(`שורה ${i + 1}: ההנחה צריכה להיות בין 0 ל-100.`);
  }
  await checkSkus(q, input.lines.map((l) => l.sku));
  const snapshot = input.addressId === del.address_id ? undefined : await addressSnapshot(q, input.addressId, del.customer_id);

  const oldLines = await q<{ sku: string; variant_id: number | null; quantity: number; unit_price: number }>("select sku, variant_id, quantity::float, unit_price::float from delivery_lines where delivery_id = $1", [deliveryId]);
  // A line that already carries a variant may keep it even if that variant was switched off since.
  await variantsOk(q, input.lines, new Set(oldLines.filter((l) => l.variant_id !== null).map((l) => `${l.sku}|${l.variant_id}`)));
  const key = (l: { sku: string; variantId?: number | null; variant_id?: number | null }) => `${l.sku}|${l.variantId ?? l.variant_id ?? ""}`;
  const sum = <T,>(rows: T[], k: (r: T) => string, v: (r: T) => number) => rows.reduce((m, r) => m.set(k(r), (m.get(k(r)) ?? 0) + v(r)), new Map<string, number>());
  const beforeQty = sum(oldLines, key, (l) => l.quantity);
  const afterQty = sum(input.lines, key, (l) => l.quantity);
  const beforePrice = new Map(oldLines.map((l) => [key(l), l.unit_price]));
  const afterPrice = new Map(input.lines.map((l) => [key(l), l.unitPrice]));

  const changes: DeliveryChange[] = [];
  for (const k of new Set([...beforeQty.keys(), ...afterQty.keys()])) {
    const b = beforeQty.get(k) ?? 0;
    const a = afterQty.get(k) ?? 0;
    const sku = k.split("|")[0];
    if (b !== a) changes.push({ what: `כמות ${sku}`, before: b, after: a });
    else if (beforePrice.get(k) !== afterPrice.get(k)) changes.push({ what: `מחיר ${sku}`, before: beforePrice.get(k) ?? null, after: afterPrice.get(k) ?? null });
  }
  const fields: [string, string | null, string | null][] = [
    ["תאריך אספקה", del.delivery_date, input.deliveryDate],
    ["משעה", del.window_from, clean(input.windowFrom)],
    ["עד שעה", del.window_to, clean(input.windowTo)],
    ["הערות לייצור", del.production_notes, clean(input.productionNotes)],
    ["הערות לשילוח", del.shipping_notes, clean(input.shippingNotes)],
  ];
  for (const [what, b, a] of fields) if ((b ?? null) !== (a ?? null)) changes.push({ what, before: b, after: a });
  if (snapshot !== undefined) changes.push({ what: "כתובת אספקה", before: del.address_id, after: input.addressId });
  if (changes.length === 0) return [];

  await q(
    `update deliveries set delivery_date = $2::date, window_from = $3::time, window_to = $4::time, production_notes = $5, shipping_notes = $6,
       address_id = case when $7::boolean then $8::uuid else address_id end,
       address_snapshot = case when $7::boolean then $9 else address_snapshot end
     where id = $1`,
    [deliveryId, input.deliveryDate, clean(input.windowFrom), clean(input.windowTo), clean(input.productionNotes), clean(input.shippingNotes), snapshot !== undefined, input.addressId, snapshot ?? null],
  );
  await q("delete from delivery_lines where delivery_id = $1", [deliveryId]);
  for (const l of input.lines) {
    await q("insert into delivery_lines (delivery_id, sku, variant_id, quantity, unit_price, discount_pct) values ($1, $2, $3, $4, $5, $6)", [deliveryId, l.sku, l.variantId ?? null, l.quantity, l.unitPrice, l.discountPct ?? 0]);
  }
  await audit(q, userId, "update_delivery", "delivery", deliveryId, null, { changes });
  return changes;
}

async function currentStatus(q: Q, deliveryId: string): Promise<DeliveryStatus> {
  const [d] = await q<{ status: DeliveryStatus }>("select status::text as status from deliveries where id = $1", [deliveryId]);
  if (!d) throw new OrderError("האספקה לא נמצאה.");
  return d.status;
}

/** Moves a delivery one step along the normal path. The expected current status guards against two people clicking at once. */
export async function advanceDelivery(q: Q, deliveryId: string, expected: DeliveryStatus, userId: string): Promise<DeliveryStatus> {
  const from = await currentStatus(q, deliveryId);
  if (from !== expected) throw new OrderError(`האספקה כבר במצב ״${STATUS_LABEL[from]}״. יש לרענן את המסך.`);
  const to = nextStatus(from);
  if (!to) throw new OrderError(`אין שלב הבא אחרי ״${STATUS_LABEL[from]}״.`);
  await q("update deliveries set status = $2::delivery_status, delivered_at = case when $2::delivery_status = 'delivered' then now() else delivered_at end where id = $1", [deliveryId, to]);
  await audit(q, userId, "delivery_status", "delivery", deliveryId, { status: from }, { status: to });
  return to;
}

/** Puts a delivery on hold as an exception or a delay, remembering where it was so it can go back there. */
export async function holdDelivery(q: Q, deliveryId: string, kind: "exception" | "delayed", note: string, userId: string): Promise<void> {
  const from = await currentStatus(q, deliveryId);
  if (!canHold(from)) throw new OrderError(`אי אפשר לסמן אספקה במצב ״${STATUS_LABEL[from]}״.`);
  if (!clean(note)) throw new OrderError("יש לכתוב מה הבעיה.");
  await q("update deliveries set status = $2, exception_note = $3, status_before_hold = $4 where id = $1", [deliveryId, kind, note.trim(), from]);
  await audit(q, userId, "delivery_status", "delivery", deliveryId, { status: from }, { status: kind, note: note.trim() });
}

export async function releaseDelivery(q: Q, deliveryId: string, userId: string): Promise<DeliveryStatus> {
  const [d] = await q<{ status: DeliveryStatus; back: DeliveryStatus | null }>("select status::text as status, status_before_hold::text as back from deliveries where id = $1", [deliveryId]);
  if (!d) throw new OrderError("האספקה לא נמצאה.");
  if (d.status !== "exception" && d.status !== "delayed") throw new OrderError("האספקה אינה מסומנת כחריגה או כמעוכבת.");
  const to = d.back ?? "approved";
  await q("update deliveries set status = $2, exception_note = null, status_before_hold = null where id = $1", [deliveryId, to]);
  await audit(q, userId, "delivery_status", "delivery", deliveryId, { status: d.status }, { status: to });
  return to;
}

export async function cancelDelivery(q: Q, deliveryId: string, reason: string, userId: string): Promise<void> {
  const from = await currentStatus(q, deliveryId);
  if (!canCancel(from)) throw new OrderError(`אספקה במצב ״${STATUS_LABEL[from]}״ אינה ניתנת לביטול.`);
  if (!clean(reason)) throw new OrderError("יש לכתוב את סיבת הביטול.");
  await q("update deliveries set status = 'cancelled', cancel_reason = $2 where id = $1", [deliveryId, reason.trim()]);
  await audit(q, userId, "delivery_status", "delivery", deliveryId, { status: from }, { status: "cancelled", reason: reason.trim() });
}
