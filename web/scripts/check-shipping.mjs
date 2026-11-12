// Tests distribution planning: drivers and vehicles, permanent routes, the daily plan, manual assignment,
// stop order and the driver of the day.
// Run from the web folder:  node scripts/check-shipping.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { saveDriver, setDriverActive, saveRoute, setRouteActive, setAddressRoute, moveAddress, planDay, assignDelivery, moveStop, setDailyDriver, dayRoutes, unassigned, routeDeliveries } from "../src/lib/shipping-core.ts";
import { createOrder, cancelDelivery, updateDelivery } from "../src/lib/orders-core.ts";

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

await q("insert into products (sku, name, base_price) values ('50088', 'קוקטיל', 5)");
await q("insert into product_ops (sku, orderable) values ('50088', true)");
const user = await one("insert into users (mobile, full_name, role) values ('0500000010', 'מנהל שילוח', 'shipping_manager') returning id::text");
const DAY = "2026-12-08";
const NEXT = "2026-12-09";
const customers = {};
const addresses = {};
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד", "בית ספר רעות", "משרד חדש"]) {
  customers[name] = (await one("insert into customers (name) values ($1) returning id::text", [name])).id;
  addresses[name] = (await one("insert into customer_addresses (customer_id, street, city) values ($1, $2, 'ירושלים') returning id::text", [customers[name], "רחוב " + name])).id;
}
const draft = (date, address, qty = 10) => ({ lines: [{ sku: "50088", description: "x", quantity: qty, unitPrice: 5, variantId: null }], discountPct: 0, deliveryFee: 0, deliveryDate: date, windowFrom: null, windowTo: null, addressId: address, customerNotes: null, internalNotes: null, validUntil: null, paymentTerms: null });
const order = async (name, date = DAY, qty = 10) => (await one("select id::text from deliveries where order_id = $1", [(await createOrder(q, customers[name], user.id, draft(date, addresses[name], qty))).orderId])).id;

// ---------- drivers and vehicles
await refuses("a driver needs a name", () => saveDriver(q, null, { name: " ", phone: null, vehicleRegistration: null, vehicleDescription: null }, user.id), "שם הנהג");
await refuses("a bad phone number is refused", () => saveDriver(q, null, { name: "משה", phone: "12", vehicleRegistration: null, vehicleDescription: null }, user.id), "הטלפון");
await refuses("a bad vehicle number is refused", () => saveDriver(q, null, { name: "משה", phone: null, vehicleRegistration: "אבג", vehicleDescription: null }, user.id), "מספר הרכב");
const moshe = await saveDriver(q, null, { name: "משה כהן", phone: "050-123 4567", vehicleRegistration: "12-345-67", vehicleDescription: "איסוזו" }, user.id);
const david = await saveDriver(q, null, { name: "דוד לוי", phone: null, vehicleRegistration: "76-543-21", vehicleDescription: null }, user.id);
const yossi = await saveDriver(q, null, { name: "יוסי", phone: null, vehicleRegistration: null, vehicleDescription: null }, user.id);
check("driver is stored with a tidy phone and a vehicle", await one("select d.phone, v.registration, v.description from drivers d join vehicles v on v.id = d.vehicle_id where d.id = $1", [moshe]), { phone: "0501234567", registration: "12-345-67", description: "איסוזו" });
await refuses("one vehicle cannot belong to two active drivers", () => saveDriver(q, yossi, { name: "יוסי", phone: null, vehicleRegistration: "12-345-67", vehicleDescription: null }, user.id), "כבר משויך לנהג משה כהן");

