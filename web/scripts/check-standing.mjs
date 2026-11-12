// Tests standing orders: the weekly template, generation, idempotency, skipped days, pauses, closed days, pricing.
// Run from the web folder:  node scripts/check-standing.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { saveStanding, setSkip, setPause, setClosedDay, generateStanding, weekdayOf, getAuto, setAuto, runAuto, recordAutoFailure } from "../src/lib/standing-core.ts";
import { setAgreedPrice } from "../src/lib/customers-core.ts";
import { planRows } from "../src/lib/production-core.ts";

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

await q("insert into departments (name) values ('כריכים'), ('מטבח חם')");
await q("insert into products (sku, name, base_price) values ('50002', 'כריך 120 גרם', 10), ('50010', 'חמגשית', 21.74)");
await q("insert into product_ops (sku, orderable, department_id, default_shift) values ('50002', true, 1, 1), ('50010', true, 2, 0)");
const user = await one("insert into users (mobile, full_name, role) values ('0500000006', 'עובד הזמנות', 'order_clerk') returning id::text");
const cust = await one("insert into customers (name) values ('בית ספר לבדיקה') returning id::text");
const other = await one("insert into customers (name) values ('לקוח אחר') returning id::text");
const addr = await one("insert into customer_addresses (customer_id, street, city) values ($1, 'רחוב האלה 12', 'ירושלים') returning id::text", [cust.id]);
const foreign = await one("insert into customer_addresses (customer_id, street) values ($1, 'כתובת זרה') returning id::text", [other.id]);

// 2026-12-06 is a Sunday. The week runs Sunday 6.12 .. Saturday 12.12.
check("weekday helper: Sunday is 0, Thursday is 4, Saturday is 6", [weekdayOf("2026-12-06"), weekdayOf("2026-12-10"), weekdayOf("2026-12-12")], [0, 4, 6]);

const sunToThu = (sku, qty) => [0, 1, 2, 3, 4].map((weekday) => ({ weekday, sku, quantity: qty }));
const input = { customerId: cust.id, addressId: addr.id, windowFrom: "06:45", windowTo: "07:30", validFrom: "2026-12-01", validTo: null, productionNotes: "בלי חמוצים", shippingNotes: "למסור לשומר", lines: [...sunToThu("50002", 60), { weekday: 2, sku: "50010", quantity: 30 }] };

// ---------- saving
await refuses("needs a start date", () => saveStanding(q, null, { ...input, validFrom: "" }, user.id), "מאיזה תאריך");
await refuses("end before start", () => saveStanding(q, null, { ...input, validTo: "2026-11-01" }, user.id), "מוקדם");
await refuses("needs at least one quantity", () => saveStanding(q, null, { ...input, lines: [{ weekday: 0, sku: "50002", quantity: 0 }] }, user.id), "לפחות מוצר אחד");
await refuses("unknown product", () => saveStanding(q, null, { ...input, lines: [{ weekday: 0, sku: "nope", quantity: 5 }] }, user.id), "אינו קיים");
await refuses("someone else's address", () => saveStanding(q, null, { ...input, addressId: foreign.id }, user.id), "אינה שייכת");
await refuses("bad weekday", () => saveStanding(q, null, { ...input, lines: [{ weekday: 9, sku: "50002", quantity: 5 }] }, user.id), "יום בשבוע");
const sid = await saveStanding(q, null, input, user.id);
check("template saved: 6 lines", (await one("select count(*)::int as n from standing_order_lines where standing_order_id = $1", [sid])).n, 6);

// ---------- generating a week
const g1 = await generateStanding(q, "2026-12-06", "2026-12-12", user.id);
check("one order per school day, none on Friday and Saturday", [g1.created, g1.orders.map((o) => o.day)], [5, ["2026-12-06", "2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10"]]);
const tue = await one(`select o.source::text, o.standing_order_id::text = $1 as linked, d.status::text, to_char(d.window_from, 'HH24:MI') as f, d.address_snapshot as a, d.production_notes as p, d.shipping_notes as s,
  (select json_agg(json_build_object('sku', l.sku, 'q', l.quantity::float, 'p', l.unit_price::float) order by l.sku) from delivery_lines l where l.delivery_id = d.id) as lines
  from orders o join deliveries d on d.order_id = o.id where d.delivery_date = '2026-12-08'`, [sid]);
