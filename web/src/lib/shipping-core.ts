// Distribution: permanent routes, drivers and vehicles, and assigning each day's deliveries to routes.
// No dependency on Next.js.
import type { Q } from "./auth-core.ts";

export class ShippingError extends Error {}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t === "" ? null : t;
};
/** Deliveries that still have to leave the factory. Drafts, delivered and cancelled ones are not planned. */
const PLANNABLE = "('approved', 'in_production', 'ready_to_ship')";
const audit = (q: Q, userId: string | null, action: string, entityType: string, entityId: string, after: unknown) =>
  q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, $3, $4, $5)", [userId, action, entityType, entityId, JSON.stringify(after)]);

// ---------- drivers and vehicles

export type DriverInput = { name: string; phone: string | null; vehicleRegistration: string | null; vehicleDescription: string | null };

export async function saveDriver(q: Q, id: number | null, input: DriverInput, userId: string): Promise<number> {
  const name = clean(input.name);
  if (!name || name.length < 2) throw new ShippingError("יש למלא את שם הנהג.");
  const phone = clean(input.phone)?.replace(/[^\d+]/g, "") ?? null;
  if (phone && !/^\+?\d{9,13}$/.test(phone)) throw new ShippingError("מספר הטלפון אינו תקין.");
  const registration = clean(input.vehicleRegistration);
  let vehicleId: number | null = null;
  if (registration) {
    if (!/^[\d-]{5,10}$/.test(registration)) throw new ShippingError("מספר הרכב אינו תקין (ספרות ומקפים בלבד).");
    const [taken] = await q<{ name: string }>("select d.name from drivers d join vehicles v on v.id = d.vehicle_id where v.registration = $1 and d.active and d.id is distinct from $2::int", [registration, id]);
    if (taken) throw new ShippingError(`הרכב ${registration} כבר משויך לנהג ${taken.name}.`);
    const [v] = await q<{ id: number }>(
      "insert into vehicles (registration, description) values ($1, $2) on conflict (registration) do update set description = coalesce(excluded.description, vehicles.description), active = true returning id",
      [registration, clean(input.vehicleDescription)],
    );
    vehicleId = v.id;
  }
  let saved: number;
  if (id === null) {
    const [row] = await q<{ id: number }>("insert into drivers (name, phone, vehicle_id) values ($1, $2, $3) returning id", [name, phone, vehicleId]);
    saved = row.id;
  } else {
    const rows = await q("update drivers set name = $2, phone = $3, vehicle_id = $4 where id = $1 returning id", [id, name, phone, vehicleId]);
    if (rows.length === 0) throw new ShippingError("הנהג לא נמצא.");
    saved = id;
  }
  await audit(q, userId, id === null ? "create_driver" : "update_driver", "driver", String(saved), { name, vehicle: registration });
  return saved;
}

export async function setDriverActive(q: Q, id: number, active: boolean): Promise<void> {
  const rows = await q("update drivers set active = $2 where id = $1 returning id", [id, active]);
  if (rows.length === 0) throw new ShippingError("הנהג לא נמצא.");
  // A driver who left no longer drives any line by default. Past days keep their record.
  if (!active) await q("update routes set default_driver_id = null where default_driver_id = $1", [id]);
}

// ---------- permanent routes

export async function saveRoute(q: Q, id: number | null, input: { name: string; description: string | null; defaultDriverId: number | null }, userId: string): Promise<number> {
  const name = clean(input.name);
  if (!name || name.length < 2) throw new ShippingError("יש לתת שם לקו.");
  const [clash] = await q("select 1 from routes where name = $1 and id is distinct from $2::int", [name, id]);
  if (clash) throw new ShippingError("כבר קיים קו בשם הזה.");
  if (input.defaultDriverId !== null) {
    const [d] = await q<{ active: boolean }>("select active from drivers where id = $1", [input.defaultDriverId]);
    if (!d || !d.active) throw new ShippingError("הנהג שנבחר אינו פעיל.");
  }
  let saved: number;
  if (id === null) {
    const [row] = await q<{ id: number }>("insert into routes (name, description, default_driver_id) values ($1, $2, $3) returning id", [name, clean(input.description), input.defaultDriverId]);
    saved = row.id;
  } else {
    const rows = await q("update routes set name = $2, description = $3, default_driver_id = $4 where id = $1 returning id", [id, name, clean(input.description), input.defaultDriverId]);
    if (rows.length === 0) throw new ShippingError("הקו לא נמצא.");
    saved = id;
  }
  await audit(q, userId, id === null ? "create_route" : "update_route", "route", String(saved), { name, defaultDriverId: input.defaultDriverId });
  return saved;
}

