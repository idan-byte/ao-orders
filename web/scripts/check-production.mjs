// Tests the production plan: aggregation across orders, shifts, locking, late-change detection, marking done.
// Run from the web folder:  node scripts/check-production.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { planRows, planSources, lockPlan, unlockPlan, lockedPlans, acknowledgeChanges, isLockedFor, markProduced, moveShift, lockTimes, setLockTime, runAutoLock } from "../src/lib/production-core.ts";
import { createOrder, updateDelivery, cancelDelivery } from "../src/lib/orders-core.ts";

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
const [sand, hot] = (await q("select id from departments order by id")).map((r) => r.id);
await q(`insert into products (sku, name, base_price) values ('50002', 'כריך 120 גרם', 10), ('50021', 'כריך לחמניה', 5.8), ('50042', 'טוסט', 5.62), ('50010', 'חמגשית', 21.74), ('50029', 'הובלה', 173.16)`);
await q("insert into product_ops (sku, orderable, department_id, default_shift) values ('50002', true, $1, 1), ('50021', true, $1, 1), ('50042', true, $1, 2), ('50010', true, $2, 0), ('50029', true, null, 2)", [sand, hot]);
await q("insert into product_variants (sku, name) values ('50002', 'טונה'), ('50002', 'חביתה')");
const [tuna, egg] = (await q("select id from product_variants order by id")).map((r) => r.id);
const user = await one("insert into users (mobile, full_name, role) values ('0500000005', 'מנהל כריכים', 'dept_manager') returning id::text");
const cust = [];
for (const n of ["לקוח א", "לקוח ב", "לקוח ג"]) cust.push((await one("insert into customers (name) values ($1) returning id::text", [n])).id);
const DAY = "2026-12-01";
const L = (sku, quantity, variantId = null) => ({ sku, description: sku, quantity, unitPrice: 8, variantId });
const draft = (lines, extra = {}) => ({ lines, discountPct: 0, deliveryFee: 0, deliveryDate: DAY, windowFrom: "07:00", windowTo: null, addressId: null, customerNotes: null, internalNotes: null, validUntil: null, paymentTerms: null, ...extra });
const view = (rows) => rows.map((r) => [r.shift, r.sku, r.variant, r.quantity]);

// ---------- aggregation: three orders for the same day become one line per product and variant
const o1 = await createOrder(q, cust[0], user.id, draft([L("50002", 60, tuna), L("50002", 40, egg), L("50042", 30), L("50010", 120), L("50029", 1)], { internalNotes: "בלי חמוצים" }));
await createOrder(q, cust[1], user.id, draft([L("50002", 100, tuna), L("50002", 50, egg)], { windowFrom: "06:30" }));
const o3 = await createOrder(q, cust[2], user.id, draft([L("50002", 40, tuna), L("50002", 60, egg), L("50042", 20), L("50002", 25, tuna)]));
await createOrder(q, cust[0], user.id, draft([L("50002", 999, tuna)], { deliveryDate: "2026-12-02" }));
check("sandwich department: quantities summed across orders, by shift", view(await planRows(q, DAY, sand)), [[1, "50002", "טונה", 225], [1, "50002", "חביתה", 150], [2, "50042", null, 50]]);
check("hot kitchen sees only its own products", view(await planRows(q, DAY, hot)), [[0, "50010", null, 120]]);
check("service lines (delivery fee) never reach production", (await planRows(q, DAY, sand)).some((r) => r.sku === "50029"), false);
check("another day is separate", view(await planRows(q, "2026-12-02", sand)), [[1, "50002", "טונה", 999]]);
const src = (await planSources(q, DAY, sand)).filter((s) => s.sku === "50002" && s.variantId === tuna);
check("sources list each order once, earliest delivery first, with notes", src.map((s) => [s.customer, s.quantity, s.window, s.notes]), [["לקוח ב", 100, "06:30", null], ["לקוח א", 60, "07:00", "בלי חמוצים"], ["לקוח ג", 65, "07:00", null]]);
await refuses("bad date", () => planRows(q, "1/12", sand), "תאריך");

// ---------- cancelled deliveries drop out
const d3 = (await one("select id::text from deliveries where order_id = $1", [o3.orderId])).id;
await cancelDelivery(q, d3, "בוטל", user.id);
check("cancelled order is no longer in the plan", view(await planRows(q, DAY, sand)), [[1, "50002", "טונה", 160], [1, "50002", "חביתה", 90], [2, "50042", null, 30]]);

