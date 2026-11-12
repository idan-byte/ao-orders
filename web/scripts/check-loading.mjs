// Tests distribution execution: loading, leaving for delivery (with and without missing deliveries),
// handing over, reversals, refused attempts, and who may work a route.
// Run from the web folder:  node scripts/check-loading.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { saveDriver, saveRoute, setAddressRoute, planDay, assignDelivery, unassigned, routeDeliveries, dayRoutes } from "../src/lib/shipping-core.ts";
import { processDeliveryAction, depart, missingFromRoute, routeAccess, workRoutes, progressLabel, RefusedError, recordRefusal } from "../src/lib/loading-core.ts";
import { createOrder, cancelDelivery } from "../src/lib/orders-core.ts";
import { can } from "../src/lib/permissions.ts";

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
const mk = async (mobile, name, role) => ({ id: (await one("insert into users (mobile, full_name, role) values ($1, $2, $3) returning id::text", [mobile, name, role])).id, mobile, role });
const manager = await mk("0500000020", "מנהל שילוח", "shipping_manager");
const moshe = await mk("0501234567", "משה", "driver");
const david = await mk("0507654321", "דוד", "driver");
const loader = await mk("0500000021", "מנהל העמסה", "loading_manager");
const clerk = await mk("0500000022", "פקיד", "order_clerk");
const DAY = "2026-12-08";
const customers = {};
const addresses = {};
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד", "בית ספר רעות"]) {
  customers[name] = (await one("insert into customers (name) values ($1) returning id::text", [name])).id;
  addresses[name] = (await one("insert into customer_addresses (customer_id, street) values ($1, $2) returning id::text", [customers[name], "רחוב " + name])).id;
}
const draft = (address) => ({ lines: [{ sku: "50088", description: "x", quantity: 10, unitPrice: 5, variantId: null }], discountPct: 0, deliveryFee: 0, deliveryDate: DAY, windowFrom: null, windowTo: null, addressId: address, customerNotes: null, internalNotes: null, validUntil: null, paymentTerms: null });
const order = async (name) => (await one("select id::text from deliveries where order_id = $1", [(await createOrder(q, customers[name], manager.id, draft(addresses[name]))).orderId])).id;

const dMoshe = await saveDriver(q, null, { name: "משה כהן", phone: "050-1234567", vehicleRegistration: "12-345-67", vehicleDescription: null }, manager.id);
await saveDriver(q, null, { name: "דוד לוי", phone: "0507654321", vehicleRegistration: null, vehicleDescription: null }, manager.id);
const r1 = await saveRoute(q, null, { name: "ירושלים 1", description: null, defaultDriverId: dMoshe }, manager.id);
const r2 = await saveRoute(q, null, { name: "ירושלים 2", description: null, defaultDriverId: null }, manager.id);
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד"]) await setAddressRoute(q, addresses[name], r1, manager.id);
await setAddressRoute(q, addresses["בית ספר רעות"], r2, manager.id);
const d = {};
for (const name of ["גן הדר", "בית ספר נועם", "גן שקד", "בית ספר רעות"]) d[name] = await order(name);
await planDay(q, DAY, manager.id);
const routes = await dayRoutes(q, DAY);
const A = routes.find((r) => r.name === "ירושלים 1").id;
const B = routes.find((r) => r.name === "ירושלים 2").id;
const act = (delivery, action, route = A, user = moshe) => processDeliveryAction(q, { deliveryId: delivery, dailyRouteId: route, action, userId: user.id, source: "manual" });
const state = async (delivery) => { const r = await one("select status::text, loaded_at is not null as loaded from deliveries where id = $1", [delivery]); return [r.status, r.loaded]; };
const events = async (type) => (await one("select count(*)::int as n from shipping_events where event_type = $1", [type])).n;