export async function setRouteActive(q: Q, id: number, active: boolean): Promise<void> {
  const rows = await q("update routes set active = $2 where id = $1 returning id", [id, active]);
  if (rows.length === 0) throw new ShippingError("הקו לא נמצא.");
}

async function renumberRoute(q: Q, routeId: number): Promise<void> {
  await q(
    `update customer_addresses a set route_order = x.n
     from (select id, row_number() over (order by route_order nulls last, street, id)::int as n from customer_addresses where route_id = $1) x
     where a.id = x.id and a.route_order is distinct from x.n`,
    [routeId],
  );
}

/** Puts a delivery address on a permanent line (at the end of its order), or with null takes it off its line. Affects future planning only. */
export async function setAddressRoute(q: Q, addressId: string, routeId: number | null, userId: string): Promise<void> {
  const [a] = await q<{ route_id: number | null }>("select route_id from customer_addresses where id = $1", [addressId]);
  if (!a) throw new ShippingError("הכתובת לא נמצאה.");
  if (a.route_id === routeId) return;
  if (routeId !== null) {
    const [r] = await q<{ active: boolean }>("select active from routes where id = $1", [routeId]);
    if (!r) throw new ShippingError("הקו לא נמצא.");
    if (!r.active) throw new ShippingError("הקו אינו פעיל.");
  }
  await q("update customer_addresses set route_id = $2, route_order = (select coalesce(max(route_order), 0) + 1 from customer_addresses where route_id = $2) where id = $1", [addressId, routeId]);
  if (a.route_id !== null) await renumberRoute(q, a.route_id);
  await audit(q, userId, "address_route", "address", addressId, { from: a.route_id, to: routeId });
}

/** Moves an address one place earlier (-1) or later (+1) in the permanent delivery order of its line. */
export async function moveAddress(q: Q, addressId: string, direction: -1 | 1): Promise<void> {
  const [a] = await q<{ route_id: number | null; route_order: number | null }>("select route_id, route_order from customer_addresses where id = $1", [addressId]);
  if (!a || a.route_id === null || a.route_order === null) throw new ShippingError("הכתובת אינה משויכת לקו.");
  const [other] = await q<{ id: string }>("select id::text from customer_addresses where route_id = $1 and route_order = $2", [a.route_id, a.route_order + direction]);
  if (!other) return;
  await q("update customer_addresses set route_order = $2 where id = $1", [other.id, a.route_order]);
  await q("update customer_addresses set route_order = $2 where id = $1", [addressId, a.route_order + direction]);
}

// ---------- the daily plan

async function ensureDailyRoute(q: Q, date: string, routeId: number): Promise<string> {
  const [existing] = await q<{ id: string }>("select id::text from daily_routes where route_date = $1::date and route_id = $2", [date, routeId]);
  if (existing) return existing.id;
  const [r] = await q<{ active: boolean; driver_id: number | null; vehicle_id: number | null }>(
    "select r.active, d.id as driver_id, d.vehicle_id from routes r left join drivers d on d.id = r.default_driver_id and d.active where r.id = $1",
    [routeId],
  );
  if (!r) throw new ShippingError("הקו לא נמצא.");
  if (!r.active) throw new ShippingError("הקו אינו פעיל.");
  const [row] = await q<{ id: string }>("insert into daily_routes (route_date, route_id, driver_id, vehicle_id) values ($1::date, $2, $3, $4) returning id::text", [date, routeId, r.driver_id, r.vehicle_id]);
  return row.id;
}

