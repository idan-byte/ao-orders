// Tests turning Milgam's daily order into deliveries: linking an institution to a customer and an address,
// what blocks a delivery, the lines and prices, a hot box and a cold box for every group each with its own
// code, making deliveries again after a corrected order, and loading box by box. All data here is made up.
// Run from the web folder:  node scripts/check-hotfood.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { importMilgam } from "../src/lib/milgam-core.ts";
import { linkInstitution, getInstitution, dayPlan, makeDeliveries, HotFoodError } from "../src/lib/hotfood-core.ts";
import { saveDriver, saveRoute, setAddressRoute, planDay, dayRoutes } from "../src/lib/shipping-core.ts";
import { scanDelivery, routeLabels, missingFromRoute, depart, setBoxCount, processDeliveryAction } from "../src/lib/loading-core.ts";

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

// ---------- catalogue, customer, route
const DAY = "2026-12-08";
const user = (await one("insert into users (mobile, full_name, role) values ('0500000040', 'מנהל', 'admin') returning id::text")).id;
await q("insert into products (sku, name, base_price, sort_group) values ('60001', 'חמגשית', 20, 600), ('60002', 'חמגשית צמחונית', 21, 600), ('60003', 'תפזורת', 15, 600), ('60009', 'מנה עם סוגים', 10, 600)");
await q("insert into product_ops (sku, orderable) values ('60001', true), ('60002', true), ('60003', true), ('60009', true)");
await q("insert into product_variants (sku, name) values ('60009', 'עוף')");
const city = (await one("insert into customers (name) values ('עיריית הדוגמה') returning id::text")).id;
const other = (await one("insert into customers (name) values ('לקוח אחר') returning id::text")).id;
const addrA = (await one("insert into customer_addresses (customer_id, street, city) values ($1, 'רחוב האלון 1', 'עיר') returning id::text", [city])).id;
const addrB = (await one("insert into customer_addresses (customer_id, street, city) values ($1, 'רחוב הרימון 2', 'עיר') returning id::text", [city])).id;
const addrOther = (await one("insert into customer_addresses (customer_id, street) values ($1, 'רחוב אחר 3') returning id::text", [other])).id;
await q("insert into customer_prices (customer_id, sku, price, source, valid_from, approved_at, approved_by) values ($1, '60001', 18.5, 'manual', '2026-01-01', now(), $2)", [city, user]);
const driver = await saveDriver(q, null, { name: "נהג", phone: "050-1234567", vehicleRegistration: "12-345-67", vehicleDescription: null }, user);
const route = await saveRoute(q, null, { name: "קו מוסדות", description: null, defaultDriverId: driver }, user);
await setAddressRoute(q, addrA, route, user);
await setAddressRoute(q, addrB, route, user);

// ---------- Milgam's order for the day
const row = (symbol, name, className, mealType, qty, notes = null, flag = false) => ({ line: 0, symbol, name, kind: "בית ספר", authority: "עיר", program: "יוחא", className, mealType, address: "כתובת מילגם", kosher: null, notes, lifeThreatening: flag, quantities: { [DAY]: qty } });
const NOTE = "א1- ללא ביצים\nב1- ללא שומשום";
const file = (rows) => ({ days: [DAY], rows, problems: [], sheetRows: rows.length });
const ORDER = [
  row("111111", "בית ספר אלון", "א1", "חמגשית א-ב", 20, NOTE, true),
  row("111111", "בית ספר אלון", "א1", "חמגשית צמחוני א-ב", 3, NOTE, true),
  row("111111", "בית ספר אלון", "ב1", "חמגשית א-ב", 18, NOTE, true),
  row("222222", "גן רימון", "גן חובה", "תפזורת חובה", 30),
];
await importMilgam(q, file(ORDER), { kind: "forecast", fileName: "צפי", userId: user, addNew: true });
const inst = Object.fromEntries((await q("select id, symbol from institutions")).map((r) => [r.symbol, r.id]));
const mealId = async (name) => (await one("select id from meal_types where name = $1", [name])).id;
const mapSku = async (name, sku) => q("update meal_types set sku = $2 where id = $1", [await mealId(name), sku]);

await refuses("deliveries are made from the daily order, never from the forecast alone", () => makeDeliveries(q, DAY, user), "עוד לא נטענה ההזמנה היומית");
check("with only a forecast the day has nothing to deliver", [(await dayPlan(q, DAY)).ordered, (await dayPlan(q, DAY)).institutions.length], [false, 0]);
await importMilgam(q, file(ORDER), { kind: "daily", fileName: "הזמנה", userId: user, addNew: false });

