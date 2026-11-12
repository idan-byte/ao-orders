// Distribution execution: loading a daily route, leaving for delivery, handing over each delivery.
// One function decides every action, whatever started it (a tap, a QR scan later, an administrator),
// so no path can skip a rule. No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { ShippingError } from "./shipping-core.ts";

export type Action = "load" | "unload" | "reverse_load" | "reverse_unload";
export type Source = "manual" | "qr_scan" | "admin";
export type ActionResult = { changed: boolean; message: string };

const event = (q: Q, type: string, deliveryId: string | null, dailyRouteId: string | null, userId: string | null, source: Source, metadata: unknown = null) =>
  q("insert into shipping_events (delivery_id, daily_route_id, event_type, source, performed_by, metadata) values ($1, $2, $3, $4, $5, $6)", [deliveryId, dailyRouteId, type, source, userId, metadata === null ? null : JSON.stringify(metadata)]);
const statusAudit = (q: Q, userId: string | null, deliveryId: string, from: string, to: string, note: string) =>
  q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'delivery_status', 'delivery', $2, $3, $4)", [userId, deliveryId, JSON.stringify({ status: from }), JSON.stringify({ status: to, note })]);

/**
 * A refused attempt is itself recorded. Because the caller's transaction is rolled back when this throws,
 * the record is returned to the caller, which writes it after the rollback (see `refusal` on the error).
 */
export class RefusedError extends ShippingError {
  refusal: { type: string; deliveryId: string | null; dailyRouteId: string; metadata: unknown };
  constructor(message: string, refusal: RefusedError["refusal"]) {
    super(message);
    this.refusal = refusal;
  }
}
export const recordRefusal = (q: Q, e: RefusedError, userId: string | null, source: Source) => event(q, e.refusal.type, e.refusal.deliveryId, e.refusal.dailyRouteId, userId, source, e.refusal.metadata);