/** Stop numbers of a daily route become 1..n with no gaps. Deliveries to the same address share one stop. */
async function renumberDaily(q: Q, dailyRouteId: string): Promise<void> {
  await q(
    `update deliveries d set stop_order = x.n
     from (
       select id, dense_rank() over (order by first_order, stop_key)::int as n
       from (
         select id, coalesce(address_id::text, id::text) as stop_key,
                min(coalesce(stop_order, 100000)) over (partition by coalesce(address_id::text, id::text)) as first_order
         from deliveries where daily_route_id = $1 and status <> 'cancelled'
       ) s
     ) x
     where d.id = x.id and d.stop_order is distinct from x.n`,
    [dailyRouteId],
  );
}

export type PlanResult = { assigned: number; routes: number; unassigned: number };

/**
 * Assigns the day's deliveries to their permanent lines, in the permanent delivery order. Safe to run again:
 * deliveries already on a line are left exactly where a person put them. Deliveries whose address has no
 * permanent line stay unassigned for a person to place.
 */
export async function planDay(q: Q, date: string, userId: string | null): Promise<PlanResult> {
  if (!isDate(date)) throw new ShippingError("התאריך אינו תקין.");
  // A delivery whose date was changed after it was planned no longer belongs to the old day's line.
  const moved = await q<{ daily_route_id: string }>("select distinct d.daily_route_id::text from deliveries d join daily_routes dr on dr.id = d.daily_route_id where dr.route_date <> d.delivery_date");
  if (moved.length > 0) {
    await q("update deliveries d set daily_route_id = null, stop_order = null from daily_routes dr where dr.id = d.daily_route_id and dr.route_date <> d.delivery_date");
    for (const m of moved) await renumberDaily(q, m.daily_route_id);
  }
  const due = await q<{ id: string; address_id: string; route_id: number; route_order: number | null }>(
    `select d.id::text, d.address_id::text, a.route_id, a.route_order
     from deliveries d join customer_addresses a on a.id = d.address_id join routes r on r.id = a.route_id and r.active
     where d.delivery_date = $1::date and d.daily_route_id is null and d.status in ${PLANNABLE}
     order by a.route_id, a.route_order nulls last, d.window_from nulls last, d.id`,
    [date],
  );
  const touched = new Map<number, { id: string; fresh: boolean }>();
  for (const d of due) {
    let daily = touched.get(d.route_id);
    if (!daily) {
      const [open] = await q("select 1 from daily_routes where route_date = $1::date and route_id = $2", [date, d.route_id]);
      daily = { id: await ensureDailyRoute(q, date, d.route_id), fresh: !open };
      touched.set(d.route_id, daily);
    }
    if (daily.fresh) {
      // A route opened by this run is laid out in the permanent delivery order.
      await q("update deliveries set daily_route_id = $2, stop_order = $3 where id = $1", [d.id, daily.id, d.route_order ?? 100000]);
    } else {
      // The route was already planned, and a person may have rearranged it: nothing that is there moves.
      // A late delivery joins the stop of its address, or becomes a new last stop.
      await q(
        `update deliveries set daily_route_id = $2,
           stop_order = coalesce((select min(stop_order) from deliveries where daily_route_id = $2 and address_id = $3 and status <> 'cancelled'),
                                 (select coalesce(max(stop_order), 0) + 1 from deliveries where daily_route_id = $2 and status <> 'cancelled'))
         where id = $1`,
        [d.id, daily.id, d.address_id],
      );
    }
  }
  for (const daily of touched.values()) await renumberDaily(q, daily.id);
  const [{ n: unassigned }] = await q<{ n: number }>(`select count(*)::int as n from deliveries where delivery_date = $1::date and daily_route_id is null and status in ${PLANNABLE}`, [date]);
  const [{ n: routes }] = await q<{ n: number }>("select count(*)::int as n from daily_routes where route_date = $1::date", [date]);
  if (due.length > 0) await audit(q, userId, "plan_day", "shipping_day", date, { assigned: due.length, unassigned });
  return { assigned: due.length, routes, unassigned };
}

