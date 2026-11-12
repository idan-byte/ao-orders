// Tests the route map logic: the text sent to the address search, reading its answer, which addresses
// are searched, placing by hand, and the stops of a route for the map. Nothing here calls an outside service.
// Run from the web folder:  node scripts/check-geo.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { saveRoute, setAddressRoute, planDay, dayRoutes } from "../src/lib/shipping-core.ts";
import { geocodeQuery, parseSearchResult, inIsrael, pendingForRoute, recordSearch, setManualLocation, clearLocation, routeMap } from "../src/lib/geo-core.ts";
import { createOrder } from "../src/lib/orders-core.ts";

const db = new PGlite();
const dir = path.join(process.cwd(), "..", "db", "migrations");
for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await db.exec(await readFile(path.join(dir, f), "utf8"));
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
async function refuses(label, fn, fragment) {
  try { await fn(); failed++; console.log(`FAIL ${label} -> was accepted`); }
  catch (e) { const ok = e.message.includes(fragment); if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> wrong message: ${e.message}`}`); }
}

// ---------- the text that is searched
check("street and city", geocodeQuery("הרצל 12", "ירושלים"), "הרצל 12, ירושלים");
check("a city already written in the street is not repeated", geocodeQuery("הרצל 12 ירושלים", "ירושלים"), "הרצל 12 ירושלים");
check("no city", geocodeQuery("הרצל 12", null), "הרצל 12");
check("a phone number is removed", geocodeQuery("הרצל 12 טל: 02-6251234", "ירושלים"), "הרצל 12, ירושלים");
check("a mobile number is removed", geocodeQuery("הרצל 12, 0521234567", "ירושלים"), "הרצל 12, ירושלים");
check("a remark in brackets is removed", geocodeQuery("הרצל 12 (כניסה מאחור)", "ירושלים"), "הרצל 12, ירושלים");
check("a house number that ends in zero stays", geocodeQuery("הרצל 10", "ירושלים"), "הרצל 10, ירושלים");
check("quote marks are removed", geocodeQuery('שד"ל 4', "ירושלים"), "שדל 4, ירושלים");
check("only a phone number is not an address", geocodeQuery("02-6251234", null), null);
check("an empty street is not an address", geocodeQuery("  ", "ירושלים"), null);

// ---------- the answer of the search
check("the first result is used", parseSearchResult([{ lat: "31.7781234567", lon: "35.2251" }]), { lat: 31.778123, lng: 35.2251 });
check("a result outside Israel is skipped", parseSearchResult([{ lat: "48.85", lon: "2.35" }, { lat: "32.08", lon: "34.78" }]), { lat: 32.08, lng: 34.78 });
check("no results", parseSearchResult([]), null);
check("an answer that is not a list", parseSearchResult({ error: "x" }), null);
check("bounds", [inIsrael({ lat: 31.78, lng: 35.22 }), inIsrael({ lat: 0, lng: 0 }), inIsrael({ lat: NaN, lng: 35 })], [true, false, false]);

// ---------- a route with four stops
await q("insert into products (sku, name, base_price) values ('50088', 'קוקטיל', 5)");
await q("insert into product_ops (sku, orderable) values ('50088', true)");
const user = (await one("insert into users (mobile, full_name, role) values ('0500000040', 'מנהל שילוח', 'shipping_manager') returning id::text")).id;
const DAY = "2026-12-08";
const customers = {};
const addresses = {};
for (const [name, street] of [["גן הדר", "הרצל 12"], ["בית ספר נועם", "יפו 100"], ["גן שקד", "02-6251234"], ["משרד", "עמק רפאים 5"]]) {
  customers[name] = (await one("insert into customers (name) values ($1) returning id::text", [name])).id;
  addresses[name] = (await one("insert into customer_addresses (customer_id, street, city) values ($1, $2, 'ירושלים') returning id::text", [customers[name], street])).id;
}
const order = async (name, addressId = addresses[name]) => createOrder(q, customers[name], user, { lines: [{ sku: "50088", description: "x", quantity: 10, unitPrice: 5, variantId: null }], discountPct: 0, deliveryFee: 0, deliveryDate: DAY, windowFrom: null, windowTo: null, addressId, customerNotes: null, internalNotes: null, validUntil: null, paymentTerms: null });
const route = await saveRoute(q, null, { name: "ירושלים 1", description: null, defaultDriverId: null }, user);
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד", "משרד"]) await setAddressRoute(q, addresses[name], route, user);
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד", "משרד"]) await order(name);
await order("גן הדר");
await planDay(q, DAY, user);
const daily = (await dayRoutes(q, DAY))[0].id;
const idOf = Object.fromEntries(Object.entries(addresses).map(([k, v]) => [v, k]));