check("Tuesday's order: approved, with address, window, notes and both products at base price", tue, { source: "standing", linked: true, status: "approved", f: "06:45", a: "רחוב האלה 12, ירושלים", p: "בלי חמוצים", s: "למסור לשומר", lines: [{ sku: "50002", q: 60, p: 10 }, { sku: "50010", q: 30, p: 21.74 }] });
check("generated orders reach the production plan", (await planRows(q, "2026-12-08", 1)).map((r) => [r.sku, r.quantity]), [["50002", 60]]);

const g2 = await generateStanding(q, "2026-12-06", "2026-12-12", user.id);
check("running it again creates nothing", [g2.created, g2.skipped.existing, (await one("select count(*)::int as n from orders")).n], [0, 5, 5]);
const g3 = await generateStanding(q, "2026-12-10", "2026-12-14", user.id);
check("an overlapping range creates only the new days", [g3.created, g3.orders.map((o) => o.day), g3.skipped.existing], [2, ["2026-12-13", "2026-12-14"], 1]);

// ---------- one skipped day, a closed day, a pause
await setSkip(q, sid, "2026-12-15", true, "טיול שנתי");
await setClosedDay(q, "2026-12-16", "חנוכה");
await refuses("closed day needs a reason", () => setClosedDay(q, "2026-12-17", " "), "סיבת הסגירה");
await refuses("cannot skip a day that already has an order", () => setSkip(q, sid, "2026-12-08", true, "x"), "כבר נוצרה הזמנה");
const g4 = await generateStanding(q, "2026-12-15", "2026-12-17", user.id);
check("skipped day and closed day produce no order", [g4.created, g4.orders.map((o) => o.day), g4.skipped.excluded, g4.skipped.closed], [1, ["2026-12-17"], 1, 1]);
await setSkip(q, sid, "2026-12-15", false, null);
await setClosedDay(q, "2026-12-16", null);
const g5 = await generateStanding(q, "2026-12-15", "2026-12-17", user.id);
check("restoring them lets the orders be created", [g5.created, g5.orders.map((o) => o.day)], [2, ["2026-12-15", "2026-12-16"]]);

await setPause(q, sid, "2026-12-22");
const g6 = await generateStanding(q, "2026-12-20", "2026-12-24", user.id);
check("pause covers dates up to and including its end", [g6.orders.map((o) => o.day), g6.skipped.paused], [["2026-12-23", "2026-12-24"], 3]);
await setPause(q, sid, null);
check("resuming fills the paused days", (await generateStanding(q, "2026-12-20", "2026-12-24", user.id)).orders.map((o) => o.day), ["2026-12-20", "2026-12-21", "2026-12-22"]);

// ---------- editing the template affects only future generation
await saveStanding(q, sid, { ...input, lines: sunToThu("50002", 80), validTo: "2026-12-29" }, user.id);
check("existing orders keep their quantities", (await one("select sum(l.quantity)::float as q from delivery_lines l join deliveries d on d.id = l.delivery_id where d.delivery_date = '2026-12-08' and l.sku = '50002'")).q, 60);
const g7 = await generateStanding(q, "2026-12-27", "2026-12-31", user.id);
check("new orders use the new template, and stop at the end date", [g7.orders.map((o) => o.day), (await one("select l.quantity::float as q from delivery_lines l join deliveries d on d.id = l.delivery_id where d.delivery_date = '2026-12-27'")).q, (await one("select count(*)::int as n from delivery_lines l join deliveries d on d.id = l.delivery_id where d.delivery_date = '2026-12-29' and l.sku = '50010'")).n], [["2026-12-27", "2026-12-28", "2026-12-29"], 80, 0]);
await refuses("editing with the wrong customer", () => saveStanding(q, sid, { ...input, customerId: other.id, addressId: null }, user.id), "לא נמצאה");

