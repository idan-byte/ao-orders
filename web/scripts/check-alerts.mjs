// Tests distribution alerts: which problems are reported, that they clear by themselves when fixed,
// marking an event alert as handled, and closing a route with undelivered deliveries.
// Run from the web folder:  node scripts/check-alerts.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { saveDriver, saveRoute, setAddressRoute, planDay, assignDelivery, setDailyDriver, dayRoutes } from "../src/lib/shipping-core.ts";
import { processDeliveryAction, depart, RefusedError, recordRefusal } from "../src/lib/loading-core.ts";
import { shippingAlerts, resolveEvent, recentlyHandled, closeRoute } from "../src/lib/alerts-core.ts";
import { createOrder, holdDelivery, releaseDelivery } from "../src/lib/orders-core.ts";

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
  try { await fn(); failed++; console.log(`FAIL ${label} -> was accepted`); return null; }
  catch (e) { const ok = e.message.includes(fragment); if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> wrong message: ${e.message}`}`); return e; }
}

await q("insert into products (sku, name, base_price) values ('50088', 'קוקטיל', 5)");
await q("insert into product_ops (sku, orderable) values ('50088', true)");
const user = (await one("insert into users (mobile, full_name, role) values ('0500000030', 'מנהל שילוח', 'shipping_manager') returning id::text")).id;
const [YESTERDAY, TODAY, TOMORROW, LATER] = ["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-20"];
const customers = {};
const addresses = {};
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד", "בית ספר רעות", "משרד"]) {
  customers[name] = (await one("insert into customers (name) values ($1) returning id::text", [name])).id;
  addresses[name] = (await one("insert into customer_addresses (customer_id, street) values ($1, $2) returning id::text", [customers[name], "רחוב " + name])).id;
}
const order = async (name, date) => (await one("select id::text from deliveries where order_id = $1", [(await createOrder(q, customers[name], user, { lines: [{ sku: "50088", description: "x", quantity: 10, unitPrice: 5, variantId: null }], discountPct: 0, deliveryFee: 0, deliveryDate: date, windowFrom: null, windowTo: null, addressId: addresses[name], customerNotes: null, internalNotes: null, validUntil: null, paymentTerms: null })).orderId])).id;
const driver = await saveDriver(q, null, { name: "משה כהן", phone: "0501234567", vehicleRegistration: null, vehicleDescription: null }, user);
const r1 = await saveRoute(q, null, { name: "ירושלים 1", description: null, defaultDriverId: driver }, user);
const r2 = await saveRoute(q, null, { name: "ירושלים 2", description: null, defaultDriverId: null }, user);
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד"]) await setAddressRoute(q, addresses[name], r1, user);
await setAddressRoute(q, addresses["בית ספר רעות"], r2, user);
const act = (delivery, route, action) => processDeliveryAction(q, { deliveryId: delivery, dailyRouteId: route, action, userId: user, source: "manual" });
const routeOf = async (date, name) => (await dayRoutes(q, date)).find((r) => r.name === name).id;
const types = async (today = TODAY) => (await shippingAlerts(q, today)).map((a) => a.type);
const find = async (type, today = TODAY) => (await shippingAlerts(q, today)).filter((a) => a.type === type);

check("a quiet system has no alerts", await shippingAlerts(q, TODAY), []);

// ---------- yesterday: one route left and was not finished, one route never left
const y1 = await order("גן הדר", YESTERDAY);
const y2 = await order("בית ספר נועם", YESTERDAY);
const y3 = await order("בית ספר רעות", YESTERDAY);
await planDay(q, YESTERDAY, user);
const yA = await routeOf(YESTERDAY, "ירושלים 1");
const yB = await routeOf(YESTERDAY, "ירושלים 2");
await act(y1, yA, "load");
await act(y2, yA, "load");
await depart(q, yA, user);
await act(y1, yA, "unload");
check("on its own day an unfinished route is not an alert yet", (await types(YESTERDAY)).filter((t) => t === "unfinished_route"), []);
const unfinished = await find("unfinished_route");
check("a route that left yesterday with a delivery still on the vehicle is reported", [unfinished.length, unfinished[0].severity, unfinished[0].title, unfinished[0].date, unfinished[0].link], [1, "high", "ירושלים 1: 1 אספקות יצאו ולא סומנו כנמסרו", YESTERDAY, `/drive/${yA}`]);
const stuck = await find("not_departed");
check("a route that never left is reported with what was loaded", [stuck.length, stuck[0].title, stuck[0].detail], [1, "ירושלים 2: הקו לא יצא להפצה", "1 אספקות על הקו, 0 מהן סומנו כהועמסו."]);

