// Distribution alerts and exceptions, in one list. Two kinds:
//  - state alerts are computed from the data and disappear by themselves when the problem is fixed
//    (a delivery with no route, a route with no driver, a route that never left, a route that was not finished);
//  - event alerts come from something that happened (a delivery left behind, a refused attempt) and stay
//    open until a manager marks them handled.
// No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { ShippingError } from "./shipping-core.ts";

export type Severity = "high" | "medium" | "low";
export type Alert = {
  key: string;
  type: string;
  severity: Severity;
  title: string;
  detail: string;
  date: string | null; // the delivery date it concerns
  at: string | null; // when it happened, for event alerts
  route: string | null;
  link: string | null;
  eventId: number | null; // set for alerts a manager has to mark as handled
};

export const ALERT_TYPE: Record<string, string> = {
  unfinished_route: "קו שלא הושלם",
  not_departed: "קו שלא יצא",
  left_behind: "אספקה שנשארה מאחור",
  unassigned: "אספקות בלי קו",
  no_driver: "קו בלי נהג",
  delivery_problem: "אספקה בחריגה או בעיכוב",
  departed_with_missing: "קו יצא בלי כל האספקות",
  wrong_route_attempt: "ניסיון סימון בקו לא נכון",
  unload_before_load: "ניסיון מסירה לפני העמסה",
};
const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Every open alert. `today` is passed in so the caller decides the clock (the database clock in the app, a fixed date in tests). */
export async function shippingAlerts(q: Q, today: string): Promise<Alert[]> {
  const alerts: Alert[] = [];

  // A route that left on an earlier day and still has deliveries on the vehicle.
  for (const r of await q<{ id: string; name: string; date: string; n: number; driver: string | null }>(
    `select dr.id::text, r.name, dr.route_date::text as date, count(d.id)::int as n, dv.name as driver
     from daily_routes dr join routes r on r.id = dr.route_id left join drivers dv on dv.id = dr.driver_id
     join deliveries d on d.daily_route_id = dr.id and d.status = 'shipped'
     where dr.mode = 'unloading' and dr.route_date < $1::date group by dr.id, r.name, dv.name order by dr.route_date`,
    [today],
  )) {
    alerts.push({ key: `unfinished:${r.id}`, type: "unfinished_route", severity: "high", title: `${r.name}: ${r.n} אספקות יצאו ולא סומנו כנמסרו`, detail: r.driver ? `נהג: ${r.driver}. יש לסמן מסירה או לסגור את הקו עם הסבר.` : "יש לסמן מסירה או לסגור את הקו עם הסבר.", date: r.date, at: null, route: r.name, link: `/drive/${r.id}`, eventId: null });
  }

  // A route whose day has come (or passed) and that is still being loaded.
  for (const r of await q<{ id: string; name: string; date: string; n: number; loaded: number }>(
    `select dr.id::text, r.name, dr.route_date::text as date, count(d.id)::int as n, count(d.loaded_at)::int as loaded
     from daily_routes dr join routes r on r.id = dr.route_id
     join deliveries d on d.daily_route_id = dr.id and d.status not in ('cancelled', 'exception', 'delayed')
     where dr.mode = 'loading' and dr.route_date < $1::date group by dr.id, r.name order by dr.route_date`,
    [today],
  )) {
    alerts.push({ key: `not_departed:${r.id}`, type: "not_departed", severity: "high", title: `${r.name}: הקו לא יצא להפצה`, detail: `${r.n} אספקות על הקו, ${r.loaded} מהן סומנו כהועמסו.`, date: r.date, at: null, route: r.name, link: `/drive/${r.id}`, eventId: null });
  }

  // Deliveries for today and tomorrow that are on no route.
  for (const r of await q<{ date: string; n: number }>(
    `select delivery_date::text as date, count(*)::int as n from deliveries
     where daily_route_id is null and status in ('approved', 'in_production', 'ready_to_ship') and delivery_date between $1::date and $1::date + 1
     group by delivery_date order by delivery_date`,
    [today],
  )) {
    alerts.push({ key: `unassigned:${r.date}`, type: "unassigned", severity: r.date === today ? "high" : "medium", title: `${r.n} אספקות ${r.date === today ? "של היום" : "של מחר"} עדיין בלי קו`, detail: "יש לשבץ אותן במערך השילוח.", date: r.date, at: null, route: null, link: `/shipping?date=${r.date}`, eventId: null });
  }

  // Routes for today and tomorrow that carry deliveries and have no driver.
  for (const r of await q<{ id: string; name: string; date: string }>(
    `select dr.id::text, r.name, dr.route_date::text as date from daily_routes dr join routes r on r.id = dr.route_id
     where dr.driver_id is null and dr.mode = 'loading' and dr.route_date between $1::date and $1::date + 1
       and exists (select 1 from deliveries d where d.daily_route_id = dr.id and d.status <> 'cancelled')
     order by dr.route_date, r.name`,
    [today],
  )) {
    alerts.push({ key: `no_driver:${r.id}`, type: "no_driver", severity: r.date === today ? "high" : "medium", title: `${r.name}: לא נבחר נהג`, detail: "בלי נהג הקו אינו יכול לצאת להפצה.", date: r.date, at: null, route: r.name, link: `/shipping/day/${r.id}`, eventId: null });
  }

  // Deliveries from today on that are marked as an exception or delayed.
  for (const r of await q<{ id: string; order_id: string; number: number; customer: string; date: string; status: string; note: string | null; route: string | null }>(
    `select d.id::text, o.id::text as order_id, o.number, c.name as customer, d.delivery_date::text as date, d.status::text, d.exception_note as note,
            (select r.name from daily_routes dr join routes r on r.id = dr.route_id where dr.id = d.daily_route_id) as route
     from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     where d.status in ('exception', 'delayed') and d.delivery_date >= $1::date - 7 order by d.delivery_date, o.number`,
    [today],
  )) {
    alerts.push({ key: `problem:${r.id}`, type: "delivery_problem", severity: "medium", title: `הזמנה ${r.number} · ${r.customer}: ${r.status === "delayed" ? "מעוכבת" : "בחריגה"}`, detail: r.note ?? "", date: r.date, at: null, route: r.route, link: `/orders/${r.order_id}`, eventId: null });
  }

  // Things that happened and wait for a manager to mark them handled.
  for (const e of await q<{ id: number; event_type: string; at: string; date: string | null; route: string | null; route_id: string | null; number: number | null; customer: string | null; order_id: string | null; who: string | null; metadata: { reason?: string | null; leftBehind?: number[] } | null }>(
    `select e.id::int, e.event_type, e.created_at::text as at, dr.route_date::text as date, r.name as route, dr.id::text as route_id,
            o.number, c.name as customer, o.id::text as order_id, u.full_name as who, e.metadata
     from shipping_events e
     left join daily_routes dr on dr.id = e.daily_route_id left join routes r on r.id = dr.route_id
     left join deliveries d on d.id = e.delivery_id left join orders o on o.id = d.order_id left join customers c on c.id = o.customer_id
     left join users u on u.id = e.performed_by
     where e.resolved_at is null
       and (e.event_type in ('left_behind', 'wrong_route_attempt', 'unload_before_load')
            or (e.event_type = 'departed' and coalesce(e.metadata->>'reason', '') <> ''))
     order by e.created_at desc limit 200`,
  )) {
    const by = e.who ? ` · ${e.who}` : "";
    if (e.event_type === "left_behind") {
      alerts.push({ key: `event:${e.id}`, type: "left_behind", severity: "high", title: `הזמנה ${e.number} · ${e.customer} נשארה מאחור`, detail: `הקו ${e.route} יצא בלעדיה${e.metadata?.reason ? `: ${e.metadata.reason}` : ""}. היא חזרה לרשימת האספקות שלא שובצו.${by}`, date: e.date, at: e.at, route: e.route, link: e.date ? `/shipping?date=${e.date}` : null, eventId: e.id });
    } else if (e.event_type === "departed") {
      alerts.push({ key: `event:${e.id}`, type: "departed_with_missing", severity: "medium", title: `${e.route} יצא בלי ${e.metadata?.leftBehind?.length ?? 0} אספקות`, detail: `סיבה: ${e.metadata?.reason}${by}`, date: e.date, at: e.at, route: e.route, link: e.route_id ? `/drive/${e.route_id}` : null, eventId: e.id });
    } else {
      alerts.push({ key: `event:${e.id}`, type: e.event_type, severity: "low", title: `${ALERT_TYPE[e.event_type]}: הזמנה ${e.number} · ${e.customer}`, detail: `בקו ${e.route}. הפעולה נדחתה ולא נרשם סימון.${by}`, date: e.date, at: e.at, route: e.route, link: e.order_id ? `/orders/${e.order_id}` : null, eventId: e.id });
    }
  }

  return alerts.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.date ?? "").localeCompare(b.date ?? "") || a.key.localeCompare(b.key));
}

