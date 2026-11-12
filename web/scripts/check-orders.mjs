// Tests manual orders, changes with history, status transitions and the derived order status.
// Run from the web folder:  node scripts/check-orders.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createOrder, updateDelivery, advanceDelivery, holdDelivery, releaseDelivery, cancelDelivery } from "../src/lib/orders-core.ts";

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
const status = async (id) => (await one("select status::text as s from deliveries where id = $1", [id])).s;
const orderStatus = async (id) => (await one("select status from order_status where order_id = $1", [id])).status;

await q("insert into products (sku, name, base_price) values ('50002', 'כריך 120 גרם', 10), ('50088', 'קוקטיל', 5.5), ('50042', 'טוסט', 5.62)");
const user = await one("insert into users (mobile, full_name, role) values ('0500000004', 'עובד הזמנות', 'order_clerk') returning id::text");
const cust = await one("insert into customers (name) values ('לקוח בדיקה') returning id::text");
const other = await one("insert into customers (name) values ('לקוח אחר') returning id::text");
const addr = await one("insert into customer_addresses (customer_id, street, city) values ($1, 'רחוב הבדיקה 1', 'ירושלים') returning id::text", [cust.id]);
const addr2 = await one("insert into customer_addresses (customer_id, street, city) values ($1, 'סניף שני 7', 'ירושלים') returning id::text", [cust.id]);
const foreign = await one("insert into customer_addresses (customer_id, street) values ($1, 'כתובת זרה') returning id::text", [other.id]);
const L = (sku, quantity, unitPrice, extra = {}) => ({ sku, description: sku, quantity, unitPrice, ...extra });
const base = { lines: [L("50002", 60, 8), L("50088", 40, 5)], discountPct: 0, deliveryFee: 0, deliveryDate: "2026-12-01", windowFrom: "07:00", windowTo: "09:00", addressId: addr.id, customerNotes: "למסור בשער 3", internalNotes: "בלי חמוצים", validUntil: null, paymentTerms: null };

// ---------- creating
await refuses("order without lines", () => createOrder(q, cust.id, user.id, { ...base, lines: [] }), "בלי פריטים");
await refuses("order without a delivery date", () => createOrder(q, cust.id, user.id, { ...base, deliveryDate: null }), "תאריך אספקה");
await refuses("order for unknown customer", () => createOrder(q, "00000000-0000-0000-0000-000000000000", user.id, base), "לא נמצא");
await refuses("order with unknown sku", () => createOrder(q, cust.id, user.id, { ...base, lines: [L("nope", 1, 1)] }), "אינו קיים");
await refuses("order with someone else's address", () => createOrder(q, cust.id, user.id, { ...base, addressId: foreign.id }), "אינה שייכת");
await refuses("order with zero quantity", () => createOrder(q, cust.id, user.id, { ...base, lines: [L("50002", 0, 8)] }), "כמות");

const o1 = await createOrder(q, cust.id, user.id, { ...base, lines: [...base.lines, L("50002", 100, 8, { deliveryDate: "2026-12-02" })], deliveryFee: 173.16 });
check("order number and one delivery per date", [o1.number >= 1000, o1.deliveries], [true, 2]);
const dels = await q("select id::text, delivery_date::text as d, status::text as s, to_char(window_from, 'HH24:MI') as f, address_snapshot as a, production_notes as p, shipping_notes as sh from deliveries where order_id = $1 order by delivery_date", [o1.orderId]);
check("deliveries are approved and carry address, window and notes", dels.map((r) => ({ d: r.d, s: r.s, f: r.f, a: r.a, p: r.p, sh: r.sh })), [
  { d: "2026-12-01", s: "approved", f: "07:00", a: "רחוב הבדיקה 1, ירושלים", p: "בלי חמוצים", sh: "למסור בשער 3" },
  { d: "2026-12-02", s: "approved", f: "07:00", a: "רחוב הבדיקה 1, ירושלים", p: "בלי חמוצים", sh: "למסור בשער 3" },
]);
check("order header", await one("select source::text, vat_rate::float as vat, delivery_fee::float as fee from orders where id = $1", [o1.orderId]), { source: "manual", vat: 0.18, fee: 173.16 });
check("order status follows its deliveries", await orderStatus(o1.orderId), "approved");
const [d1, d2] = dels.map((d) => d.id);

// ---------- changing, with history
const edit = { lines: [{ sku: "50002", quantity: 80, unitPrice: 8 }, { sku: "50088", quantity: 40, unitPrice: 5 }], deliveryDate: "2026-12-01", windowFrom: "07:00", windowTo: "09:00", addressId: addr.id, productionNotes: "בלי חמוצים", shippingNotes: "למסור בשער 3" };
check("quantity change is recorded per product", await updateDelivery(q, d1, edit, user.id), [{ what: "כמות 50002", before: 60, after: 80 }]);
check("no change, no history entry", [await updateDelivery(q, d1, edit, user.id), (await one("select count(*)::int as n from audit_log where action = 'update_delivery'")).n], [[], 1]);
const ch = await updateDelivery(q, d1, { ...edit, lines: [{ sku: "50002", quantity: 80, unitPrice: 7.5 }, { sku: "50042", quantity: 30, unitPrice: 8 }], deliveryDate: "2026-12-03", windowTo: "08:30", addressId: addr2.id, shippingNotes: null }, user.id);
check("mixed change lists every difference", ch.map((c) => c.what).sort(), ["כמות 50042", "כמות 50088", "כתובת אספקה", "מחיר 50002", "עד שעה", "הערות לשילוח", "תאריך אספקה"].sort());
check("removed and added products", [ch.find((c) => c.what === "כמות 50088"), ch.find((c) => c.what === "כמות 50042")], [{ what: "כמות 50088", before: 40, after: 0 }, { what: "כמות 50042", before: 0, after: 30 }]);
check("the delivery itself is updated", await one("select delivery_date::text as d, address_snapshot as a, shipping_notes as sh, (select sum(quantity)::float from delivery_lines where delivery_id = dl.id) as units from deliveries dl where id = $1", [d1]), { d: "2026-12-03", a: "סניף שני 7, ירושלים", sh: null, units: 110 });
check("history stores what changed, by whom", (await one("select user_id::text = $1 as mine, jsonb_array_length(after->'changes') as n from audit_log where action = 'update_delivery' order by id desc limit 1", [user.id])), { mine: true, n: 7 });
await refuses("delivery cannot be emptied by editing", () => updateDelivery(q, d1, { ...edit, lines: [] }, user.id), "ביטול");
await refuses("edit with a foreign address", () => updateDelivery(q, d1, { ...edit, addressId: foreign.id }, user.id), "אינה שייכת");
await refuses("edit with a bad date", () => updateDelivery(q, d1, { ...edit, deliveryDate: "3/12" }, user.id), "תאריך");
await refuses("edit with a negative price", () => updateDelivery(q, d1, { ...edit, lines: [{ sku: "50002", quantity: 1, unitPrice: -1 }] }, user.id), "מחיר");