// ---------- today and tomorrow: deliveries without a route, a route without a driver
await order("משרד", TODAY);
await order("משרד", TOMORROW);
await order("משרד", LATER);
const t1 = await order("בית ספר רעות", TODAY);
await planDay(q, TODAY, user);
const tB = await routeOf(TODAY, "ירושלים 2");
const unassignedAlerts = await find("unassigned");
check("deliveries without a route are reported for today and tomorrow only, today more urgent", unassignedAlerts.map((a) => [a.date, a.severity, a.title]), [[TODAY, "high", "1 אספקות של היום עדיין בלי קו"], [TOMORROW, "medium", "1 אספקות של מחר עדיין בלי קו"]]);
check("a route with deliveries and no driver is reported", (await find("no_driver")).map((a) => [a.title, a.link]), [["ירושלים 2: לא נבחר נהג", `/shipping/day/${tB}`]]);
await setDailyDriver(q, tB, driver, user);
check("choosing a driver clears that alert by itself", await find("no_driver"), []);

// ---------- a delivery on hold
await holdDelivery(q, t1, "delayed", "הלקוח ביקש לדחות", user);
check("a delayed delivery is reported with its note", (await find("delivery_problem")).map((a) => [a.title.includes("מעוכבת"), a.detail, a.route]), [[true, "הלקוח ביקש לדחות", "ירושלים 2"]]);
await releaseDelivery(q, t1, user);
check("releasing it clears the alert", await find("delivery_problem"), []);

// ---------- events: left behind, departure with a reason, a refused attempt
const t2 = await order("גן הדר", TODAY);
const t3 = await order("גן שקד", TODAY);
await planDay(q, TODAY, user);
const tA = await routeOf(TODAY, "ירושלים 1");
await act(t2, tA, "load");
await depart(q, tA, user, { allowMissing: true, reason: "הייצור מתעכב" });
const left = await find("left_behind");
check("a delivery left behind is an alert that names the route and the reason", [left.length, left[0].severity, left[0].title.includes("גן שקד"), left[0].detail.includes("הקו ירושלים 1 יצא בלעדיה: הייצור מתעכב"), left[0].eventId !== null], [1, "high", true, true, true]);
check("and the departure itself is reported", (await find("departed_with_missing")).map((a) => [a.title, a.detail.startsWith("סיבה: הייצור מתעכב")]), [["ירושלים 1 יצא בלי 1 אספקות", true]]);
const refusal = await refuses("a delivery of another route is refused", () => act(t1, tA, "unload"), "שייכת לקו ירושלים 2");
check("the refusal is the kind that is recorded", refusal instanceof RefusedError, true);
await recordRefusal(q, refusal, user, "manual");
check("a refused attempt is a low alert", (await find("wrong_route_attempt")).map((a) => [a.severity, a.title.includes("בית ספר רעות"), a.detail.includes("בקו ירושלים 1")]), [["low", true, true]]);
check("alerts are sorted with the most urgent first", [...new Set((await shippingAlerts(q, TODAY)).map((a) => a.severity))], ["high", "medium", "low"]);

// ---------- marking as handled
await assignDelivery(q, t3, r2, false, user);
check("placing the left-behind delivery on another route does not close the alert by itself: a person confirms", (await find("left_behind")).length, 1);
await resolveEvent(q, left[0].eventId, user, "שובצה לקו ירושלים 2");
check("marking it handled removes it from the list", await find("left_behind"), []);
await refuses("it cannot be marked twice", () => resolveEvent(q, left[0].eventId, user, null), "כבר טופלה");
check("handled alerts are kept, with who and what was done", (await recentlyHandled(q)).map((h) => [h.type, h.resolvedBy, h.resolution, h.title.includes("גן שקד")]), [["left_behind", "מנהל שילוח", "שובצה לקו ירושלים 2", true]]);

// ---------- closing a route that was not finished
await refuses("a route that has not left cannot be closed", () => closeRoute(q, yB, user, "סיבה"), "עוד לא יצא");
await refuses("closing needs a reason", () => closeRoute(q, yA, user, " "), "למה האספקות לא נמסרו");
check("closing marks every undelivered delivery as an exception", [await closeRoute(q, yA, user, "הלקוח היה סגור"), await one("select status::text, exception_note, status_before_hold::text as back from deliveries where id = $1", [y2])], [1, { status: "exception", exception_note: "לא נמסרה בקו: הלקוח היה סגור", back: "shipped" }]);
check("the route is no longer unfinished; the delivery is now a problem someone has to decide about", [await find("unfinished_route"), (await find("delivery_problem")).map((a) => a.detail)], [[], ["לא נמסרה בקו: הלקוח היה סגור"]]);
await refuses("a route with nothing left cannot be closed again", () => closeRoute(q, yA, user, "שוב"), "כבר נמסרו");
check("closing is written to the history", (await one("select metadata->>'undelivered' as n, metadata->>'reason' as reason from shipping_events where event_type = 'route_closed'")), { n: "1", reason: "הלקוח היה סגור" });
check("the delivery that never left yesterday is still reported", (await types()).includes("not_departed"), true);
void y3;

console.log(failed ? `ALERTS CHECK FAILED (${failed})` : "ALERTS CHECK PASSED");
process.exit(failed ? 1 : 0);
