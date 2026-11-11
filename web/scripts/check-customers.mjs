// Tests the Hashavshevet import and price-agreement logic against a throwaway in-memory PostgreSQL.
// Uses invented customers only. Run from the web folder:  node scripts/check-customers.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  importCatalog, importCustomers, importLastPrices, resolvePrice, approvePrices, setAgreedPrice, removePrice, isSuspiciousPrice,
} from "../src/lib/customers-core.ts";

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

const catalog = [
  { sku: "50002", name: "כריך 120 גרם", sort_group: 500, base_price_ex_vat: 10, sales_unit: null, vat_exempt: 0, lines_12m: 1800 },
  { sku: "50010", name: "חמגשית", sort_group: 600, base_price_ex_vat: 21.739, sales_unit: null, vat_exempt: 0, lines_12m: 240 },
  { sku: "50029", name: "הובלה", sort_group: 650, base_price_ex_vat: 173.16, sales_unit: null, vat_exempt: 0, lines_12m: 230 },
  { sku: "59999", name: "מוצר ישן", sort_group: 500, base_price_ex_vat: 5, sales_unit: null, vat_exempt: 0, lines_12m: 0 },
];
const customers = [
  { account_key: "30001", name: "לקוח בדיקה א", tax_id: "510000001", address: "רחוב הדוגמה 1", city: "ירושלים", phone: "02-0000001", fixed_discount_pct: 0, vat_exempt: 0, last_document_date: "2026-11-01" },
  { account_key: "30002", name: "לקוח בדיקה ב", tax_id: null, address: null, city: null, phone: null, fixed_discount_pct: 5, vat_exempt: 1, last_document_date: "2026-10-01" },
];

// --- catalog
check("catalog first import", await importCatalog(q, catalog), { created: 4, updated: 0 });
check("unused product is not orderable", (await one("select orderable from product_ops where sku = '59999'")).orderable, false);
check("service line has no department", (await one("select department_id from product_ops where sku = '50029'")).department_id, null);
await q("update product_ops set default_shift = 0, orderable = true where sku = '59999'");
check("catalog re-import", await importCatalog(q, [{ ...catalog[3], name: "מוצר ישן (שם חדש)", base_price_ex_vat: 6 }]), { created: 0, updated: 1 });
const p = await one("select p.name, p.base_price::float as base, o.default_shift, o.orderable from products p join product_ops o on o.sku = p.sku where p.sku = '59999'");
check("re-import refreshes Hashavshevet fields, keeps operational data", [p.name, p.base, p.default_shift, p.orderable], ["מוצר ישן (שם חדש)", 6, 0, true]);

// --- customers
check("customers first import", await importCustomers(q, customers), { created: 2, updated: 0 });
check("default address created from Hashavshevet", (await one("select count(*)::int as n from customer_addresses")).n, 1);
const a = await one("select id::text from customers where hash_account_key = '30001'");
const b = await one("select id::text from customers where hash_account_key = '30002'");
await q("update customers set notes = 'למסור בשער האחורי', billing_policy = 'monthly_summary' where id = $1", [a.id]);
await q("insert into customer_addresses (customer_id, street, city) values ($1, 'סניף שני 7', 'ירושלים')", [a.id]);
check("customers re-import", await importCustomers(q, [{ ...customers[0], name: "לקוח בדיקה א בע״מ", phone: "02-0000009" }]), { created: 0, updated: 1 });
const ca = await one("select name, hash_phone, notes, billing_policy::text from customers where id = $1", [a.id]);
check("re-import refreshes mirrored fields, keeps local data", [ca.name, ca.hash_phone, ca.notes, ca.billing_policy], ["לקוח בדיקה א בע״מ", "02-0000009", "למסור בשער האחורי", "monthly_summary"]);
check("re-import does not duplicate addresses", (await one("select count(*)::int as n from customer_addresses where customer_id = $1", [a.id])).n, 2);

// --- last prices -> pending
const prices = [
  { account_key: "30001", sku: "50002", last_price_ex_vat: 8, charged_on: "2026-11-01", source_document_type: 4, source_document_number: 39400 },
  { account_key: "30001", sku: "50010", last_price_ex_vat: 19.5, charged_on: "2026-10-20", source_document_type: 1, source_document_number: 27700 },
  { account_key: "30002", sku: "50002", last_price_ex_vat: 12, charged_on: "2026-09-15", source_document_type: 37, source_document_number: 2090 },
  { account_key: "39999", sku: "50002", last_price_ex_vat: 9, charged_on: "2026-09-15", source_document_type: 1, source_document_number: 1 },
  { account_key: "30001", sku: "00000", last_price_ex_vat: 9, charged_on: "2026-09-15", source_document_type: 1, source_document_number: 2 },
  { account_key: "30002", sku: "50010", last_price_ex_vat: 0, charged_on: "2026-09-15", source_document_type: 1, source_document_number: 3 },
];
check("prices first import", await importLastPrices(q, prices), { created: 3, refreshed: 0, skipped: 3 });
check("imported prices are pending", (await one("select count(*)::int as n from customer_prices where approved_at is not null")).n, 0);
check("pending price is not used", await resolvePrice(q, a.id, "50002", "2026-11-12"), { price: 10, source: "base" });
check("unknown product", await resolvePrice(q, a.id, "00000", "2026-11-12"), null);
check("source note keeps the document", (await one("select source_note from customer_prices where customer_id = $1 and sku = '50002'", [a.id])).source_note, "תעודת משלוח 39400");