/**
 * Puts one delivery on a line for its own date (at the end of that line's order), or with null takes it off.
 * `permanent` also makes that line the address's permanent line, so tomorrow's planning does it by itself.
 */
export async function assignDelivery(q: Q, deliveryId: string, routeId: number | null, permanent: boolean, userId: string): Promise<void> {
  const [d] = await q<{ status: string; delivery_date: string; address_id: string | null; daily_route_id: string | null }>("select status::text, delivery_date::text, address_id::text, daily_route_id::text from deliveries where id = $1", [deliveryId]);
  if (!d) throw new ShippingError("האספקה לא נמצאה.");
  if (d.status === "cancelled" || d.status === "delivered" || d.status === "shipped") throw new ShippingError("אי אפשר לשבץ אספקה שכבר יצאה, נמסרה או בוטלה.");
  const from = d.daily_route_id;
  let to: string | null = null;
  if (routeId !== null) {
    to = await ensureDailyRoute(q, d.delivery_date, routeId);
    if (to !== from) {
      // Another delivery to the same address on that line means the same stop.
      const [same] = d.address_id ? await q<{ stop_order: number }>("select stop_order from deliveries where daily_route_id = $1 and address_id = $2 and status <> 'cancelled' limit 1", [to, d.address_id]) : [];
      await q("update deliveries set daily_route_id = $2, stop_order = coalesce($3::int, (select coalesce(max(stop_order), 0) + 1 from deliveries where daily_route_id = $2)) where id = $1", [deliveryId, to, same?.stop_order ?? null]);
      await renumberDaily(q, to);
    }
    if (permanent && d.address_id) await setAddressRoute(q, d.address_id, routeId, userId);
  } else if (from) {
    await q("update deliveries set daily_route_id = null, stop_order = null where id = $1", [deliveryId]);
  }
  if (from && from !== to) await renumberDaily(q, from);
  if (from !== to) await audit(q, userId, "assign_delivery", "delivery", deliveryId, { from, to, permanent: permanent && routeId !== null });
}

/** Moves a whole stop (every delivery to that address) one place earlier (-1) or later (+1) in today's order only. */
export async function moveStop(q: Q, dailyRouteId: string, stopOrder: number, direction: -1 | 1): Promise<void> {
  const target = stopOrder + direction;
  const [exists] = await q("select 1 from deliveries where daily_route_id = $1 and stop_order = $2 and status <> 'cancelled' limit 1", [dailyRouteId, target]);
  if (!exists || target < 1) return;
  await q("update deliveries set stop_order = case when stop_order = $2 then $3 else $2 end where daily_route_id = $1 and stop_order in ($2, $3)", [dailyRouteId, stopOrder, target]);
}

/** Chooses who drives a line on one day. The vehicle follows the driver. The permanent line is not changed. */
export async function setDailyDriver(q: Q, dailyRouteId: string, driverId: number | null, userId: string): Promise<void> {
  const [dr] = await q<{ route_date: string; driver_id: number | null }>("select route_date::text, driver_id from daily_routes where id = $1", [dailyRouteId]);
  if (!dr) throw new ShippingError("הקו היומי לא נמצא.");
  let vehicleId: number | null = null;
  if (driverId !== null) {
    const [d] = await q<{ active: boolean; vehicle_id: number | null; name: string }>("select active, vehicle_id, name from drivers where id = $1", [driverId]);
    if (!d || !d.active) throw new ShippingError("הנהג שנבחר אינו פעיל.");
    const [busy] = await q<{ name: string }>("select r.name from daily_routes dr join routes r on r.id = dr.route_id where dr.route_date = $1::date and dr.driver_id = $2 and dr.id <> $3", [dr.route_date, driverId, dailyRouteId]);
    if (busy) throw new ShippingError(`${d.name} כבר משובץ היום לקו ${busy.name}.`);
    vehicleId = d.vehicle_id;
  }
  await q("update daily_routes set driver_id = $2, vehicle_id = $3 where id = $1", [dailyRouteId, driverId, vehicleId]);
  if (dr.driver_id !== driverId) await audit(q, userId, "daily_driver", "daily_route", dailyRouteId, { from: dr.driver_id, to: driverId });
}