// ---------- lock, then a late change
check("nothing locked yet", [await lockedPlans(q, DAY, sand), await isLockedFor(q, DAY, ["50002"])], [[], false]);
const planId = await lockPlan(q, DAY, sand, 1, user.id);
await refuses("a shift cannot be locked twice", () => lockPlan(q, DAY, sand, 1, user.id), "כבר נעולה");
await refuses("unknown shift", () => lockPlan(q, DAY, sand, 7, user.id), "אינה מוכרת");
check("locked, with no changes", (await lockedPlans(q, DAY, sand)).map((p) => [p.shift, p.lockedBy, p.changes.length]), [[1, "מנהל כריכים", 0]]);
check("lock is per department", [await isLockedFor(q, DAY, ["50002"]), await isLockedFor(q, DAY, ["50010"]), await isLockedFor(q, "2026-12-02", ["50002"]), await isLockedFor(q, DAY, [])], [true, false, false, false]);

const d1 = (await one("select id::text from deliveries where order_id = $1", [o1.orderId])).id;
await updateDelivery(q, d1, { lines: [{ sku: "50002", variantId: tuna, quantity: 80, unitPrice: 8 }, { sku: "50042", quantity: 30, unitPrice: 8 }, { sku: "50010", quantity: 120, unitPrice: 8 }, { sku: "50029", quantity: 1, unitPrice: 8 }], deliveryDate: DAY, windowFrom: "07:00", windowTo: null, addressId: null, productionNotes: "בלי חמוצים", shippingNotes: null }, user.id);
const late = (await lockedPlans(q, DAY, sand))[0].changes;
check("late change shows old and new totals per product", late.map((c) => [c.label, c.before, c.after]), [["כריך 120 גרם · חביתה", 90, 50], ["כריך 120 גרם · טונה", 160, 180]]);
check("the live plan already has the new numbers", view(await planRows(q, DAY, sand)).slice(0, 2), [[1, "50002", "טונה", 180], [1, "50002", "חביתה", 50]]);
await createOrder(q, cust[1], user.id, draft([L("50021", 10)]));
await refuses("a product with variants cannot be ordered without one", () => createOrder(q, cust[1], user.id, draft([L("50002", 10, null)])), "יש לבחור אחד מהם");
check("a brand-new late order also shows up as a change", (await lockedPlans(q, DAY, sand))[0].changes.map((c) => [c.label, c.before, c.after]), [["כריך 120 גרם · חביתה", 90, 50], ["כריך 120 גרם · טונה", 160, 180], ["כריך לחמניה", 0, 10]]);

check("acknowledging records the changes", await acknowledgeChanges(q, DAY, sand, planId, user.id), 3);
check("after acknowledging there is nothing pending, and the log keeps the history", [(await lockedPlans(q, DAY, sand))[0].changes.length, (await q("select sku, old_quantity::float as o, new_quantity::float as n, acknowledged_by::text = $1 as mine from production_changes order by sku, variant_id nulls first", [user.id])).length], [0, 3]);
check("acknowledging again does nothing", await acknowledgeChanges(q, DAY, sand, planId, user.id), 0);
await refuses("acknowledging an unknown plan", () => acknowledgeChanges(q, DAY, sand, "00000000-0000-0000-0000-000000000000", user.id), "לא נמצאה");

// ---------- moving a product to another shift
check("move toast from morning to night", await moveShift(q, DAY, sand, 2, 1, "50042", null), 1);
check("totals are unchanged by the move", view(await planRows(q, DAY, sand)).filter((r) => r[1] === "50042"), [[1, "50042", null, 30]]);
check("a move into a locked shift is reported as a change", (await lockedPlans(q, DAY, sand))[0].changes.map((c) => [c.label, c.before, c.after]), [["טוסט", 0, 30]]);
await moveShift(q, DAY, sand, 1, 2, "50042", null);
check("moving back clears it", (await lockedPlans(q, DAY, sand))[0].changes.length, 0);
await refuses("move to an unknown shift", () => moveShift(q, DAY, sand, 1, 9, "50042", null), "אינה מוכרת");
check("moving to the same shift is a no-op", await moveShift(q, DAY, sand, 2, 2, "50042", null), 0);