export async function processDeliveryAction(q: Q, input: { deliveryId: string; dailyRouteId: string; action: Action; userId: string | null; source: Source }): Promise<ActionResult> {
  const { deliveryId, dailyRouteId, action, userId, source } = input;
  const [route] = await q<{ mode: string; loading_started_at: string | null }>("select mode, loading_started_at::text from daily_routes where id = $1 for update", [dailyRouteId]);
  if (!route) throw new ShippingError("הקו לא נמצא.");
  const [d] = await q<{ status: string; daily_route_id: string | null; loaded: boolean; other_route: string | null; customer: string }>(
    `select d.status::text, d.daily_route_id::text, d.loaded_at is not null as loaded, c.name as customer,
            (select r.name from daily_routes dr join routes r on r.id = dr.route_id where dr.id = d.daily_route_id) as other_route
     from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id where d.id = $1 for update of d`,
    [deliveryId],
  );
  if (!d) throw new ShippingError("האספקה לא נמצאה.");
  if (d.daily_route_id !== dailyRouteId) {
    throw new RefusedError(d.other_route ? `שגיאה: האספקה של ${d.customer} שייכת לקו ${d.other_route}.` : `שגיאה: האספקה של ${d.customer} אינה משובצת לקו הזה.`, {
      type: "wrong_route_attempt",
      deliveryId,
      dailyRouteId,
      metadata: { belongsTo: d.daily_route_id, action },
    });
  }
  if (d.status === "cancelled") throw new ShippingError("האספקה בוטלה.");

  if (action === "load") {
    if (route.mode !== "loading") throw new ShippingError("הקו כבר יצא להפצה. אי אפשר להעמיס עליו.");
    if (d.loaded) return { changed: false, message: "האספקה כבר סומנה כהועמסה." };
    await q("update deliveries set loaded_at = now(), loaded_by = $2 where id = $1", [deliveryId, userId]);
    if (!route.loading_started_at) await q("update daily_routes set loading_started_at = now() where id = $1", [dailyRouteId]);
    await event(q, "loaded", deliveryId, dailyRouteId, userId, source);
    return { changed: true, message: "הועמסה" };
  }
  if (action === "reverse_load") {
    if (route.mode !== "loading") throw new ShippingError("הקו כבר יצא להפצה. אי אפשר לבטל העמסה.");
    if (!d.loaded) return { changed: false, message: "האספקה אינה מסומנת כהועמסה." };
    await q("update deliveries set loaded_at = null, loaded_by = null where id = $1", [deliveryId]);
    await event(q, "load_reversed", deliveryId, dailyRouteId, userId, source);
    return { changed: true, message: "סימון ההעמסה בוטל" };
  }
  if (action === "unload") {
    if (d.status === "delivered") return { changed: false, message: "האספקה כבר סומנה כנמסרה." };
    if (route.mode !== "unloading") throw new ShippingError("הקו עדיין בטעינה. מסירה אפשרית רק אחרי היציאה להפצה.");
    if (!d.loaded || d.status !== "shipped") {
      throw new RefusedError("האספקה לא הועמסה, ולכן אי אפשר לסמן שנמסרה.", { type: "unload_before_load", deliveryId, dailyRouteId, metadata: { status: d.status } });
    }
    await q("update deliveries set status = 'delivered', delivered_at = now() where id = $1", [deliveryId]);
    await statusAudit(q, userId, deliveryId, "shipped", "delivered", "נמסרה בקו החלוקה");
    await event(q, "unloaded", deliveryId, dailyRouteId, userId, source);
    const [left] = await q<{ n: number }>("select count(*)::int as n from deliveries where daily_route_id = $1 and status = 'shipped'", [dailyRouteId]);
    if (left.n === 0) await q("update daily_routes set delivery_completed_at = now() where id = $1", [dailyRouteId]);
    return { changed: true, message: "נמסרה" };
  }
  // reverse_unload
  if (d.status !== "delivered") return { changed: false, message: "האספקה אינה מסומנת כנמסרה." };
  await q("update deliveries set status = 'shipped', delivered_at = null where id = $1", [deliveryId]);
  await q("update daily_routes set delivery_completed_at = null where id = $1", [dailyRouteId]);
  await statusAudit(q, userId, deliveryId, "delivered", "shipped", "סימון המסירה בוטל");
  await event(q, "unload_reversed", deliveryId, dailyRouteId, userId, source);
  return { changed: true, message: "סימון המסירה בוטל" };
}

export type Missing = { deliveryId: string; orderNumber: number; customer: string; stop: number | null };

export async function missingFromRoute(q: Q, dailyRouteId: string): Promise<Missing[]> {
  const rows = await q<{ id: string; number: number; customer: string; stop_order: number | null }>(
    `select d.id::text, o.number, c.name as customer, d.stop_order from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     where d.daily_route_id = $1 and d.status <> 'cancelled' and d.loaded_at is null order by d.stop_order, o.number`,
    [dailyRouteId],
  );
  return rows.map((r) => ({ deliveryId: r.id, orderNumber: r.number, customer: r.customer, stop: r.stop_order }));
}

/**
 * Ends loading and sends the route out. Everything loaded becomes "shipped".
 * If something is missing the route does not leave, unless someone authorised (`allowMissing`) says why.
 * What was left behind comes off the route and goes back to the unassigned list, so it is not forgotten.
 */
