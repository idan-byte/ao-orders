// Where delivery addresses are on the map: the text sent to the address search, recording its answer,
// placing an address by hand, and the stops of one daily route for the map.
import type { Q } from "./auth-core.ts";

export class GeoError extends Error {}

export type Point = { lat: number; lng: number };

// Anything outside this box is a wrong answer for a delivery in Israel.
const BOUNDS = { south: 29.3, north: 33.5, west: 34.1, east: 36.0 };
export const inIsrael = (p: Point) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= BOUNDS.south && p.lat <= BOUNDS.north && p.lng >= BOUNDS.west && p.lng <= BOUNDS.east;

const audit = (q: Q, userId: string | null, action: string, entityId: string, after: unknown) =>
  q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'address', $3, $4)", [userId, action, entityId, JSON.stringify(after)]);

/**
 * The text to search for an address, or null when there is nothing worth searching.
 * Only the street and the city are used: never the customer's name. Phone numbers and remarks in
 * brackets, which came with addresses from the accounting system, are removed.
 */
export function geocodeQuery(street: string | null, city: string | null): string | null {
  const clean = (v: string | null) =>
    (v ?? "")
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(/(?<!\d)(?:\+972|0)[\d\s-]{7,}\d/g, " ")
      .replace(/(?:טל|טלפון|נייד|פקס)['׳.:]*\s*/g, " ")
      .replace(/["״]/g, "")
      .replace(/\s*[,;/]+\s*/g, ", ")
      .replace(/\s+/g, " ")
      .replace(/^[\s,.-]+|[\s,.-]+$/g, "");
  const s = clean(street);
  const c = clean(city);
  if ((s.match(/\p{L}/gu) ?? []).length < 2) return null;
  // The city is often already written inside the street line.
  return c && !s.includes(c) ? `${s}, ${c}` : s;
}

/** Reads the answer of a Nominatim-style search: the first result that is inside Israel. */
export function parseSearchResult(json: unknown): Point | null {
  if (!Array.isArray(json)) return null;
  for (const r of json) {
    const p = { lat: Number((r as { lat?: unknown })?.lat), lng: Number((r as { lon?: unknown })?.lon) };
    if (inIsrael(p)) return { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
  }
  return null;
}

export type PendingAddress = { id: string; query: string | null };

/**
 * Addresses of one daily route that should be searched now: never searched, or searched with a text that
 * has changed since. An address placed by hand is never searched again.
 */
export async function pendingForRoute(q: Q, dailyRouteId: string): Promise<PendingAddress[]> {
  const rows = await q<{ id: string; street: string; city: string | null; geocode_status: string | null; geocode_query: string | null }>(
    `select distinct a.id::text, a.street, a.city, a.geocode_status, a.geocode_query
     from deliveries d join customer_addresses a on a.id = d.address_id
     where d.daily_route_id = $1 and d.status <> 'cancelled' and a.geocode_status is distinct from 'manual'
     order by a.id::text`,
    [dailyRouteId],
  );
  return rows
    .map((r) => ({ id: r.id, query: geocodeQuery(r.street, r.city), status: r.geocode_status, last: r.geocode_query }))
    .filter((r) => r.status === null || (r.last ?? null) !== r.query)
    .map((r) => ({ id: r.id, query: r.query }));
}

/** Writes what the search answered for one address. A hand-placed address is left alone. */
export async function recordSearch(q: Q, addressId: string, query: string | null, point: Point | null): Promise<void> {
  await q(
    `update customer_addresses set latitude = $3, longitude = $4, geocode_status = $5, geocode_query = $2, geocoded_at = now()
     where id = $1 and geocode_status is distinct from 'manual'`,
    [addressId, query, point?.lat ?? null, point?.lng ?? null, point ? "found" : "not_found"],
  );
}

/** A person puts the address on the map. This wins over any search, now and later. */
export async function setManualLocation(q: Q, addressId: string, point: Point, userId: string): Promise<void> {
  if (!inIsrael(point)) throw new GeoError("הנקודה שנבחרה מחוץ לישראל. יש לבחור נקודה על המפה.");
  const lat = Math.round(point.lat * 1e6) / 1e6;
  const lng = Math.round(point.lng * 1e6) / 1e6;
  const rows = await q("update customer_addresses set latitude = $2, longitude = $3, geocode_status = 'manual', geocoded_at = now() where id = $1 returning id", [addressId, lat, lng]);
  if (rows.length === 0) throw new GeoError("הכתובת לא נמצאה.");
  await audit(q, userId, "address_location", addressId, { lat, lng });
}

/** Removes the location, so the address is searched again next time. */
export async function clearLocation(q: Q, addressId: string, userId: string): Promise<void> {
  const rows = await q("update customer_addresses set latitude = null, longitude = null, geocode_status = null, geocode_query = null, geocoded_at = null where id = $1 returning id", [addressId]);
  if (rows.length === 0) throw new GeoError("הכתובת לא נמצאה.");
  await audit(q, userId, "address_location_cleared", addressId, {});
}

export type MapStop = {
  stop: number;
  customers: string[];
  address: string | null;
  addressId: string | null;
  point: Point | null;
  /** found | manual | not_found | null (never searched) | "none" when the delivery has no address record. */
  location: "found" | "manual" | "not_found" | "pending" | "none";
  deliveries: number;
  delivered: number;
};

/** The stops of one daily route in delivery order, each with its place on the map when it is known. */
export async function routeMap(q: Q, dailyRouteId: string): Promise<MapStop[]> {
  const rows = await q<{ stop: number; customers: string[]; address: string | null; address_id: string | null; lat: number | null; lng: number | null; status: string | null; deliveries: number; delivered: number }>(
    `select d.stop_order as stop, array_agg(distinct c.name order by c.name) as customers, min(d.address_snapshot) as address,
            min(a.id::text) as address_id, min(a.latitude)::float as lat, min(a.longitude)::float as lng, min(a.geocode_status) as status,
            count(*)::int as deliveries, count(*) filter (where d.status = 'delivered')::int as delivered
     from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     left join customer_addresses a on a.id = d.address_id
     where d.daily_route_id = $1 and d.status <> 'cancelled'
     group by d.stop_order order by d.stop_order`,
    [dailyRouteId],
  );
  return rows.map((r) => {
    const point = r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null;
    const location: MapStop["location"] = r.address_id === null ? "none" : point && (r.status === "found" || r.status === "manual") ? r.status : r.status === "not_found" ? "not_found" : "pending";
    return { stop: r.stop, customers: r.customers, address: r.address, addressId: r.address_id, point, location, deliveries: r.deliveries, delivered: r.delivered };
  });
}