// ---------- who may work a route
const may = (u) => (p) => can(u.role, p);
check("a driver sees and works only their own route", [await routeAccess(q, moshe, A, may(moshe)), (await routeAccess(q, moshe, B, may(moshe))).view, (await routeAccess(q, david, A, may(david))).view], [{ view: true, load: true, unload: true, manage: false }, false, false]);
check("a loading manager loads every route but does not hand over", await routeAccess(q, loader, B, may(loader)), { view: true, load: true, unload: false, manage: false });
check("a shipping manager works every route; an order clerk none", [await routeAccess(q, manager, B, may(manager)), (await routeAccess(q, clerk, A, may(clerk))).view], [{ view: true, load: true, unload: true, manage: true }, false]);
check("the driver's list has only their routes; a manager's has all", [(await workRoutes(q, moshe, [DAY], false)).map((r) => r.name), (await workRoutes(q, david, [DAY], false)).length, (await workRoutes(q, manager, [DAY], true)).map((r) => r.name)], [["ירושלים 1"], 0, ["ירושלים 1", "ירושלים 2"]]);

// ---------- loading
check("progress words", [progressLabel(0, 3), progressLabel(1, 3), progressLabel(3, 3), progressLabel(0, 0)], ["טרם התחיל", "בתהליך", "הושלם", "טרם התחיל"]);
await refuses("handing over before the route left is refused", () => act(d["גן הדר"], "unload"), "עדיין בטעינה");
check("loading marks the delivery and starts the route's loading clock", [await act(d["גן הדר"], "load"), await state(d["גן הדר"]), (await one("select loading_started_at is not null as s from daily_routes where id = $1", [A])).s], [{ changed: true, message: "הועמסה" }, ["approved", true], true]);
check("a second tap does nothing and creates no second event", [(await act(d["גן הדר"], "load")).changed, await events("loaded")], [false, 1]);
const wrong = await refuses("a delivery of another route is refused, naming its route", () => act(d["בית ספר רעות"], "load"), "שייכת לקו ירושלים 2");
check("the refusal carries its own record", [wrong instanceof RefusedError, wrong?.refusal.type, await state(d["בית ספר רעות"])], [true, "wrong_route_attempt", ["approved", false]]);
await recordRefusal(q, wrong, moshe.id, "manual");
check("and it is written to the history", await events("wrong_route_attempt"), 1);
await act(d["גן הדר"], "reverse_load", A, manager);
check("a loading mark can be reversed", [await state(d["גן הדר"]), await events("load_reversed")], [["approved", false], 1]);
await act(d["גן הדר"], "load");
await refuses("a loaded delivery cannot be moved to another route by reassignment", () => assignDelivery(q, d["גן הדר"], r2, false, manager.id), "כבר הועמסה");

// ---------- leaving with something missing
await act(d["בית ספר נועם"], "load");
check("what is missing is listed", (await missingFromRoute(q, A)).map((m) => [m.customer, m.stop]), [["גן שקד", 3]]);
await refuses("the route does not leave with a delivery missing", () => depart(q, A, moshe.id), "חסרות 1 אספקות");
await refuses("an authorised exception needs a reason", () => depart(q, A, manager.id, { allowMissing: true, reason: " " }), "למה הקו יוצא");
check("nothing changed after the refusals", [(await one("select mode from daily_routes where id = $1", [A])).mode, await state(d["גן הדר"])], ["loading", ["approved", true]]);
await refuses("a route with nothing loaded cannot leave", () => depart(q, B, manager.id), "לא נבחר נהג");
check("leaving with an authorised exception ships what is loaded and leaves the rest behind", await depart(q, A, manager.id, { allowMissing: true, reason: "הייצור של גן שקד מתעכב" }), { shipped: 2, leftBehind: 1 });
check("loaded deliveries are now shipped; the route is in delivery mode with the reason kept", [await state(d["גן הדר"]), await state(d["בית ספר נועם"]), await one("select mode, departure_note, departed_by::text = $2 as by_manager from daily_routes where id = $1", [A, manager.id])], [["shipped", true], ["shipped", true], { mode: "unloading", departure_note: "הייצור של גן שקד מתעכב", by_manager: true }]);
check("what was left behind is back on the unassigned list, not lost", [(await unassigned(q, DAY)).map((x) => x.customer), await state(d["גן שקד"]), await events("left_behind")], [["גן שקד"], ["approved", false], 1]);
check("the status change is in the order's history", (await one("select after->>'note' as note from audit_log where action = 'delivery_status' and entity_id = $1 order by id desc limit 1", [d["גן הדר"]])).note, "יצאה בקו החלוקה");
await refuses("a route cannot leave twice", () => depart(q, A, manager.id), "כבר יצא");
await refuses("nothing can be loaded after the route left", () => act(d["גן הדר"], "load"), "כבר יצא להפצה");
await refuses("nothing can be added to a route that left", () => assignDelivery(q, d["גן שקד"], r1, false, manager.id), "כבר יצא להפצה");
check("planning does not add to a route that left", [(await planDay(q, DAY, manager.id)).assigned, (await unassigned(q, DAY)).length], [0, 1]);