export async function depart(q: Q, dailyRouteId: string, userId: string, exception: { allowMissing: boolean; reason: string | null } = { allowMissing: false, reason: null }): Promise<{ shipped: number; leftBehind: number }> {
  const [route] = await q<{ mode: string; driver_id: number | null }>("select mode, driver_id from daily_routes where id = $1 for update", [dailyRouteId]);
  if (!route) throw new ShippingError("הקו לא נמצא.");
  if (route.mode !== "loading") throw new ShippingError("הקו כבר יצא להפצה.");
  if (route.driver_id === null) throw new ShippingError("לא נבחר נהג לקו. יש לבחור נהג לפני היציאה.");
  const missing = await missingFromRoute(q, dailyRouteId);
  const [{ n: loaded }] = await q<{ n: number }>("select count(*)::int as n from deliveries where daily_route_id = $1 and status <> 'cancelled' and loaded_at is not null", [dailyRouteId]);
  if (loaded === 0) throw new ShippingError("עוד לא הועמסה אף אספקה על הקו.");
  const reason = (exception.reason ?? "").trim();
  if (missing.length > 0) {
    if (!exception.allowMissing) throw new ShippingError(`חסרות ${missing.length} אספקות שלא הועמסו. יציאה בלעדיהן דורשת אישור מנהל.`);
    if (reason.length < 3) throw new ShippingError("יש לכתוב למה הקו יוצא בלי כל האספקות.");
  }
  const shipped = await q<{ id: string; status: string }>(
    `update deliveries d set status = 'shipped', shipped_at = now(), shipped_by = $2 from (select id, status::text from deliveries where daily_route_id = $1 and status <> 'cancelled' and loaded_at is not null for update) old
     where d.id = old.id returning d.id::text, old.status`,
    [dailyRouteId, userId],
  );
  for (const s of shipped) await statusAudit(q, userId, s.id, s.status, "shipped", "יצאה בקו החלוקה");
  for (const m of missing) {
    await q("update deliveries set daily_route_id = null, stop_order = null where id = $1", [m.deliveryId]);
    await event(q, "left_behind", m.deliveryId, dailyRouteId, userId, "manual", { reason });
  }
  await q(
    "update daily_routes set mode = 'unloading', loading_completed_at = now(), delivery_started_at = now(), departed_by = $2, departure_note = $3 where id = $1",
    [dailyRouteId, userId, missing.length > 0 ? reason : null],
  );
  await event(q, "departed", null, dailyRouteId, userId, "manual", { shipped: shipped.length, leftBehind: missing.map((m) => m.orderNumber), reason: missing.length > 0 ? reason : null });
  return { shipped: shipped.length, leftBehind: missing.length };
}

// ---------- who may see and work a route

export type RouteAccess = { view: boolean; load: boolean; unload: boolean; manage: boolean };

/**
 * A manager works every route. A loading manager loads every route. A driver sees and works only the routes
 * they drive: the driver record is matched to the login by its phone number, which is the login identifier.
 */
export async function routeAccess(q: Q, user: { role: string; mobile: string }, dailyRouteId: string, may: (permission: "shipping.manage" | "shipping.ship") => boolean): Promise<RouteAccess> {
  if (may("shipping.manage")) return { view: true, load: true, unload: true, manage: true };
  if (!may("shipping.ship")) return { view: false, load: false, unload: false, manage: false };
  if (user.role === "loading_manager") return { view: true, load: true, unload: false, manage: false };
  const [mine] = await q("select 1 from daily_routes dr join drivers d on d.id = dr.driver_id where dr.id = $1 and d.phone = $2 and d.active", [dailyRouteId, user.mobile]);
  return mine ? { view: true, load: true, unload: true, manage: false } : { view: false, load: false, unload: false, manage: false };
}

export type WorkRoute = { id: string; date: string; name: string; driver: string | null; vehicle: string | null; mode: string; total: number; loaded: number; delivered: number; stops: number };

/** The routes a user works on the given dates, with progress counted from the deliveries themselves. */
export async function workRoutes(q: Q, user: { role: string; mobile: string }, dates: string[], all: boolean): Promise<WorkRoute[]> {
  const rows = await q<{ id: string; date: string; name: string; driver: string | null; vehicle: string | null; mode: string; total: number; loaded: number; delivered: number; stops: number }>(
    `select dr.id::text, dr.route_date::text as date, r.name, dv.name as driver, v.registration as vehicle, dr.mode,
            count(d.id)::int as total, count(d.loaded_at)::int as loaded, count(*) filter (where d.status = 'delivered')::int as delivered, count(distinct d.stop_order)::int as stops
     from daily_routes dr join routes r on r.id = dr.route_id
     left join drivers dv on dv.id = dr.driver_id left join vehicles v on v.id = dr.vehicle_id
     left join deliveries d on d.daily_route_id = dr.id and d.status <> 'cancelled'
     where dr.route_date = any($1::date[]) and ($2::boolean or (dv.phone = $3 and dv.active))
     group by dr.id, r.name, dv.name, v.registration
     order by dr.route_date, r.name`,
    [dates, all, user.mobile],
  );
  return rows;
}