// --- a document dated ahead must not produce a price that only starts in the future
const future = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
const today = (await one("select current_date::text as d")).d;
await importLastPrices(q, [{ account_key: "30002", sku: "50010", last_price_ex_vat: 20, charged_on: future, source_document_type: 4, source_document_number: 39500 }]);
check("future-dated document starts today", (await one("select valid_from::text as d from customer_prices where customer_id = $1 and sku = '50010'", [b.id])).d, today);
await q("delete from customer_prices where customer_id = $1 and sku = '50010'", [b.id]);

// --- approval
const row = await one("select id::text from customer_prices where customer_id = $1 and sku = '50002'", [a.id]);
const user = await one("insert into users (mobile, full_name, role) values ('0500000001', 'בודק', 'sales') returning id::text");
check("approve one row", await approvePrices(q, a.id, user.id, [row.id]), 1);
check("approved price is used", await resolvePrice(q, a.id, "50002", "2026-11-12"), { price: 8, source: "agreement" });
check("not before its start date", await resolvePrice(q, a.id, "50002", "2026-10-01"), { price: 10, source: "base" });
check("other customer unaffected", await resolvePrice(q, b.id, "50002", "2026-11-12"), { price: 10, source: "base" });
check("cannot approve another customer's row", await approvePrices(q, b.id, user.id, [row.id]), 0);
check("approve the rest", await approvePrices(q, a.id, user.id), 1);

// --- re-import must not override decisions
check("re-import after approval", await importLastPrices(q, [{ ...prices[0], last_price_ex_vat: 99 }, { ...prices[2], last_price_ex_vat: 12.5 }]), { created: 0, refreshed: 1, skipped: 1 });
check("approved price survives re-import", await resolvePrice(q, a.id, "50002", "2026-11-12"), { price: 8, source: "agreement" });
check("pending price is refreshed", (await one("select price::float as p from customer_prices where customer_id = $1 and sku = '50002'", [b.id])).p, 12.5);

// --- manual agreement and history
await setAgreedPrice(q, a.id, "50002", 8.4, user.id, "2026-12-01");
check("new price applies from its date", await resolvePrice(q, a.id, "50002", "2026-12-05"), { price: 8.4, source: "agreement" });
check("old price still applies before it", await resolvePrice(q, a.id, "50002", "2026-11-20"), { price: 8, source: "agreement" });
await setAgreedPrice(q, a.id, "50002", 8.5, user.id, "2026-12-01");
check("same start date replaces, no duplicate", [(await resolvePrice(q, a.id, "50002", "2026-12-05")).price, (await one("select count(*)::int as n from customer_prices where customer_id = $1 and sku = '50002'", [a.id])).n], [8.5, 2]);
await setAgreedPrice(q, b.id, "50002", 11, user.id, "2026-11-01");
check("manual price replaces a pending one", (await q("select source from customer_prices where customer_id = $1 and sku = '50002'", [b.id])).map((r) => r.source), ["manual"]);
let threw = false;
try { await setAgreedPrice(q, a.id, "50002", -1, user.id, "2026-12-01"); } catch { threw = true; }
check("negative price refused", threw, true);
const latest = await one("select id::text from customer_prices where customer_id = $1 and sku = '50002' and valid_from = '2026-12-01'", [a.id]);
await removePrice(q, b.id, latest.id);
check("cannot remove another customer's price", (await resolvePrice(q, a.id, "50002", "2026-12-05")).price, 8.5);
await removePrice(q, a.id, latest.id);
check("removing a price falls back to the earlier one", await resolvePrice(q, a.id, "50002", "2026-12-05"), { price: 8, source: "agreement" });

// --- suspicious prices
check("suspicious: lump sum", isSuspiciousPrice(33750, 10), true);
check("suspicious: far above base", isSuspiciousPrice(35, 10), true);
check("suspicious: far below base", isSuspiciousPrice(2, 10), true);
check("normal customer price", isSuspiciousPrice(8, 10), false);
check("no base price to compare", isSuspiciousPrice(14, 0), false);

console.log(failed ? `CUSTOMERS CHECK FAILED (${failed})` : "CUSTOMERS CHECK PASSED");
process.exit(failed ? 1 : 0);
