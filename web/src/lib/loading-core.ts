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

/** Locks the route and the delivery and checks that the delivery belongs to the route and was not cancelled. */
async function guard(q: Q, deliveryId: string, dailyRouteId: string, action: Action) {
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
  return { route, d };
}

/**
 * Marks a whole delivery, with all its boxes: a tap on the screen, or the last box of a delivery being scanned.
 * A single box is marked by `scanDelivery`.
 */
export async function processDeliveryAction(q: Q, input: { deliveryId: string; dailyRouteId: string; action: Action; userId: string | null; source: Source }): Promise<ActionResult> {
  const { deliveryId, dailyRouteId, action, userId, source } = input;
  const { route, d } = await guard(q, deliveryId, dailyRouteId, action);

  if (action === "load") {
    if (route.mode !== "loading") throw new ShippingError("הקו כבר יצא להפצה. אי אפשר להעמיס עליו.");
    if (d.loaded) return { changed: false, message: "האספקה כבר סומנה כהועמסה." };
    await q("update deliveries set loaded_at = now(), loaded_by = $2 where id = $1", [deliveryId, userId]);
    await q("update delivery_boxes set loaded_at = now(), loaded_by = $2 where delivery_id = $1 and loaded_at is null", [deliveryId, userId]);
    if (!route.loading_started_at) await q("update daily_routes set loading_started_at = now() where id = $1", [dailyRouteId]);
    await event(q, "loaded", deliveryId, dailyRouteId, userId, source);
    return { changed: true, message: "הועמסה" };
  }
  if (action === "reverse_load") {
    if (route.mode !== "loading") throw new ShippingError("הקו כבר יצא להפצה. אי אפשר לבטל העמסה.");
    // Also undoes boxes that were scanned while the delivery was still only partly loaded.
    const cleared = await q("update delivery_boxes set loaded_at = null, loaded_by = null where delivery_id = $1 and loaded_at is not null returning id", [deliveryId]);
    if (!d.loaded && cleared.length === 0) return { changed: false, message: "האספקה אינה מסומנת כהועמסה." };
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
    await q("update delivery_boxes set unloaded_at = now(), unloaded_by = $2 where delivery_id = $1 and unloaded_at is null", [deliveryId, userId]);
    await statusAudit(q, userId, deliveryId, "shipped", "delivered", "נמסרה בקו החלוקה");
    await event(q, "unloaded", deliveryId, dailyRouteId, userId, source);
    const [left] = await q<{ n: number }>("select count(*)::int as n from deliveries where daily_route_id = $1 and status = 'shipped'", [dailyRouteId]);
    if (left.n === 0) await q("update daily_routes set delivery_completed_at = now() where id = $1", [dailyRouteId]);
    return { changed: true, message: "נמסרה" };
  }
  // reverse_unload
  if (d.status !== "delivered") {
    // Boxes that were scanned at the customer while the delivery was still only partly handed over.
    const cleared = await q("update delivery_boxes set unloaded_at = null, unloaded_by = null where delivery_id = $1 and unloaded_at is not null returning id", [deliveryId]);
    return cleared.length > 0 ? { changed: true, message: "סימון המסירה בוטל" } : { changed: false, message: "האספקה אינה מסומנת כנמסרה." };
  }
  await q("update deliveries set status = 'shipped', delivered_at = null where id = $1", [deliveryId]);
  await q("update delivery_boxes set unloaded_at = null, unloaded_by = null where delivery_id = $1", [deliveryId]);
  await q("update daily_routes set delivery_completed_at = null where id = $1", [dailyRouteId]);
  await statusAudit(q, userId, deliveryId, "delivered", "shipped", "סימון המסירה בוטל");
  await event(q, "unload_reversed", deliveryId, dailyRouteId, userId, source);
  return { changed: true, message: "סימון המסירה בוטל" };
}

export type Missing = { deliveryId: string; orderNumber: number; customer: string; stop: number | null; boxes: number; loadedBoxes: number };

