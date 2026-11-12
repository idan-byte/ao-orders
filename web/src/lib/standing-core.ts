// Standing orders: a weekly template per customer, single-day exceptions, pauses, and generating real orders.
// No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { resolvePrice } from "./customers-core.ts";
import { VAT_RATE } from "./quote-totals.ts";

export class StandingError extends Error {}

export const WEEKDAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"] as const;
const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: string | null | undefined): s is string => !!s && /^\d{2}:\d{2}$/.test(s);
const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};
/** 0 = Sunday. Computed in UTC so the machine's time zone can never shift a date to its neighbour. */
export const weekdayOf = (date: string) => new Date(date + "T00:00:00Z").getUTCDay();
const addDays = (date: string, n: number) => new Date(Date.parse(date + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

export type StandingInput = {
  customerId: string;
  addressId: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  validFrom: string;
  validTo: string | null;
  productionNotes: string | null;
  shippingNotes: string | null;
  lines: { weekday: number; sku: string; variantId?: number | null; quantity: number }[];
};

/** Creates or replaces a standing order. Orders that were already generated from it are not touched. */
export async function saveStanding(q: Q, id: string | null, input: StandingInput, userId: string): Promise<string> {
  if (!isDate(input.validFrom)) throw new StandingError("יש לבחור מאיזה תאריך ההזמנה הקבועה בתוקף.");
  if (input.validTo && !isDate(input.validTo)) throw new StandingError("תאריך הסיום אינו תקין.");
  if (input.validTo && input.validTo < input.validFrom) throw new StandingError("תאריך הסיום מוקדם מתאריך ההתחלה.");
  if ((input.windowFrom && !isTime(input.windowFrom)) || (input.windowTo && !isTime(input.windowTo))) throw new StandingError("שעת האספקה אינה תקינה.");
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (lines.length === 0) throw new StandingError("הזמנה קבועה חייבת לכלול לפחות מוצר אחד ביום אחד.");
  for (const l of lines) {
    if (!Number.isInteger(l.weekday) || l.weekday < 0 || l.weekday > 6) throw new StandingError("יום בשבוע אינו תקין.");
    if (!Number.isFinite(l.quantity)) throw new StandingError("כמות אינה תקינה.");
  }
  for (const sku of new Set(lines.map((l) => l.sku))) {
    const [p] = await q("select 1 from products where sku = $1", [sku]);
    if (!p) throw new StandingError(`המק״ט ${sku} אינו קיים בקטלוג.`);
  }
  const [c] = await q("select 1 from customers where id = $1 and active", [input.customerId]);
  if (!c) throw new StandingError("הלקוח לא נמצא.");
  if (input.addressId) {
    const [a] = await q("select 1 from customer_addresses where id = $1 and customer_id = $2", [input.addressId, input.customerId]);
    if (!a) throw new StandingError("כתובת האספקה אינה שייכת ללקוח.");
  }

  let standingId = id;
  if (standingId) {
    const rows = await q(
      `update standing_orders set address_id = $2, window_from = $3::time, window_to = $4::time, valid_from = $5::date, valid_to = $6::date, notes = $7, shipping_notes = $8
       where id = $1 and customer_id = $9 returning id`,
      [standingId, input.addressId, input.windowFrom, input.windowTo, input.validFrom, input.validTo, clean(input.productionNotes), clean(input.shippingNotes), input.customerId],
    );
    if (rows.length === 0) throw new StandingError("ההזמנה הקבועה לא נמצאה.");
    await q("delete from standing_order_lines where standing_order_id = $1", [standingId]);
  } else {
    const [row] = await q<{ id: string }>(
      `insert into standing_orders (customer_id, address_id, window_from, window_to, valid_from, valid_to, notes, shipping_notes, created_by)
       values ($1, $2, $3::time, $4::time, $5::date, $6::date, $7, $8, $9) returning id::text`,
      [input.customerId, input.addressId, input.windowFrom, input.windowTo, input.validFrom, input.validTo, clean(input.productionNotes), clean(input.shippingNotes), userId],
    );
    standingId = row.id;
  }
  for (const l of lines) {
    await q("insert into standing_order_lines (standing_order_id, weekday, sku, variant_id, quantity) values ($1, $2, $3, $4, $5)", [standingId, l.weekday, l.sku, l.variantId ?? null, l.quantity]);
  }
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'standing_order', $3, $4)", [userId, id ? "update_standing" : "create_standing", standingId, JSON.stringify({ lines: lines.length, validFrom: input.validFrom, validTo: input.validTo })]);
  return standingId!;
}

/** Skips (or restores) one date of a standing order. A date whose order already exists cannot be skipped here: cancel that order instead. */
export async function setSkip(q: Q, standingId: string, day: string, skip: boolean, reason: string | null): Promise<void> {
  if (!isDate(day)) throw new StandingError("התאריך אינו תקין.");
  const [row] = await q<{ generated_order_id: string | null }>("select generated_order_id::text from standing_order_days where standing_order_id = $1 and day = $2::date", [standingId, day]);
  if (row?.generated_order_id) throw new StandingError("ליום הזה כבר נוצרה הזמנה. כדי לבטל אותו יש לבטל את ההזמנה עצמה.");
  if (skip) {
    await q("insert into standing_order_days (standing_order_id, day, skipped, reason) values ($1, $2::date, true, $3) on conflict (standing_order_id, day) do update set skipped = true, reason = excluded.reason", [standingId, day, clean(reason)]);
  } else {
    await q("delete from standing_order_days where standing_order_id = $1 and day = $2::date and generated_order_id is null", [standingId, day]);
  }
}

/** Pauses a standing order up to and including a date (a school holiday, for example). Null resumes it. */
export async function setPause(q: Q, standingId: string, until: string | null): Promise<void> {
  if (until && !isDate(until)) throw new StandingError("התאריך אינו תקין.");
  await q("update standing_orders set paused_until = $2::date where id = $1", [standingId, until]);
}

export async function setClosedDay(q: Q, day: string, reason: string | null): Promise<void> {
  if (!isDate(day)) throw new StandingError("התאריך אינו תקין.");
  if (reason === null) {
    await q("delete from closed_days where day = $1::date", [day]);
    return;
  }
  if (!clean(reason)) throw new StandingError("יש לכתוב את סיבת הסגירה (למשל שם החג).");
  await q("insert into closed_days (day, reason) values ($1::date, $2) on conflict (day) do update set reason = excluded.reason", [day, reason.trim()]);
}

export type GenerateResult = { created: number; orders: { standingId: string; day: string; orderNumber: number }[]; skipped: { closed: number; paused: number; excluded: number; existing: number } };

/**
 * Creates the real orders for every standing order and every date in the range. Running it again for the same
 * range creates nothing new: each (standing order, date) pair is recorded and can be generated only once.
 * Prices are taken at generation time from the customer's agreement, or the base price.
 */
export async function generateStanding(q: Q, from: string, to: string, userId: string): Promise<GenerateResult> {
  if (!isDate(from) || !isDate(to)) throw new StandingError("טווח התאריכים אינו תקין.");
  if (to < from) throw new StandingError("תאריך הסיום מוקדם מתאריך ההתחלה.");
  if (Date.parse(to) - Date.parse(from) > 62 * 86400_000) throw new StandingError("אפשר ליצור הזמנות לטווח של עד חודשיים בכל פעם.");

  const result: GenerateResult = { created: 0, orders: [], skipped: { closed: 0, paused: 0, excluded: 0, existing: 0 } };
  const closed = new Set((await q<{ day: string }>("select day::text from closed_days where day between $1::date and $2::date", [from, to])).map((r) => r.day));
  const standing = await q<{ id: string; customer_id: string; address_id: string | null; window_from: string | null; window_to: string | null; valid_from: string; valid_to: string | null; paused_until: string | null; notes: string | null; shipping_notes: string | null; snapshot: string | null }>(
    `select s.id::text, s.customer_id::text, s.address_id::text, s.window_from::text, s.window_to::text, s.valid_from::text, s.valid_to::text, s.paused_until::text, s.notes, s.shipping_notes,
            (select concat_ws(', ', a.street, a.city) from customer_addresses a where a.id = s.address_id) as snapshot
     from standing_orders s join customers c on c.id = s.customer_id
     where c.active and s.valid_from <= $2::date and (s.valid_to is null or s.valid_to >= $1::date)
     order by s.created_at, s.id`,
    [from, to],
  );

  for (const s of standing) {
    const lines = await q<{ weekday: number; sku: string; variant_id: number | null; quantity: number }>("select weekday, sku, variant_id, quantity::float from standing_order_lines where standing_order_id = $1 order by id", [s.id]);
    const marked = new Map((await q<{ day: string; skipped: boolean; generated: boolean }>("select day::text, skipped, generated_order_id is not null as generated from standing_order_days where standing_order_id = $1 and day between $2::date and $3::date", [s.id, from, to])).map((r) => [r.day, r]));
    for (let day = from; day <= to; day = addDays(day, 1)) {
      if (day < s.valid_from || (s.valid_to && day > s.valid_to)) continue;
      const todays = lines.filter((l) => l.weekday === weekdayOf(day));
      if (todays.length === 0) continue;
      const mark = marked.get(day);
      if (mark?.generated) { result.skipped.existing++; continue; }
      if (mark?.skipped) { result.skipped.excluded++; continue; }
      if (closed.has(day)) { result.skipped.closed++; continue; }
      if (s.paused_until && day <= s.paused_until) { result.skipped.paused++; continue; }

      const [order] = await q<{ id: string; number: number }>("insert into orders (customer_id, source, standing_order_id, owner_id, vat_rate) values ($1, 'standing', $2, $3, $4) returning id::text, number", [s.customer_id, s.id, userId, VAT_RATE]);
      const [delivery] = await q<{ id: string }>(
        `insert into deliveries (order_id, delivery_date, window_from, window_to, address_id, address_snapshot, status, production_notes, shipping_notes)
         values ($1, $2::date, $3::time, $4::time, $5, $6, 'approved', $7, $8) returning id::text`,
        [order.id, day, s.window_from, s.window_to, s.address_id, s.snapshot, s.notes, s.shipping_notes],
      );
      for (const l of todays) {
        const price = (await resolvePrice(q, s.customer_id, l.sku, day))?.price ?? 0;
        await q("insert into delivery_lines (delivery_id, sku, variant_id, quantity, unit_price) values ($1, $2, $3, $4, $5)", [delivery.id, l.sku, l.variant_id, l.quantity, price]);
      }
      // The primary key on (standing order, day) is what makes a second run harmless.
      await q("insert into standing_order_days (standing_order_id, day, generated_order_id) values ($1, $2::date, $3)", [s.id, day, order.id]);
      result.created++;
      result.orders.push({ standingId: s.id, day, orderNumber: order.number });
    }
  }
  if (result.created > 0) {
    await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'generate_standing', 'standing_order', 'range', $2)", [userId, JSON.stringify({ from, to, created: result.created, skipped: result.skipped })]);
  }
  return result;
}