let stops = await routeMap(q, daily);
check("before any search every stop is waiting", stops.map((s) => [s.stop, s.customers[0], s.location, s.point, s.deliveries]), [[1, "גן הדר", "pending", null, 2], [2, "בית ספר נועם", "pending", null, 1], [3, "גן שקד", "pending", null, 1], [4, "משרד", "pending", null, 1]]);
let pending = await pendingForRoute(q, daily);
check("all four addresses are to be searched, one of them with no usable text", pending.map((p) => [idOf[p.id], p.query]).sort(), [["בית ספר נועם", "יפו 100, ירושלים"], ["גן הדר", "הרצל 12, ירושלים"], ["גן שקד", null], ["משרד", "עמק רפאים 5, ירושלים"]]);
check("the customer's name is never part of the searched text", pending.some((p) => p.query && Object.keys(customers).some((n) => p.query.includes(n))), false);

const byName = (name) => pending.find((p) => p.id === addresses[name]);
await recordSearch(q, addresses["גן הדר"], byName("גן הדר").query, { lat: 31.78, lng: 35.21 });
await recordSearch(q, addresses["בית ספר נועם"], byName("בית ספר נועם").query, null);
await recordSearch(q, addresses["גן שקד"], null, null);
stops = await routeMap(q, daily);
check("found, not found, no usable text, and not searched yet", stops.map((s) => [s.location, s.point]), [["found", { lat: 31.78, lng: 35.21 }], ["not_found", null], ["not_found", null], ["pending", null]]);
check("what was searched is not searched again", (await pendingForRoute(q, daily)).map((p) => idOf[p.id]), ["משרד"]);

// ---------- a changed address is searched again
await q("update customer_addresses set street = 'יפו 210' where id = $1", [addresses["בית ספר נועם"]]);
check("an address whose text changed is searched again", (await pendingForRoute(q, daily)).map((p) => [idOf[p.id], p.query]).sort(), [["בית ספר נועם", "יפו 210, ירושלים"], ["משרד", "עמק רפאים 5, ירושלים"]]);

// ---------- placing by hand
await refuses("a point outside Israel is refused", () => setManualLocation(q, addresses["גן שקד"], { lat: 48.85, lng: 2.35 }, user), "מחוץ לישראל");
await refuses("an unknown address is refused", () => setManualLocation(q, "00000000-0000-0000-0000-000000000000", { lat: 31.78, lng: 35.21 }, user), "לא נמצאה");
await setManualLocation(q, addresses["גן שקד"], { lat: 31.7654321987, lng: 35.2 }, user);
check("a hand-placed address is on the map", (await routeMap(q, daily))[2], { stop: 3, customers: ["גן שקד"], address: "02-6251234, ירושלים", addressId: addresses["גן שקד"], point: { lat: 31.765432, lng: 35.2 }, location: "manual", deliveries: 1, delivered: 0 });
await q("update customer_addresses set street = 'הנביאים 3' where id = $1", [addresses["גן שקד"]]);
check("a hand-placed address is never searched again, even when its text changes", (await pendingForRoute(q, daily)).map((p) => idOf[p.id]).includes("גן שקד"), false);
await recordSearch(q, addresses["גן שקד"], "x", { lat: 32, lng: 35 });
check("and a search answer does not overwrite it", (await routeMap(q, daily))[2].point, { lat: 31.765432, lng: 35.2 });
check("placing is written to the history", (await one("select count(*)::int as n from audit_log where action = 'address_location'")).n, 1);
await clearLocation(q, addresses["גן שקד"], user);
check("clearing the location sends the address back to the search", [(await routeMap(q, daily))[2].location, (await pendingForRoute(q, daily)).map((p) => idOf[p.id]).includes("גן שקד")], ["pending", true]);

// ---------- a delivery with no address record, and a delivered one
await q("update deliveries set address_id = null, stop_order = 5 where order_id = (select id from orders where customer_id = $1)", [customers["משרד"]]);
await q("update deliveries set status = 'delivered' where address_id = $1", [addresses["גן הדר"]]);
stops = await routeMap(q, daily);
check("a delivery without an address record cannot be placed", [stops.at(-1).location, stops.at(-1).addressId], ["none", null]);
check("delivered deliveries are counted per stop", [stops[0].deliveries, stops[0].delivered], [2, 2]);

console.log(failed ? `GEO CHECK FAILED (${failed})` : "GEO CHECK PASSED");
process.exit(failed ? 1 : 0);
