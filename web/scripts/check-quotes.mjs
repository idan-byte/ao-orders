// Tests quote totals, versions, sending, approval and conversion to an order on a throwaway in-memory PostgreSQL.
// Run from the web folder:  node scripts/check-quotes.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { computeTotals, createQuote, saveDraft, sendQuote, approveQuote, rejectQuote, findByToken, validateDraft, VAT_RATE } from "../src/lib/quotes-core.ts";

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
  try {
    await fn();
    failed++;
    console.log(`FAIL ${label} -> was accepted`);
  } catch (e) {
    const ok = !fragment || e.message.includes(fragment);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> wrong message: ${e.message}`}`);
  }
}
const L = (sku, quantity, unitPrice, extra = {}) => ({ sku, description: sku, quantity, unitPrice, ...extra });
const pick = (t) => [t.subtotal, t.discount, t.beforeVat, t.vat, t.total];

// ---------- totals
check("plain order", pick(computeTotals([L("a", 60, 8), L("a", 40, 8), L("b", 40, 5), L("c", 30, 8)], 0, 0, VAT_RATE)), [1240, 0, 1240, 223.2, 1463.2]);
check("document discount 10%", pick(computeTotals([L("a", 60, 8), L("a", 40, 8), L("b", 40, 5), L("c", 30, 8)], 10, 0, VAT_RATE)), [1240, 124, 1116, 200.88, 1316.88]);
check("line discount", computeTotals([L("a", 10, 10, { discountPct: 25 })], 0, 0, VAT_RATE).lines, [75]);
check("three-decimal price rounds per line", computeTotals([L("a", 3, 21.739)], 0, 0, VAT_RATE).lines, [65.22]);
check("half agora rounds up", computeTotals([L("a", 1, 1.005)], 0, 0, VAT_RATE).lines, [1.01]);
check("delivery fee is taxed", pick(computeTotals([L("a", 10, 10)], 0, 173.16, VAT_RATE)), [100, 0, 273.16, 49.17, 322.33]);
check("VAT-exempt line", pick(computeTotals([L("a", 10, 10), L("fruit", 5, 10, { vatExempt: true })], 0, 20, VAT_RATE)), [150, 0, 170, 21.6, 191.6]);
check("VAT-exempt customer", pick(computeTotals([L("a", 10, 10)], 0, 20, VAT_RATE, true)), [100, 0, 120, 0, 120]);
check("VAT rounded once on the document, not per line", computeTotals(Array.from({ length: 7 }, () => L("a", 1, 0.03)), 0, 0, VAT_RATE).vat, 0.04);
check("empty quote", pick(computeTotals([], 0, 0, VAT_RATE)), [0, 0, 0, 0, 0]);
const t = computeTotals([L("a", 7, 13.37, { discountPct: 3 }), L("b", 13, 4.99)], 7.5, 35, VAT_RATE);
check("total always equals before-VAT plus VAT", Math.round((t.beforeVat + t.vat) * 100), Math.round(t.total * 100));

// ---------- validation
const base = { lines: [L("50002", 10, 8)], discountPct: 0, deliveryFee: 0, deliveryDate: "2026-11-20", windowFrom: null, windowTo: null, addressId: null, customerNotes: null, internalNotes: null, validUntil: "2026-11-30", paymentTerms: null };
check("valid draft", validateDraft(base), null);
check("zero quantity", validateDraft({ ...base, lines: [L("50002", 0, 8)] })?.includes("כמות"), true);
check("negative price", validateDraft({ ...base, lines: [L("50002", 1, -1)] })?.includes("מחיר"), true);
check("discount above 100", validateDraft({ ...base, discountPct: 120 })?.includes("הנחה"), true);
check("bad date", validateDraft({ ...base, deliveryDate: "20/11/2026" })?.includes("תאריך"), true);

