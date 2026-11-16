// Tests cleaning the test environment: refused outside test mode and without the typed confirmation; with both, it
// removes the business records and keeps people, the catalogue, settings, menus and dish weights. All data is made up.
// Run from the web folder:  node scripts/check-testenv.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { cleanTestEnvironment, businessCounts, CONFIRM_WORDS, BUSINESS_TABLES, KEPT_TABLES, TestEnvError } from "../src/lib/test-env-core.ts";

const db = new PGlite();
const dir = path.join(process.cwd(), "..", "db", "migrations");
for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await db.exec(await readFile(path.join(dir, f), "utf8"));
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
// The clean-up runs inside one transaction, as it does in the app; a failure rolls everything back.
const inTransaction = (fn) => db.transaction(async (tx) => fn(async (sql, params = []) => (await tx.query(sql, params)).rows));
const one = async (sql, params) => (await q(sql, params))[0];

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
async function refuses(label, fn, fragment) {
  try { await fn(); failed++; console.log(`FAIL ${label} -> was accepted`); }
  catch (e) { const ok = e instanceof TestEnvError && e.message.includes(fragment); if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> ${e.message}`}`); }
}

// A business record in the tables that are removed, and things that must survive.
const user = await one("insert into users (mobile, full_name, role) values ('0500000061', 'בודק', 'admin') returning id::text");
const cust = await one("insert into customers (name) values ('לקוח לניקוי') returning id::text");
await q("insert into customer_contacts (customer_id, full_name, email) values ($1, 'איש קשר', 'contact@example.com')", [cust.id]);
await q("update users set customer_id = $1 where id = $2", [cust.id, user.id]);
await q("insert into products (sku, name, base_price) values ('70001', 'מוצר לשמירה', 12)");
await q("insert into audit_log (user_id, action, entity_type, entity_id) values ($1, 'create', 'customer', $2)", [user.id, cust.id]);
await q("insert into menus (name) values ('תפריט לשמירה')");
await q("insert into dishes (category, name) values ('main', 'מנה לשמירה')");

delete process.env.AO_TEST_MODE;
await refuses("outside test mode nothing is removed", () => inTransaction((tx) => cleanTestEnvironment(tx, CONFIRM_WORDS)), "במצב טסט");
check("the business records are still there", (await one("select count(*)::int as n from customers")).n, 1);

process.env.AO_TEST_MODE = "1";
await refuses("without the typed words nothing is removed", () => inTransaction((tx) => cleanTestEnvironment(tx, "כן")), CONFIRM_WORDS);
await refuses("almost the words are not enough", () => inTransaction((tx) => cleanTestEnvironment(tx, "נקה סביבת טסט!")), CONFIRM_WORDS);
check("the business records are still there after refusals", (await one("select count(*)::int as n from customers")).n, 1);

check("the counts show what will go", (await businessCounts(q)).some((b) => b.table === "customers" && b.rows === 1), true);
const dishesBefore = (await one("select count(*)::int as n from dishes")).n;
const menusBefore = (await one("select count(*)::int as n from menus")).n;
const result = await inTransaction((tx) => cleanTestEnvironment(tx, `  ${CONFIRM_WORDS} `));
check("the clean-up reports what it removed", result.removed.some((r) => r.table === "customers" && r.rows === 1), true);
check("business records are gone", await businessCounts(q), []);
check("the people stay, and lose their link to the removed customer", [(await one("select count(*)::int as n from users")).n, (await one("select customer_id from users where id = $1", [user.id])).customer_id], [1, null]);
check("the product catalogue stays", (await one("select count(*)::int as n from products")).n, 1);
check("menus and dish weights stay, the ones already there included", [(await one("select count(*)::int as n from menus")).n, (await one("select count(*)::int as n from dishes")).n], [menusBefore, dishesBefore]);
check("the lists of what is removed and kept do not overlap", BUSINESS_TABLES.filter((t) => KEPT_TABLES.includes(t)), []);
check("every table of the database is in one of the two lists", (await q("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name")).map((r) => r.table_name).filter((t) => ![...BUSINESS_TABLES, ...KEPT_TABLES].includes(t)), []);
check("after the clean-up the same records can be added again", (await q("insert into customers (name) values ('חדש') returning id")).length, 1);

console.log(failed === 0 ? "TESTENV CHECK PASSED" : `TESTENV CHECK FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