export async function missingFromRoute(q: Q, dailyRouteId: string): Promise<Missing[]> {
  const rows = await q<{ id: string; number: number; customer: string; stop_order: number | null; boxes: number; loaded_boxes: number }>(
    `select d.id::text, o.number, c.name as customer, d.stop_order,
            (select count(*)::int from delivery_boxes b where b.delivery_id = d.id) as boxes,
            (select count(*)::int from delivery_boxes b where b.delivery_id = d.id and b.loaded_at is not null) as loaded_boxes
     from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     where d.daily_route_id = $1 and d.status <> 'cancelled' and d.loaded_at is null order by d.stop_order, o.number`,
    [dailyRouteId],
  );
  return rows.map((r) => ({ deliveryId: r.id, orderNumber: r.number, customer: r.customer, stop: r.stop_order, boxes: r.boxes, loadedBoxes: r.loaded_boxes }));
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
    // Boxes of a delivery that stays behind come off the vehicle with it.
    await q("update delivery_boxes set loaded_at = null, loaded_by = null where delivery_id = $1", [m.deliveryId]);
    await event(q, "left_behind", m.deliveryId, dailyRouteId, userId, "manual", { reason, boxes: m.boxes, loadedBoxes: m.loadedBoxes });
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

export const BOX_KINDS = { general: "", hot: "חם", cold: "נלווים (קר)" } as const;
export type BoxKind = keyof typeof BOX_KINDS;
/** "ארגז 2 מתוך 3" for an ordinary delivery; "ארגז חם · א1" for a group's box of a hot food delivery. */
export const boxName = (b: { seq: number; kind: BoxKind; className?: string | null }, total: number) =>
  b.className ? `ארגז ${BOX_KINDS[b.kind] || "כללי"} · ${b.className}` : `ארגז ${BOX_KINDS[b.kind] ? `${BOX_KINDS[b.kind]} · ` : ""}${b.seq} מתוך ${total}`;

export type ScanResult = { changed: boolean; message: string; customer: string; orderNumber: number; stop: number | null; complete: boolean; boxes: number; done: number };

/**
 * One scan on a route's screen marks one box. The route's mode decides what the scan means: loading while
 * the route is being loaded, handing over once it has left. The delivery itself is marked only when its
 * last box is scanned, so a box that was left behind keeps the delivery, and the route, incomplete.
 */
export async function scanDelivery(q: Q, input: { code: string; dailyRouteId: string; userId: string | null; access: Pick<RouteAccess, "load" | "unload"> }): Promise<ScanResult> {
  const { dailyRouteId, userId } = input;
  const code = parseScanCode(input.code);
  const unknown = () => new RefusedError("הקוד אינו מדבקת ארגז של המערכת.", { type: "unknown_code", deliveryId: null, dailyRouteId, metadata: { length: String(input.code ?? "").length } });
  if (!code) throw unknown();
  const [box] = await q<{ id: string; delivery_id: string; seq: number; kind: BoxKind; className: string | null; customer: string; number: number; stop_order: number | null }>(
    `select b.id::text, b.delivery_id::text, b.seq, b.kind, g.class_name as "className", coalesce(i.name, c.name) as customer, o.number, d.stop_order
     from delivery_boxes b join deliveries d on d.id = b.delivery_id join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     left join institution_groups g on g.id = b.group_id left join institutions i on i.id = g.institution_id where b.scan_code = $1`,
    [code],
  );
  if (!box) throw unknown();
  const [mode] = await q<{ mode: string }>("select mode from daily_routes where id = $1", [dailyRouteId]);
  if (!mode) throw new ShippingError("הקו לא נמצא.");
  const action: Action = mode.mode === "loading" ? "load" : "unload";
  if (!(action === "load" ? input.access.load : input.access.unload)) throw new ShippingError(action === "load" ? "אין לך הרשאה להעמיס בקו הזה." : "אין לך הרשאה לסמן מסירה בקו הזה.");
  const { route, d } = await guard(q, box.delivery_id, dailyRouteId, action);
  const boxes = await q<{ id: string; loaded: boolean; unloaded: boolean }>("select id::text, loaded_at is not null as loaded, unloaded_at is not null as unloaded from delivery_boxes where delivery_id = $1 order by seq for update", [box.delivery_id]);
  const mine = boxes.find((b) => b.id === box.id)!;
  const total = boxes.length;
  const name = boxName(box, total);
  const result = (changed: boolean, message: string, done: number): ScanResult => ({ changed, message, customer: box.customer, orderNumber: box.number, stop: box.stop_order, complete: done === total, boxes: total, done });
  const still = (done: number) => (done < total ? ` חסרים עוד ${total - done}.` : "");

  if (action === "load") {
    if (route.mode !== "loading") throw new ShippingError("הקו כבר יצא להפצה. אי אפשר להעמיס עליו.");
    const before = boxes.filter((b) => b.loaded).length;
    if (mine.loaded) return result(false, total === 1 ? "האספקה כבר סומנה כהועמסה." : `${name} כבר נסרק.${still(before)}`, before);
    await q("update delivery_boxes set loaded_at = now(), loaded_by = $2 where id = $1", [box.id, userId]);
    if (!route.loading_started_at) await q("update daily_routes set loading_started_at = now() where id = $1", [dailyRouteId]);
    await event(q, "box_loaded", box.delivery_id, dailyRouteId, userId, "qr_scan", { box: box.seq, of: total });
    if (before + 1 < total) return result(true, `${name} הועמס.${still(before + 1)}`, before + 1);
    await processDeliveryAction(q, { deliveryId: box.delivery_id, dailyRouteId, action: "load", userId, source: "qr_scan" });
    return result(true, total === 1 ? "הועמסה" : `${name} הועמס. כל הארגזים של האספקה על הרכב.`, total);
  }
  if (route.mode !== "unloading") throw new ShippingError("הקו עדיין בטעינה. מסירה אפשרית רק אחרי היציאה להפצה.");
  const before = boxes.filter((b) => b.unloaded).length;
  if (mine.unloaded) return result(false, total === 1 ? "האספקה כבר סומנה כנמסרה." : `${name} כבר נמסר.${still(before)}`, before);
  if (!mine.loaded || !d.loaded || d.status !== "shipped") {
    throw new RefusedError(total === 1 ? "האספקה לא הועמסה, ולכן אי אפשר לסמן שנמסרה." : "הארגז לא הועמס, ולכן אי אפשר לסמן שנמסר.", { type: "unload_before_load", deliveryId: box.delivery_id, dailyRouteId, metadata: { status: d.status, box: box.seq } });
  }
  await q("update delivery_boxes set unloaded_at = now(), unloaded_by = $2 where id = $1", [box.id, userId]);
  await event(q, "box_unloaded", box.delivery_id, dailyRouteId, userId, "qr_scan", { box: box.seq, of: total });
  if (before + 1 < total) return result(true, `${name} נמסר.${still(before + 1)}`, before + 1);
  await processDeliveryAction(q, { deliveryId: box.delivery_id, dailyRouteId, action: "unload", userId, source: "qr_scan" });
  return result(true, total === 1 ? "נמסרה" : `${name} נמסר. כל הארגזים של האספקה נמסרו.`, total);
}

export type Label = {
  boxId: string;
  deliveryId: string;
  code: string;
  seq: number;
  kind: BoxKind;
  boxes: number;
  orderNumber: number;
  customer: string;
  address: string | null;
  stop: number | null;
  units: number;
  window: string | null;
  notes: string | null;
  // Hot food only: the group the box belongs to, its institution, and what the group ordered ("20 חמגשית א-ב + 3 חמגשית צמחוני א-ב").
  className: string | null;
  institution: string | null;
  contents: string | null;
  lifeThreatening: boolean;
};

/** One label for every box on the route, in loading order: the last stop is loaded first. */
export async function routeLabels(q: Q, dailyRouteId: string): Promise<Label[]> {
  return q<Label>(
    `select b.id::text as "boxId", d.id::text as "deliveryId", b.scan_code as code, b.seq, b.kind, (select count(*)::int from delivery_boxes x where x.delivery_id = d.id) as boxes,
            o.number as "orderNumber", c.name as customer, d.address_snapshot as address, d.stop_order as stop,
            coalesce((select sum(l.quantity) from delivery_lines l where l.delivery_id = d.id), 0)::float as units,
            nullif(concat_ws('–', to_char(d.window_from, 'HH24:MI'), to_char(d.window_to, 'HH24:MI')), '') as window, d.shipping_notes as notes,
            g.class_name as "className", i.name as institution, coalesce(i.life_threatening, false) as "lifeThreatening",
            (select string_agg(mq.ordered_qty || ' ' || mt.name, ' + ' order by mt.name) from milgam_quantities mq join meal_types mt on mt.id = mq.meal_type_id
             where mq.group_id = b.group_id and mq.day = d.delivery_date and mq.ordered_qty is not null) as contents
     from deliveries d join delivery_boxes b on b.delivery_id = d.id join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     left join institution_groups g on g.id = b.group_id left join institutions i on i.id = g.institution_id
     where d.daily_route_id = $1 and d.status <> 'cancelled' order by d.stop_order desc, o.number, g.class_name nulls first, b.kind desc, b.seq`,
    [dailyRouteId],
  );
}

/**
 * Sets in how many boxes a delivery goes out. Each new box gets its own code. Boxes are taken off from the end,
 * and only while they were not loaded: a box that is already on the vehicle is not made to disappear.
 */
export async function setBoxCount(q: Q, deliveryId: string, count: number, userId: string): Promise<void> {
  if (!Number.isInteger(count) || count < 1 || count > 99) throw new ShippingError("מספר הארגזים צריך להיות בין 1 ל-99.");
  const [d] = await q<{ status: string; loaded: boolean }>("select status::text, loaded_at is not null as loaded from deliveries where id = $1 for update", [deliveryId]);
  if (!d) throw new ShippingError("האספקה לא נמצאה.");
  if (d.status === "cancelled") throw new ShippingError("האספקה בוטלה.");
  const boxes = await q<{ seq: number; loaded: boolean }>("select seq, loaded_at is not null as loaded from delivery_boxes where delivery_id = $1 order by seq for update", [deliveryId]);
  if (boxes.length === count) return;
  const [grouped] = await q("select 1 from delivery_boxes where delivery_id = $1 and group_id is not null limit 1", [deliveryId]);
  if (grouped) throw new ShippingError("באספקת אוכל חם יש ארגז חם וארגז קר לכל כיתה, ומספר הארגזים נקבע לפי ההזמנה של מילגם.");
  if (d.status === "shipped" || d.status === "delivered") throw new ShippingError("האספקה כבר יצאה. אי אפשר לשנות את מספר הארגזים שלה.");
  if (count > boxes.length) {
    const last = Math.max(0, ...boxes.map((b) => b.seq));
    for (let seq = last + 1; seq <= last + count - boxes.length; seq++) await q("insert into delivery_boxes (delivery_id, seq) values ($1, $2)", [deliveryId, seq]);
    // A delivery that was complete is not complete any more: the new box still has to be loaded.
    if (d.loaded) await q("update deliveries set loaded_at = null, loaded_by = null where id = $1", [deliveryId]);
  } else {
    const drop = boxes.slice(count);
    if (drop.some((b) => b.loaded)) throw new ShippingError("אי אפשר להוריד ארגז שכבר הועמס. קודם מבטלים את סימון ההעמסה.");
    await q("delete from delivery_boxes where delivery_id = $1 and seq = any($2::int[])", [deliveryId, drop.map((b) => b.seq)]);
    if (!d.loaded && boxes.slice(0, count).every((b) => b.loaded)) await q("update deliveries set loaded_at = now(), loaded_by = $2 where id = $1", [deliveryId, userId]);
  }
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'box_count', 'delivery', $2, $3, $4)", [userId, deliveryId, JSON.stringify({ boxes: boxes.length }), JSON.stringify({ boxes: count })]);
}