// ---------- prices come from the customer's agreement at generation time
await setAgreedPrice(q, cust.id, "50002", 8, user.id, "2027-01-01");
const sid2 = await saveStanding(q, null, { ...input, validFrom: "2026-12-30", validTo: null, lines: [{ weekday: 3, sku: "50002", quantity: 10 }, { weekday: 0, sku: "50002", quantity: 10 }] }, user.id);
await generateStanding(q, "2026-12-30", "2027-01-03", user.id);
const prices = await q("select d.delivery_date::text as d, l.unit_price::float as p from delivery_lines l join deliveries d on d.id = l.delivery_id join orders o on o.id = d.order_id where o.standing_order_id = $1 order by d.delivery_date", [sid2]);
check("price follows the agreement's start date", prices, [{ d: "2026-12-30", p: 10 }, { d: "2027-01-03", p: 8 }]);

// ---------- automatic generation
const autoDays = async () => (await q("select sd.day::text from standing_order_days sd where sd.standing_order_id = $1 and sd.generated_order_id is not null and sd.day >= '2027-01-05' order by sd.day", [sid2])).map((r) => r.day);
check("automation is off until someone switches it on", [(await getAuto(q)).settings, await runAuto(q, "2027-01-06T08:00:00+02:00"), await autoDays()], [{ enabled: false, daysAhead: 7 }, null, []]);
await refuses("days ahead must be at least 1", () => setAuto(q, { enabled: true, daysAhead: 0 }, user.id), "בין 1 ל-30");
await refuses("days ahead is capped", () => setAuto(q, { enabled: true, daysAhead: 31 }, user.id), "בין 1 ל-30");
await setAuto(q, { enabled: true, daysAhead: 7 }, user.id);
// 2027-01-06 is a Wednesday, a day this standing order delivers on.
const a1 = await runAuto(q, "2027-01-06T08:00:00+02:00");
check("automatic run creates tomorrow up to seven days ahead, and never today", [a1.created, await autoDays()], [2, ["2027-01-10", "2027-01-13"]]);
check("automatic orders have no owner and are approved", await one("select o.owner_id, d.status::text from orders o join deliveries d on d.order_id = o.id where d.delivery_date = '2027-01-13'"), { owner_id: null, status: "approved" });
check("a second automatic run creates nothing", (await runAuto(q, "2027-01-06T08:15:00+02:00")).created, 0);
check("the last run is remembered", (({ created, from, to, error }) => ({ created, from, to, error }))((await getAuto(q)).lastRun), { created: 0, from: "2027-01-07", to: "2027-01-13", error: null });
await runAuto(q, "2027-01-06T22:30:00Z");
check("the day changes at midnight in Israel, not in UTC", (await getAuto(q)).lastRun.from, "2027-01-08");
await recordAutoFailure(q, "הדגמת תקלה");
check("a failed run is shown as failed", (await getAuto(q)).lastRun.error, "הדגמת תקלה");
await setAuto(q, { enabled: false, daysAhead: 7 }, user.id);
check("switching it off stops it", await runAuto(q, "2027-01-20T08:00:00+02:00"), null);

// ---------- limits
await refuses("bad range", () => generateStanding(q, "2026-12-10", "2026-12-01", user.id), "מוקדם");
await refuses("range too long", () => generateStanding(q, "2026-01-01", "2026-12-31", user.id), "חודשיים");
await q("update customers set active = false where id = $1", [cust.id]);
check("inactive customer gets no new orders", (await generateStanding(q, "2027-01-04", "2027-01-08", user.id)).created, 0);
check("generation is recorded in the history", (await one("select count(*)::int as n from audit_log where action = 'generate_standing'")).n >= 6, true);

console.log(failed ? `STANDING CHECK FAILED (${failed})` : "STANDING CHECK PASSED");
process.exit(failed ? 1 : 0);