export async function resolveEvent(q: Q, eventId: number, userId: string, note: string | null): Promise<void> {
  const rows = await q("update shipping_events set resolved_at = now(), resolved_by = $2, resolution = $3 where id = $1 and resolved_at is null returning id", [eventId, userId, (note ?? "").trim() || null]);
  if (rows.length === 0) throw new ShippingError("ההתראה לא נמצאה או שכבר טופלה.");
}

export type Handled = { id: number; type: string; title: string; at: string; resolvedAt: string; resolvedBy: string | null; resolution: string | null };

export async function recentlyHandled(q: Q, limit = 20): Promise<Handled[]> {
  const rows = await q<{ id: number; event_type: string; at: string; resolved_at: string; who: string | null; resolution: string | null; route: string | null; number: number | null; customer: string | null; reason: string | null }>(
    `select e.id::int, e.event_type, e.created_at::text as at, e.resolved_at::text, u.full_name as who, e.resolution, r.name as route, o.number, c.name as customer, e.metadata->>'reason' as reason
     from shipping_events e left join users u on u.id = e.resolved_by
     left join daily_routes dr on dr.id = e.daily_route_id left join routes r on r.id = dr.route_id
     left join deliveries d on d.id = e.delivery_id left join orders o on o.id = d.order_id left join customers c on c.id = o.customer_id
     where e.resolved_at is not null order by e.resolved_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => {
    const type = r.event_type === "departed" ? "departed_with_missing" : r.event_type;
    return { id: r.id, type, title: r.number ? `${ALERT_TYPE[type]}: הזמנה ${r.number} · ${r.customer}` : `${ALERT_TYPE[type]}: ${r.route}`, at: r.at, resolvedAt: r.resolved_at, resolvedBy: r.who, resolution: r.resolution };
  });
}

/**
 * Closes a route that left although some deliveries were never handed over. Each of them is marked as an
 * exception with the reason, so the order shows what happened and someone decides what to do with it.
 */
export async function closeRoute(q: Q, dailyRouteId: string, userId: string, reason: string): Promise<number> {
  const [route] = await q<{ mode: string }>("select mode from daily_routes where id = $1 for update", [dailyRouteId]);
  if (!route) throw new ShippingError("הקו לא נמצא.");
  if (route.mode !== "unloading") throw new ShippingError("הקו עוד לא יצא להפצה, ולכן אין מה לסגור.");
  const note = reason.trim();
  const open = await q<{ id: string }>("select id::text from deliveries where daily_route_id = $1 and status = 'shipped' for update", [dailyRouteId]);
  if (open.length === 0) throw new ShippingError("כל האספקות בקו כבר נמסרו.");
  if (note.length < 3) throw new ShippingError("יש לכתוב למה האספקות לא נמסרו.");
  for (const d of open) {
    await q("update deliveries set status = 'exception', exception_note = $2, status_before_hold = 'shipped' where id = $1", [d.id, `לא נמסרה בקו: ${note}`]);
    await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'delivery_status', 'delivery', $2, $3, $4)", [userId, d.id, JSON.stringify({ status: "shipped" }), JSON.stringify({ status: "exception", note: `לא נמסרה בקו: ${note}` })]);
  }
  await q("update daily_routes set delivery_completed_at = now() where id = $1", [dailyRouteId]);
  await q("insert into shipping_events (daily_route_id, event_type, source, performed_by, metadata, resolved_at, resolved_by) values ($1, 'route_closed', 'admin', $2, $3, now(), $2)", [dailyRouteId, userId, JSON.stringify({ reason: note, undelivered: open.length })]);
  return open.length;
}