// ---------- status path
check("approved -> in production", await advanceDelivery(q, d1, "approved", user.id), "in_production");
await refuses("stale click is refused", () => advanceDelivery(q, d1, "approved", user.id), "לרענן");
check("order shows the earliest stage among its deliveries", await orderStatus(o1.orderId), "approved");
check("in production -> ready to ship", await advanceDelivery(q, d1, "in_production", user.id), "ready_to_ship");
await refuses("ready-to-ship cannot be advanced here (shipping issues the delivery note)", () => advanceDelivery(q, d1, "ready_to_ship", user.id), "אין שלב הבא");
await refuses("ready-to-ship delivery cannot be edited", () => updateDelivery(q, d1, edit, user.id), "אינה ניתנת לשינוי");

// ---------- hold and release
await refuses("hold needs a note", () => holdDelivery(q, d2, "exception", " ", user.id), "מה הבעיה");
await holdDelivery(q, d2, "exception", "הלקוח ביקש להקדים, ממתין להחלטה", user.id);
check("exception: status, note, order flagged", [await status(d2), (await one("select exception_note as n from deliveries where id = $1", [d2])).n, await orderStatus(o1.orderId)], ["exception", "הלקוח ביקש להקדים, ממתין להחלטה", "exception"]);
await refuses("a held delivery cannot be held again", () => holdDelivery(q, d2, "delayed", "x", user.id), "אי אפשר לסמן");
check("release returns it to where it was", [await releaseDelivery(q, d2, user.id), (await one("select exception_note as n from deliveries where id = $1", [d2])).n], ["approved", null]);
await advanceDelivery(q, d2, "approved", user.id);
await holdDelivery(q, d2, "delayed", "חסר חומר גלם", user.id);
check("release after a delay returns to in production", await releaseDelivery(q, d2, user.id), "in_production");
await refuses("release when not held", () => releaseDelivery(q, d2, user.id), "אינה מסומנת");

// ---------- cancel, and derived order status
await refuses("cancel needs a reason", () => cancelDelivery(q, d2, "", user.id), "סיבת הביטול");
await cancelDelivery(q, d2, "הלקוח ביטל את היום השני", user.id);
check("cancelled delivery keeps its reason", (await one("select status::text as s, cancel_reason as r from deliveries where id = $1", [d2])), { s: "cancelled", r: "הלקוח ביטל את היום השני" });
await refuses("cancelled delivery cannot be cancelled again", () => cancelDelivery(q, d2, "שוב", user.id), "אינה ניתנת לביטול");
await refuses("cancelled delivery cannot be edited", () => updateDelivery(q, d2, edit, user.id), "אינה ניתנת לשינוי");
check("order with one live and one cancelled delivery", await orderStatus(o1.orderId), "ready_to_ship");
await q("update deliveries set status = 'shipped' where id = $1", [d1]);
await refuses("shipped delivery cannot be cancelled", () => cancelDelivery(q, d1, "מאוחר מדי", user.id), "אינה ניתנת לביטול");
check("shipped -> delivered", [await advanceDelivery(q, d1, "shipped", user.id), (await one("select delivered_at is not null as at from deliveries where id = $1", [d1])).at], ["delivered", true]);
check("delivered + cancelled = delivered", await orderStatus(o1.orderId), "delivered");

const o2 = await createOrder(q, cust.id, user.id, { ...base, lines: [L("50002", 10, 8), L("50002", 10, 8, { deliveryDate: "2026-12-05" })] });
const [e1, e2] = (await q("select id::text from deliveries where order_id = $1 order by delivery_date", [o2.orderId])).map((r) => r.id);
await q("update deliveries set status = 'delivered' where id = $1", [e1]);
check("one of two delivered = partially delivered", await orderStatus(o2.orderId), "partially_delivered");
await cancelDelivery(q, e2, "בוטל", user.id);
check("the rest cancelled = delivered", await orderStatus(o2.orderId), "delivered");
const o3 = await createOrder(q, cust.id, user.id, base);
await cancelDelivery(q, (await one("select id::text from deliveries where order_id = $1", [o3.orderId])).id, "טעות בהזנה", user.id);
check("everything cancelled = cancelled", await orderStatus(o3.orderId), "cancelled");
check("every status change is in the history", (await one("select count(*)::int as n from audit_log where action = 'delivery_status'")).n, 11);

console.log(failed ? `ORDERS CHECK FAILED (${failed})` : "ORDERS CHECK PASSED");
process.exit(failed ? 1 : 0);