// ---------- permanent routes
await refuses("a route needs a name", () => saveRoute(q, null, { name: "", description: null, defaultDriverId: null }, user.id), "שם לקו");
const r1 = await saveRoute(q, null, { name: "ירושלים 1", description: null, defaultDriverId: moshe }, user.id);
const r2 = await saveRoute(q, null, { name: "ירושלים 2", description: null, defaultDriverId: null }, user.id);
await refuses("two routes cannot share a name", () => saveRoute(q, null, { name: "ירושלים 1", description: null, defaultDriverId: null }, user.id), "כבר קיים");
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד", "בית ספר רעות"]) await setAddressRoute(q, addresses[name], r1, user.id);
const permanent = async (route) => (await q("select c.name from customer_addresses a join customers c on c.id = a.customer_id where a.route_id = $1 order by a.route_order", [route])).map((r) => r.name);
check("addresses join a route in the order they were added", await permanent(r1), ["גן הדר", "בית ספר נועם", "גן שקד", "בית ספר רעות"]);
await moveAddress(q, addresses["גן שקד"], -1);
check("an address can move earlier in the permanent order", await permanent(r1), ["גן הדר", "גן שקד", "בית ספר נועם", "בית ספר רעות"]);
await moveAddress(q, addresses["גן הדר"], -1);
await moveAddress(q, addresses["בית ספר רעות"], 1);
check("the first cannot move earlier and the last cannot move later", await permanent(r1), ["גן הדר", "גן שקד", "בית ספר נועם", "בית ספר רעות"]);
await setAddressRoute(q, addresses["גן שקד"], r2, user.id);
check("moving an address to another route closes the gap it left", [await permanent(r1), (await q("select route_order from customer_addresses where route_id = $1 order by route_order", [r1])).map((r) => r.route_order), await permanent(r2)], [["גן הדר", "בית ספר נועם", "בית ספר רעות"], [1, 2, 3], ["גן שקד"]]);
await setAddressRoute(q, addresses["גן שקד"], r1, user.id);
await moveAddress(q, addresses["גן שקד"], -1);

// ---------- the daily plan
const d = {};
for (const name of ["בית ספר רעות", "גן הדר", "בית ספר נועם", "גן שקד", "משרד חדש"]) d[name] = await order(name);
await order("בית ספר נועם", DAY, 5);
const cancelled = await order("גן הדר");
await cancelDelivery(q, cancelled, "בוטל", user.id);
await order("גן הדר", NEXT);
const noAddress = (await one("select id::text from deliveries where order_id = $1", [(await createOrder(q, customers["משרד חדש"], user.id, draft(DAY, null))).orderId])).id;

const p1 = await planDay(q, DAY, user.id);
check("planning assigns every delivery whose address has a route", p1, { assigned: 5, routes: 1, unassigned: 2 });
const [daily] = await dayRoutes(q, DAY);
const stops = async (id = daily.id) => (await routeDeliveries(q, id)).map((x) => [x.stopOrder, x.customer, x.units]);
check("the route of the day takes the route's driver and their vehicle", [daily.name, daily.driver, daily.driverPhone, daily.vehicle], ["ירושלים 1", "משה כהן", "0501234567", "12-345-67"]);
check("stops follow the permanent order; two deliveries to one address share a stop", await stops(), [[1, "גן הדר", 10], [2, "בית ספר נועם", 10], [2, "בית ספר נועם", 5], [3, "גן שקד", 10], [4, "בית ספר רעות", 10]]);
check("the card counts stops, deliveries and units; the cancelled delivery is not in it", [daily.stops, daily.deliveries, daily.units], [4, 5, 45]);
check("deliveries without a route, or without an address, wait for a person", (await unassigned(q, DAY)).map((x) => [x.customer, x.address !== null]).sort(), [["משרד חדש", false], ["משרד חדש", true]]);
check("another day is not touched", await dayRoutes(q, NEXT), []);
check("planning again changes nothing", [await planDay(q, DAY, user.id), (await stops()).length], [{ assigned: 0, routes: 1, unassigned: 2 }, 5]);

// ---------- today's order is separate from the permanent order
await moveStop(q, daily.id, 4, -1);
check("a stop can be moved for today", (await stops()).map((s) => s[1]), ["גן הדר", "בית ספר נועם", "בית ספר נועם", "בית ספר רעות", "גן שקד"]);
await moveStop(q, daily.id, 1, -1);
check("the first stop cannot move earlier", (await stops())[0][1], "גן הדר");
check("the permanent order was not changed by today's change", await permanent(r1), ["גן הדר", "בית ספר נועם", "גן שקד", "בית ספר רעות"]);
const late = await order("גן שקד", DAY, 3);
await planDay(q, DAY, user.id);
check("a late order does not undo the order a person set for today", (await stops()).map((s) => s[1]), ["גן הדר", "בית ספר נועם", "בית ספר נועם", "בית ספר רעות", "גן שקד", "גן שקד"]);
check("an order that arrives after planning joins its address's stop", (await stops()).filter((s) => s[1] === "גן שקד").map((s) => [s[0], s[2]]), [[4, 10], [4, 3]]);