// ---------- handing over
check("handing over marks the delivery as delivered", [await act(d["גן הדר"], "unload"), await state(d["גן הדר"]), (await one("select delivered_at is not null as t from deliveries where id = $1", [d["גן הדר"]])).t], [{ changed: true, message: "נמסרה" }, ["delivered", true], true]);
check("a second tap does nothing", [(await act(d["גן הדר"], "unload")).changed, await events("unloaded")], [false, 1]);
check("the route is not complete while something is still on the vehicle", (await one("select delivery_completed_at from daily_routes where id = $1", [A])).delivery_completed_at, null);
await act(d["בית ספר נועם"], "unload");
check("the last hand-over completes the route", (await one("select delivery_completed_at is not null as t from daily_routes where id = $1", [A])).t, true);
const w = (await workRoutes(q, moshe, [DAY], false))[0];
check("progress is counted from the deliveries", [w.total, w.loaded, w.delivered, w.mode], [2, 2, 2, "unloading"]);
await act(d["בית ספר נועם"], "reverse_unload", A, manager);
check("a hand-over can be reversed, which reopens the route", [await state(d["בית ספר נועם"]), (await one("select delivery_completed_at from daily_routes where id = $1", [A])).delivery_completed_at], [["shipped", true], null]);

// ---------- a clean departure, and a delivery that was never loaded
await assignDelivery(q, d["גן שקד"], r2, false, manager.id);
await q("update daily_routes set driver_id = (select id from drivers where name = 'דוד לוי') where id = $1", [B]);
await act(d["בית ספר רעות"], "load", B, david);
const cancelled = await order("בית ספר רעות");
await planDay(q, DAY, manager.id);
await cancelDelivery(q, cancelled, "בוטל", manager.id);
await refuses("a cancelled delivery cannot be loaded", () => act(cancelled, "load", B, david), "בוטלה");
await act(d["גן שקד"], "load", B, loader);
check("with everything loaded the driver sends the route out; a cancelled delivery is not missing", await depart(q, B, david.id), { shipped: 2, leftBehind: 0 });
check("a clean departure keeps no exception note", (await one("select departure_note from daily_routes where id = $1", [B])).departure_note, null);
await q("update deliveries set loaded_at = null where id = $1", [d["גן שקד"]]);
const early = await refuses("a delivery that is not loaded cannot be handed over", () => act(d["גן שקד"], "unload", B, david), "לא הועמסה");
check("that refusal is recorded as its own kind", early?.refusal.type, "unload_before_load");
check("deliveries of the route, in order, for the driver's list", (await routeDeliveries(q, B)).map((x) => x.customer), ["בית ספר רעות", "גן שקד"]);
check("leaving is written to the history with what went and what stayed", await one("select metadata->>'shipped' as shipped, metadata->'leftBehind' as left from shipping_events where event_type = 'departed' and daily_route_id = $1", [A]), { shipped: "2", left: [(await one("select o.number from orders o join deliveries x on x.order_id = o.id where x.id = $1", [d["גן שקד"]])).number] });

console.log(failed ? `LOADING CHECK FAILED (${failed})` : "LOADING CHECK PASSED");
process.exit(failed ? 1 : 0);