// ---------- reading

export type DayRoute = { id: string; routeId: number; name: string; driver: string | null; driverPhone: string | null; vehicle: string | null; stops: number; deliveries: number; units: number; mode: string };

export async function dayRoutes(q: Q, date: string): Promise<DayRoute[]> {
  const rows = await q<{ id: string; route_id: number; name: string; driver: string | null; phone: string | null; vehicle: string | null; stops: number; deliveries: number; units: number; mode: string }>(
    `select dr.id::text, dr.route_id, r.name, dv.name as driver, dv.phone, v.registration as vehicle, dr.mode,
            count(distinct d.stop_order)::int as stops, count(d.id)::int as deliveries,
            coalesce(sum((select sum(l.quantity) from delivery_lines l where l.delivery_id = d.id)), 0)::float as units
     from daily_routes dr join routes r on r.id = dr.route_id
     left join drivers dv on dv.id = dr.driver_id left join vehicles v on v.id = dr.vehicle_id
     left join deliveries d on d.daily_route_id = dr.id and d.status <> 'cancelled'
     where dr.route_date = $1::date
     group by dr.id, r.name, dv.name, dv.phone, v.registration
     order by r.name`,
    [date],
  );
  return rows.map((r) => ({ id: r.id, routeId: r.route_id, name: r.name, driver: r.driver, driverPhone: r.phone, vehicle: r.vehicle, stops: r.stops, deliveries: r.deliveries, units: r.units, mode: r.mode }));
}

export type PlanDelivery = { id: string; orderId: string; orderNumber: number; customer: string; address: string | null; addressId: string | null; window: string | null; units: number; status: string; stopOrder: number | null; notes: string | null };

const DELIVERY_COLUMNS = `d.id::text, o.id::text as order_id, o.number, c.name as customer, d.address_snapshot as address, d.address_id::text,
  nullif(concat_ws('–', to_char(d.window_from, 'HH24:MI'), to_char(d.window_to, 'HH24:MI')), '') as window,
  coalesce((select sum(l.quantity) from delivery_lines l where l.delivery_id = d.id), 0)::float as units, d.status::text, d.stop_order, d.shipping_notes as notes`;
type DeliveryRow = { id: string; order_id: string; number: number; customer: string; address: string | null; address_id: string | null; window: string | null; units: number; status: string; stop_order: number | null; notes: string | null };
const toDelivery = (r: DeliveryRow): PlanDelivery => ({ id: r.id, orderId: r.order_id, orderNumber: r.number, customer: r.customer, address: r.address, addressId: r.address_id, window: r.window, units: r.units, status: r.status, stopOrder: r.stop_order, notes: r.notes });

/** Deliveries of the day that are not on any line yet. */
export async function unassigned(q: Q, date: string): Promise<PlanDelivery[]> {
  const rows = await q<DeliveryRow>(
    `select ${DELIVERY_COLUMNS} from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     where d.delivery_date = $1::date and d.daily_route_id is null and d.status in ${PLANNABLE}
     order by d.window_from nulls last, c.name, o.number`,
    [date],
  );
  return rows.map(toDelivery);
}

/** The deliveries of one daily route in delivery order. Loading order is the same list reversed (last stop is loaded first). */
export async function routeDeliveries(q: Q, dailyRouteId: string): Promise<PlanDelivery[]> {
  const rows = await q<DeliveryRow>(
    `select ${DELIVERY_COLUMNS} from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     where d.daily_route_id = $1 and d.status <> 'cancelled'
     order by d.stop_order, d.window_from nulls last, o.number`,
    [dailyRouteId],
  );
  return rows.map(toDelivery);
}