// ---------- what blocks a delivery
const plan1 = await dayPlan(q, DAY);
check("the day lists the institutions with their groups and what each ordered", plan1.institutions.map((i) => [i.name, i.portions, i.groups.map((g) => [g.className, g.meals.map((m) => `${m.quantity} ${m.mealType}`)])]), [["בית ספר אלון", 41, [["א1", ["20 חמגשית א-ב", "3 חמגשית צמחוני א-ב"]], ["ב1", ["18 חמגשית א-ב"]]]], ["גן רימון", 30, [["גן חובה", ["30 תפזורת חובה"]]]]]);
check("an institution without a customer and meal types without an item cannot be delivered, and it says why", plan1.institutions[0].blocked, ["המוסד לא שויך ללקוח לחיוב", "סוגי מנה בלי מק״ט: חמגשית א-ב, חמגשית צמחוני א-ב"]);
const nothing = await makeDeliveries(q, DAY, user);
check("nothing is made while everything is blocked", [nothing.created, nothing.blocked.length, (await one("select count(*)::int as n from orders")).n], [0, 2, 0]);

// ---------- linking an institution
await refuses("an address needs a customer", () => linkInstitution(q, inst["111111"], null, addrA, user), "רק יחד עם לקוח");
await refuses("the address must belong to the chosen customer", () => linkInstitution(q, inst["111111"], city, addrOther, user), "אינה שייכת ללקוח");
await linkInstitution(q, inst["111111"], city, null, user);
check("with a customer and no address the delivery is still blocked", (await dayPlan(q, DAY)).institutions[0].blocked[0], "למוסד לא נבחרה כתובת אספקה");
await linkInstitution(q, inst["111111"], city, addrA, user);
const card = await getInstitution(q, inst["111111"]);
check("the institution's card shows the customer, the address, the route it is on, and its groups", [card.customer, card.linkedAddress, card.route, card.groups.map((g) => g.className), card.lifeThreatening], ["עיריית הדוגמה", "רחוב האלון 1, עיר", "קו מוסדות", ["א1", "ב1"], true]);
check("the link is in the history", (await one("select count(*)::int as n from audit_log where action = 'institution_link'")).n, 2);
await mapSku("חמגשית א-ב", "60001");
await mapSku("חמגשית צמחוני א-ב", "60009");
check("an item that has variants blocks the delivery until a menu chooses", (await dayPlan(q, DAY)).institutions[0].blocked, ["למק״ט 60009 מוגדרים סוגים, ואין עדיין תפריט שבוחר ביניהם"]);
await mapSku("חמגשית צמחוני א-ב", "60002");
check("now the institution is ready", (await dayPlan(q, DAY)).institutions[0].blocked, []);

// ---------- making the deliveries
const made = await makeDeliveries(q, DAY, user);
check("the ready institution gets a delivery; the other is skipped with its reasons", [made.created, made.blocked.map((b) => [b.name, b.reasons.length])], [1, [["גן רימון", 2]]]);
const delivery = (await one("select delivery_id::text from milgam_deliveries where institution_id = $1", [inst["111111"]])).delivery_id;
check("the order is Milgam's, for the billed customer, approved, at the linked address, with the allergy remark for production and for the driver", await one("select o.source::text, c.name as customer, d.status::text, d.address_snapshot, d.delivery_date::text, d.production_notes = $2 as p, d.shipping_notes = $2 as s from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id where d.id = $1", [delivery, NOTE]), { source: "milgam", customer: "עיריית הדוגמה", status: "approved", address_snapshot: "רחוב האלון 1, עיר", delivery_date: DAY, p: true, s: true });
check("one line per catalogue item, summed over the groups; the price is the customer's agreement, or the list price where there is none", await q("select sku, quantity::float as quantity, unit_price::float as price from delivery_lines where delivery_id = $1 order by sku", [delivery]), [{ sku: "60001", quantity: 38, price: 18.5 }, { sku: "60002", quantity: 3, price: 21 }]);
const boxList = async (id = delivery) => q("select g.class_name as c, b.kind, b.scan_code, b.loaded_at is not null as loaded from delivery_boxes b join institution_groups g on g.id = b.group_id where b.delivery_id = $1 order by g.class_name, b.kind desc", [id]);
const boxes = await boxList();
check("every group has a hot box and a cold box, four boxes with four different codes, and no ordinary box", [boxes.map((b) => [b.c, b.kind]), new Set(boxes.map((b) => b.scan_code)).size, (await one("select count(*)::int as n from delivery_boxes where delivery_id = $1 and group_id is null", [delivery])).n], [[["א1", "hot"], ["א1", "cold"], ["ב1", "hot"], ["ב1", "cold"]], 4, 0]);
const plan2 = (await dayPlan(q, DAY)).institutions[0];
check("the day now shows the delivery and its order number", [plan2.deliveryId === delivery, plan2.orderNumber > 0, plan2.deliveryStatus], [true, true, "approved"]);
const same = await makeDeliveries(q, DAY, user);
check("making deliveries again changes nothing and makes no second order", [same.created, same.updated, same.unchanged, (await one("select count(*)::int as n from orders")).n], [0, 0, 1, 1]);
await refuses("the number of boxes of a hot food delivery is not set by hand", () => setBoxCount(q, delivery, 5, user), "ארגז חם וארגז קר לכל כיתה");