// ---------- flow
await q("insert into products (sku, name, base_price) values ('50002', 'כריך 120 גרם', 10), ('50088', 'קוקטיל', 5.5), ('50029', 'הובלה', 173.16)");
const cust = await one("insert into customers (name) values ('לקוח בדיקה') returning id::text");
const other = await one("insert into customers (name) values ('לקוח אחר') returning id::text");
const user = await one("insert into users (mobile, full_name, role) values ('0500000002', 'מוכרת', 'sales') returning id::text");
const addr = await one("insert into customer_addresses (customer_id, street, city) values ($1, 'רחוב הבדיקה 1', 'ירושלים') returning id::text", [cust.id]);
const foreignAddr = await one("insert into customer_addresses (customer_id, street) values ($1, 'כתובת של לקוח אחר') returning id::text", [other.id]);

const { quoteId, number } = await createQuote(q, cust.id, user.id);
check("quote gets a number", number >= 1000, true);
await refuses("send without lines", () => sendQuote(q, quoteId), "בלי שורות");
await refuses("unknown sku", () => saveDraft(q, quoteId, { ...base, lines: [L("nope", 1, 1)] }), "אינו קיים");
await refuses("address of another customer", () => saveDraft(q, quoteId, { ...base, addressId: foreignAddr.id }), "אינה שייכת");

await saveDraft(q, quoteId, { ...base, deliveryDate: null });
await refuses("send without a delivery date", () => sendQuote(q, quoteId), "תאריך אספקה");

const lines1 = [L("50002", 60, 8, { description: "כריך 120 גרם" }), L("50088", 40, 5), L("50002", 100, 8, { deliveryDate: "2026-11-21" })];
const s1 = await saveDraft(q, quoteId, { ...base, lines: lines1, deliveryFee: 173.16, addressId: addr.id, windowFrom: "07:00", windowTo: "09:00" });
check("draft totals stored", [s1.version, s1.totals.beforeVat, s1.totals.vat, s1.totals.total], [1, 1653.16, 297.57, 1950.73]);
const sent1 = await sendQuote(q, quoteId);
check("sent version 1", [sent1.version, sent1.token.length >= 20, (await one("select status::text as s from quotes where id = $1", [quoteId])).s], [1, true, "sent"]);
await refuses("cannot send the same version twice", () => sendQuote(q, quoteId), "כבר נשלחה");
check("link finds the quote", (await findByToken(q, sent1.token))?.versionId, sent1.versionId);
check("garbage link", await findByToken(q, "x"), null);

// editing after sending opens version 2 and leaves version 1 untouched
const s2 = await saveDraft(q, quoteId, { ...base, lines: [...lines1.slice(0, 2), L("50002", 120, 7.5, { deliveryDate: "2026-11-21" })], deliveryFee: 173.16, addressId: addr.id });
check("edit after send opens version 2", [s2.version, (await one("select status::text as s from quotes where id = $1", [quoteId])).s], [2, "draft"]);
const v1 = await one("select total::float as total, (select count(*)::int from quote_lines where quote_version_id = v.id) as n, (select max(quantity)::float from quote_lines where quote_version_id = v.id) as maxq from quote_versions v where id = $1", [sent1.versionId]);
check("version 1 is frozen", [v1.total, v1.n, v1.maxq], [1950.73, 3, 100]);
await refuses("draft version cannot be approved", () => approveQuote(q, quoteId, s2.versionId, { method: "manual", name: "בודק", userId: user.id }), "עוד לא נשלחה");
const sent2 = await sendQuote(q, quoteId);
check("old link stops working once version 2 is sent", [await findByToken(q, sent1.token), (await findByToken(q, sent2.token))?.versionId], [null, sent2.versionId]);
await refuses("old version cannot be approved", () => approveQuote(q, quoteId, sent1.versionId, { method: "link", name: "לקוח" }, "2026-11-12"), "הגרסה העדכנית");
await refuses("approver name required", () => approveQuote(q, quoteId, sent2.versionId, { method: "link", name: " " }, "2026-11-12"), "שם המאשר");
await refuses("expired quote cannot be approved by link", () => approveQuote(q, quoteId, sent2.versionId, { method: "link", name: "לקוח" }, "2026-12-15"), "פג");