// ---------- manual assignment
await assignDelivery(q, d["משרד חדש"], r2, false, user.id);
const daily2 = (await dayRoutes(q, DAY)).find((x) => x.name === "ירושלים 2");
check("a delivery can be placed on a route by hand, which opens that route for the day", [daily2.deliveries, daily2.driver, (await one("select route_id from customer_addresses where id = $1", [addresses["משרד חדש"]])).route_id], [1, null, null]);
await assignDelivery(q, noAddress, r2, true, user.id);
check("a delivery without an address can be placed too, as its own stop", (await stops(daily2.id)).map((s) => s[0]), [1, 2]);
await assignDelivery(q, d["משרד חדש"], r1, true, user.id);
check("moving it to another route, permanently, updates the address for the coming days", [(await stops()).at(-1)[1], (await one("select route_id from customer_addresses where id = $1", [addresses["משרד חדש"]])).route_id, (await stops(daily2.id)).map((s) => s[0])], ["משרד חדש", r1, [1]]);
await assignDelivery(q, late, null, false, user.id);
check("a delivery can be taken off its route", [(await unassigned(q, DAY)).map((x) => x.id).includes(late), (await stops()).map((s) => s[0])], [true, [1, 2, 2, 3, 4, 5]]);
await refuses("a cancelled delivery cannot be placed", () => assignDelivery(q, cancelled, r1, false, user.id), "בוטלה");
await setRouteActive(q, r2, false);
await refuses("a delivery cannot be placed on a switched-off route that is not open today", async () => { await q("delete from daily_routes where id = $1 and not exists (select 1 from deliveries where daily_route_id = $1)", [daily2.id]); await q("update deliveries set daily_route_id = null where daily_route_id = $1", [daily2.id]); await q("delete from daily_routes where id = $1", [daily2.id]); await assignDelivery(q, late, r2, false, user.id); }, "אינו פעיל");
await refuses("an address cannot join a switched-off route", () => setAddressRoute(q, addresses["גן שקד"], r2, user.id), "אינו פעיל");
await setRouteActive(q, r2, true);

// ---------- the driver of the day
await setDailyDriver(q, daily.id, david, user.id);
check("another driver for one day brings their own vehicle, and the route's usual driver stays", [(await dayRoutes(q, DAY)).find((x) => x.id === daily.id).driver, (await dayRoutes(q, DAY)).find((x) => x.id === daily.id).vehicle, (await one("select default_driver_id from routes where id = $1", [r1])).default_driver_id], ["דוד לוי", "76-543-21", moshe]);
await assignDelivery(q, late, r2, false, user.id);
const again2 = (await dayRoutes(q, DAY)).find((x) => x.name === "ירושלים 2");
await refuses("a driver cannot drive two routes on the same day", () => setDailyDriver(q, again2.id, david, user.id), "כבר משובץ היום לקו ירושלים 1");
await setDailyDriver(q, again2.id, null, user.id);
await setDriverActive(q, moshe, false);
check("a driver who left is no longer the default of any route", (await one("select default_driver_id from routes where id = $1", [r1])).default_driver_id, null);
await refuses("a driver who left cannot be chosen", () => setDailyDriver(q, again2.id, moshe, user.id), "אינו פעיל");
await order("גן הדר", "2026-12-10");
await planDay(q, "2026-12-10", user.id);
check("a route without a default driver opens without one, for a person to choose", (await dayRoutes(q, "2026-12-10"))[0].driver, null);

// ---------- a delivery whose date was changed leaves the old day's route
await updateDelivery(q, d["בית ספר רעות"], { lines: [{ sku: "50088", quantity: 10, unitPrice: 5 }], deliveryDate: "2026-12-11", windowFrom: null, windowTo: null, addressId: addresses["בית ספר רעות"], productionNotes: null, shippingNotes: null }, user.id);
await planDay(q, DAY, user.id);
check("a delivery moved to another date is no longer on the old day's route", [(await stops()).some((s) => s[1] === "בית ספר רעות"), (await stops()).map((s) => s[0])], [false, [1, 2, 2, 3, 4]]);
const p11 = await planDay(q, "2026-12-11", user.id);
check("and is planned on its new date", [p11.assigned, (await routeDeliveries(q, (await dayRoutes(q, "2026-12-11"))[0].id)).map((x) => x.customer)], [1, ["בית ספר רעות"]]);
check("planning is written to the history", (await one("select count(*)::int as n from audit_log where action = 'plan_day'")).n >= 3, true);

console.log(failed ? `SHIPPING CHECK FAILED (${failed})` : "SHIPPING CHECK PASSED");
process.exit(failed ? 1 : 0);