// ---------- a corrected order before loading
const CORRECTED = [row("111111", "בית ספר אלון", "א1", "חמגשית א-ב", 22, NOTE, true), row("111111", "בית ספר אלון", "ג1", "חמגשית א-ב", 10, NOTE, true), row("222222", "גן רימון", "גן חובה", "תפזורת חובה", 30)];
await importMilgam(q, file(CORRECTED), { kind: "daily", fileName: "הזמנה מתוקנת", userId: user, addNew: false });
const fixed = await makeDeliveries(q, DAY, user);
const after = await boxList();
check("a corrected order updates the delivery: new quantities, the class that left loses its boxes, the new class gets its own", [fixed.updated, await q("select sku, quantity::float as quantity from delivery_lines where delivery_id = $1 order by sku", [delivery]), after.map((b) => [b.c, b.kind])], [1, [{ sku: "60001", quantity: 32 }], [["א1", "hot"], ["א1", "cold"], ["ג1", "hot"], ["ג1", "cold"]]]);
check("the boxes of the class that stayed keep their codes, so labels already printed still work", after.slice(0, 2).map((b) => b.scan_code), boxes.slice(0, 2).map((b) => b.scan_code));

// ---------- on the route: labels and loading box by box
await linkInstitution(q, inst["222222"], city, addrB, user);
await mapSku("תפזורת חובה", "60003");
check("the second institution is made once it is ready", (await makeDeliveries(q, DAY, user)).created, 1);
await planDay(q, DAY, user);
const R = (await dayRoutes(q, DAY)).find((r) => r.name === "קו מוסדות").id;
const labels = await routeLabels(q, R);
check("the route's labels: one per box, naming the institution, the class, hot or cold, what the class ordered and the allergy flag", labels.map((l) => [l.institution, l.className, l.kind, l.contents, l.lifeThreatening]), [["גן רימון", "גן חובה", "hot", "30 תפזורת חובה", false], ["גן רימון", "גן חובה", "cold", "30 תפזורת חובה", false], ["בית ספר אלון", "א1", "hot", "22 חמגשית א-ב", true], ["בית ספר אלון", "א1", "cold", "22 חמגשית א-ב", true], ["בית ספר אלון", "ג1", "hot", "10 חמגשית א-ב", true], ["בית ספר אלון", "ג1", "cold", "10 חמגשית א-ב", true]]);
check("the allergy remark is on every label of that institution, whole", labels.filter((l) => l.institution === "בית ספר אלון").every((l) => l.notes === NOTE), true);
const scan = (code) => scanDelivery(q, { code, dailyRouteId: R, userId: user, access: { load: true, unload: true } });
const hot = await scan(after[0].scan_code);
check("scanning the hot box of a class names it and says three boxes of the institution are still missing", [hot.message, hot.customer, hot.complete, hot.done, hot.boxes], ["ארגז חם · א1 הועמס. חסרים עוד 3.", "בית ספר אלון", false, 1, 4]);
await scan(after[2].scan_code);
await scan(after[3].scan_code);
check("with the cold box of one class not scanned the institution is missing from the route", (await missingFromRoute(q, R)).map((m) => [m.customer, m.loadedBoxes, m.boxes]), [["עיריית הדוגמה", 3, 4], ["עיריית הדוגמה", 0, 2]]);
await refuses("and the route does not leave: no institution is fully on the vehicle", () => depart(q, R, user), "עוד לא הועמסה אף אספקה");
const cold = await scan(after[1].scan_code);
check("the forgotten cold box completes the institution", [cold.message, cold.complete], ["ארגז נלווים (קר) · א1 הועמס. כל הארגזים של האספקה על הרכב.", true]);
const rimon = (await one("select delivery_id::text from milgam_deliveries where institution_id = $1", [inst["222222"]])).delivery_id;
await processDeliveryAction(q, { deliveryId: rimon, dailyRouteId: R, action: "load", userId: user, source: "manual" });
check("the route leaves once every box is on it", await depart(q, R, user), { shipped: 2, leftBehind: 0 });

// ---------- an order corrected after loading does not move what is on the road
await importMilgam(q, file([row("111111", "בית ספר אלון", "א1", "חמגשית א-ב", 25, NOTE, true), row("222222", "גן רימון", "גן חובה", "תפזורת חובה", 30)]), { kind: "daily", fileName: "מאוחר", userId: user, addNew: false });
const late = await makeDeliveries(q, DAY, user);
check("a correction after the delivery left changes nothing and is reported", [late.updated, late.unchanged, late.frozen.map((f) => [f.name, f.reason.includes("לא עודכנה")]), (await one("select quantity::float as n from delivery_lines where delivery_id = $1", [delivery])).n], [0, 1, [["בית ספר אלון", true]], 32]);
check("the error class is the module's own", new HotFoodError("x") instanceof Error, true);

console.log(failed ? `HOTFOOD CHECK FAILED (${failed})` : "HOTFOOD CHECK PASSED");
process.exit(failed ? 1 : 0);