// approval -> order
const a1 = await approveQuote(q, quoteId, sent2.versionId, { method: "link", name: "ישראל ישראלי" }, "2026-11-12");
check("approval opens an order", [a1.alreadyApproved, a1.orderNumber >= 1000], [false, true]);
const order = await one("select source::text, discount_pct::float as d, vat_rate::float as vat, delivery_fee::float as fee, quote_version_id::text as v from orders where id = $1", [a1.orderId]);
check("order copies the commercial terms", order, { source: "quote", d: 0, vat: 0.18, fee: 173.16, v: sent2.versionId });
const dels = await q("select delivery_date::text as d, status::text as s, address_snapshot as a, (select count(*)::int from delivery_lines l where l.delivery_id = dl.id) as n from deliveries dl where order_id = $1 order by delivery_date", [a1.orderId]);
check("one delivery per date, approved, with the address", dels, [{ d: "2026-11-20", s: "approved", a: "רחוב הבדיקה 1, ירושלים", n: 2 }, { d: "2026-11-21", s: "approved", a: "רחוב הבדיקה 1, ירושלים", n: 1 }]);
check("agreed prices copied to the order", (await q("select quantity::float as q, unit_price::float as p from delivery_lines l join deliveries d on d.id = l.delivery_id where d.order_id = $1 order by d.delivery_date, l.id", [a1.orderId])), [{ q: 60, p: 8 }, { q: 40, p: 5 }, { q: 120, p: 7.5 }]);
const ver = await one("select approved_by_name as n, approval_method as m, approved_at is not null as at from quote_versions where id = $1", [sent2.versionId]);
check("approval evidence stored", [ver.n, ver.m, ver.at, (await one("select status::text as s from quotes where id = $1", [quoteId])).s], ["ישראל ישראלי", "link", true, "approved"]);

const a2 = await approveQuote(q, quoteId, sent2.versionId, { method: "link", name: "ישראל ישראלי" }, "2026-11-12");
check("approving again returns the same order", [a2.alreadyApproved, a2.orderId === a1.orderId, (await one("select count(*)::int as n from orders")).n], [true, true, 1]);
await refuses("approved quote cannot be edited", () => saveDraft(q, quoteId, base), "שאושרה");
await refuses("approved quote cannot be rejected", () => rejectQuote(q, quoteId, "מחיר"), "שאושרה");
await q("update products set base_price = 99 where sku = '50002'");
check("later price changes do not touch the order", (await one("select max(unit_price)::float as p from delivery_lines")).p, 8);

// manual approval after expiry, and rejection
const q2 = await createQuote(q, cust.id, user.id);
await saveDraft(q, q2.quoteId, { ...base, validUntil: "2026-11-13" });
const sentB = await sendQuote(q, q2.quoteId);
const m = await approveQuote(q, q2.quoteId, sentB.versionId, { method: "manual", name: "אישור טלפוני, דנה", userId: user.id }, "2026-12-01");
check("an employee can approve an expired quote by phone", [m.alreadyApproved, (await one("select count(*)::int as n from audit_log where action = 'approve_quote'")).n], [false, 1]);

const q3 = await createQuote(q, cust.id, user.id);
await saveDraft(q, q3.quoteId, base);
const sentC = await sendQuote(q, q3.quoteId);
await refuses("rejection needs a reason", () => rejectQuote(q, q3.quoteId, ""), "סיבה");
await rejectQuote(q, q3.quoteId, "מחיר");
check("rejected quote: status, reason, link withdrawn", [(await one("select status::text as s, lost_reason as r from quotes where id = $1", [q3.quoteId])), await findByToken(q, sentC.token)], [{ s: "rejected", r: "מחיר" }, null]);
await refuses("rejected quote cannot be approved", () => approveQuote(q, q3.quoteId, sentC.versionId, { method: "manual", name: "בודק", userId: user.id }), "נדחתה");
await refuses("quote for unknown customer", () => createQuote(q, "00000000-0000-0000-0000-000000000000", user.id), "הלקוח לא נמצא");

console.log(failed ? `QUOTES CHECK FAILED (${failed})` : "QUOTES CHECK PASSED");
process.exit(failed ? 1 : 0);