// ---------- marking done drives the delivery status
const statusOf = async (id) => (await one("select status::text as s from deliveries where id = $1", [id])).s;
check("before any work", await statusOf(d1), "approved");
await markProduced(q, DAY, sand, 1, "50002", tuna, true, user.id);
check("first product made -> in production", [await statusOf(d1), (await planRows(q, DAY, sand)).find((r) => r.variant === "טונה").producedLines], ["in_production", 2]);
await markProduced(q, DAY, sand, 2, "50042", null, true, user.id);
check("other department still has work -> still in production", await statusOf(d1), "in_production");
await markProduced(q, DAY, hot, 0, "50010", null, true, user.id);
check("every department done -> ready to ship (the delivery fee line needs no production)", await statusOf(d1), "ready_to_ship");
await markProduced(q, DAY, hot, 0, "50010", null, false, user.id);
check("unmarking takes it back to in production", await statusOf(d1), "in_production");
await markProduced(q, DAY, sand, 1, "50002", tuna, false, user.id);
await markProduced(q, DAY, sand, 2, "50042", null, false, user.id);
check("unmarking everything takes it back to approved", await statusOf(d1), "approved");
check("status changes from the production screen are in the history", (await one("select count(*)::int as n from audit_log where action = 'delivery_status' and after->>'note' = 'לפי סימון במסך הייצור'")).n >= 4, true);
check("cancelled delivery lines are never marked", (await one("select count(*)::int as n from delivery_lines where delivery_id = $1 and produced_at is not null", [d3])).n, 0);

// ---------- unlock
await unlockPlan(q, planId);
check("unlocked", [await lockedPlans(q, DAY, sand), await isLockedFor(q, DAY, ["50002"])], [[], false]);

// ---------- automatic lock by time
const at = (t) => `2027-03-09T${t}:00+02:00`; // a Tuesday, Israel winter time
check("no lock times, nothing locks by itself", await runAutoLock(q, at("23:00")), []);
await refuses("lock time needs an hour", () => setLockTime(q, sand, 1, { dayOffset: 1, time: "" }, user.id), "שעת נעילה");
await refuses("lock day is limited", () => setLockTime(q, sand, 1, { dayOffset: 4, time: "20:00" }, user.id), "יום הנעילה");
await refuses("lock time for an unknown shift", () => setLockTime(q, sand, 9, { dayOffset: 1, time: "20:00" }, user.id), "אינה מוכרת");
await setLockTime(q, sand, 1, { dayOffset: 1, time: "20:00" }, user.id);
await setLockTime(q, hot, 0, { dayOffset: 1, time: "14:00" }, user.id);
check("lock times are stored per department", [await lockTimes(q, sand), await lockTimes(q, hot)], [[{ shift: 1, dayOffset: 1, time: "20:00" }], [{ shift: 0, dayOffset: 1, time: "14:00" }]]);
check("at 19:59 only what is already due locks: today, and tomorrow's hot kitchen", await runAutoLock(q, at("19:59")), [{ date: "2027-03-09", departmentId: sand, shift: 1 }, { date: "2027-03-09", departmentId: hot, shift: 0 }, { date: "2027-03-10", departmentId: hot, shift: 0 }]);
check("at 20:00 tomorrow's night shift locks", await runAutoLock(q, at("20:00")), [{ date: "2027-03-10", departmentId: sand, shift: 1 }]);
check("a second run locks nothing more", await runAutoLock(q, at("20:15")), []);
check("an order cannot slip in: the guard sees the automatic lock", await isLockedFor(q, "2027-03-10", ["50002"]), true);
await createOrder(q, cust[0], user.id, draft([L("50002", 30, tuna)], { deliveryDate: "2027-03-10" }));
const auto = (await lockedPlans(q, "2027-03-10", sand))[0];
check("an order that arrives after the automatic lock is a late change, and the lock has no person behind it", [auto.lockedBy, auto.changes.map((c) => [c.before, c.after])], [null, [[0, 30]]]);
await unlockPlan(q, auto.planId);
check("a plan a manager unlocked is not locked again automatically", [await runAutoLock(q, at("21:00")), await lockedPlans(q, "2027-03-10", sand)], [[], []]);
await lockPlan(q, "2027-03-10", sand, 1, user.id);
check("and can be locked again by hand", (await lockedPlans(q, "2027-03-10", sand)).length, 1);
await setLockTime(q, sand, 1, null, user.id);
check("removing the lock time returns the shift to manual locking", [await lockTimes(q, sand), (await runAutoLock(q, "2027-03-10T21:00:00+02:00")).map((p) => [p.date, p.departmentId])], [[], [["2027-03-11", hot]]]);
check("automatic locks are written to the history", (await one("select count(*)::int as n from audit_log where action = 'auto_lock' and user_id is null")).n, 5);

console.log(failed ? `PRODUCTION CHECK FAILED (${failed})` : "PRODUCTION CHECK PASSED");
process.exit(failed ? 1 : 0);