/** "not started" / "in progress" / "done". A route with nothing on it is never shown as done. */
export const progressLabel = (done: number, total: number) => (total === 0 || done === 0 ? "טרם התחיל" : done < total ? "בתהליך" : "הושלם");

// ---------- scanning a label

export const SCAN_PREFIX = "AOD:";
/** What the QR carries. The prefix tells our labels apart from any other QR a camera may catch. */
export const scanPayload = (code: string) => SCAN_PREFIX + code;
/** 3F9A1C07B2 -> 3F9A1-C07B2, easier to read aloud and to type. */
export const formatScanCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;
/** Reads a scanned QR or a typed code: with or without the prefix, in any letter case, with spaces or hyphens. */
export function parseScanCode(input: string): string | null {
  let t = String(input ?? "").trim().toUpperCase();
  if (t.startsWith(SCAN_PREFIX)) t = t.slice(SCAN_PREFIX.length);
  t = t.replace(/[\s-]/g, "");
  return /^[0-9A-F]{10}$/.test(t) ? t : null;
}

export type ScanResult = { changed: boolean; message: string; customer: string; orderNumber: number; stop: number | null };

/**
 * One scan on a route's screen. The route's mode decides what the scan means: loading while the route is
 * being loaded, handing over once it has left. The rules themselves are those of `processDeliveryAction`.
 */
export async function scanDelivery(q: Q, input: { code: string; dailyRouteId: string; userId: string | null; access: Pick<RouteAccess, "load" | "unload"> }): Promise<ScanResult> {
  const code = parseScanCode(input.code);
  const unknown = () => new RefusedError("הקוד אינו מדבקת אספקה של המערכת.", { type: "unknown_code", deliveryId: null, dailyRouteId: input.dailyRouteId, metadata: { length: String(input.code ?? "").length } });
  if (!code) throw unknown();
  const [d] = await q<{ id: string; customer: string; number: number; stop_order: number | null }>(
    "select d.id::text, c.name as customer, o.number, d.stop_order from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id where d.scan_code = $1",
    [code],
  );
  if (!d) throw unknown();
  const [route] = await q<{ mode: string }>("select mode from daily_routes where id = $1", [input.dailyRouteId]);
  if (!route) throw new ShippingError("הקו לא נמצא.");
  const action: Action = route.mode === "loading" ? "load" : "unload";
  if (!(action === "load" ? input.access.load : input.access.unload)) throw new ShippingError(action === "load" ? "אין לך הרשאה להעמיס בקו הזה." : "אין לך הרשאה לסמן מסירה בקו הזה.");
  const result = await processDeliveryAction(q, { deliveryId: d.id, dailyRouteId: input.dailyRouteId, action, userId: input.userId, source: "qr_scan" });
  return { ...result, customer: d.customer, orderNumber: d.number, stop: d.stop_order };
}

export type Label = { deliveryId: string; code: string; orderNumber: number; customer: string; address: string | null; stop: number | null; units: number; window: string | null; notes: string | null };

/** One label for every delivery on the route, in loading order: the last stop is loaded first. */
export async function routeLabels(q: Q, dailyRouteId: string): Promise<Label[]> {
  return q<Label>(
    `select d.id::text as "deliveryId", d.scan_code as code, o.number as "orderNumber", c.name as customer, d.address_snapshot as address, d.stop_order as stop,
            coalesce((select sum(l.quantity) from delivery_lines l where l.delivery_id = d.id), 0)::float as units,
            nullif(concat_ws('–', to_char(d.window_from, 'HH24:MI'), to_char(d.window_to, 'HH24:MI')), '') as window, d.shipping_notes as notes
     from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     where d.daily_route_id = $1 and d.status <> 'cancelled' order by d.stop_order desc, o.number`,
    [dailyRouteId],
  );
}
