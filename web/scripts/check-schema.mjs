// Applies every migration to a throwaway in-memory PostgreSQL and exercises the main constraints.
// Run from the web folder:  node scripts/check-schema.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const dir = path.join(process.cwd(), "..", "db", "migrations");
const db = new PGlite();
for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(await readFile(path.join(dir, f), "utf8"));
  console.log("applied", f);
}
const tables = (await db.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows[0].n;
console.log("tables:", tables);

let failed = 0;
async function expectError(label, sql, params) {
  try {
    await db.query(sql, params);
    console.log("FAIL (accepted):", label);
    failed++;
  } catch {
    console.log("ok (rejected):", label);
  }
}

// A minimal order, end to end.
await db.exec(`
  insert into departments (name) values ('כריכים');
  insert into products (sku, name, base_price) values ('50002', 'כריך 120 גרם', 10);
  insert into product_ops (sku, orderable, department_id, default_shift) values ('50002', true, 1, 1);
  insert into product_variants (sku, name) values ('50002', 'טונה'), ('50002', 'חביתה');
`);
const cust = (await db.query("insert into customers (name) values ('לקוח בדיקה') returning id")).rows[0].id;
const user = (await db.query("insert into users (mobile, full_name, role) values ('0500000000', 'בודק', 'admin') returning id")).rows[0].id;
const order = (await db.query("insert into orders (customer_id, source, vat_rate, owner_id) values ($1, 'manual', 0.18, $2) returning id, number", [cust, user])).rows[0];
const delivery = (await db.query("insert into deliveries (order_id, delivery_date, status) values ($1, '2026-11-12', 'approved') returning id", [order.id])).rows[0].id;
await db.query("insert into delivery_lines (delivery_id, sku, variant_id, quantity, unit_price) values ($1, '50002', 1, 60, 8), ($1, '50002', 2, 40, 8)", [delivery]);
const agg = (await db.query(`
  select l.sku, v.name as variant, sum(l.quantity)::int as qty
  from delivery_lines l join deliveries d on d.id = l.delivery_id left join product_variants v on v.id = l.variant_id
  where d.delivery_date = '2026-11-12' group by l.sku, v.name order by v.name`)).rows;
console.log("order number:", order.number, "| production aggregate:", JSON.stringify(agg));

await db.query("insert into delivery_notes (delivery_id, idempotency_key) values ($1, $2)", [delivery, "ship-" + delivery]);
await expectError("second delivery note for the same shipped action", "insert into delivery_notes (delivery_id, idempotency_key) values ($1, $2)", [delivery, "ship-" + delivery]);
await expectError("duplicate mobile number", "insert into users (mobile, full_name, role) values ('0500000000', 'כפול', 'sales')");
await expectError("zero quantity line", "insert into delivery_lines (delivery_id, sku, quantity, unit_price) values ($1, '50002', 0, 8)", [delivery]);
await expectError("line with unknown sku", "insert into delivery_lines (delivery_id, sku, quantity, unit_price) values ($1, 'nope', 1, 8)", [delivery]);

const so = (await db.query("insert into standing_orders (customer_id, valid_from) values ($1, '2026-11-01') returning id", [cust])).rows[0].id;
await db.query("insert into standing_order_days (standing_order_id, day, generated_order_id) values ($1, '2026-11-12', $2)", [so, order.id]);
await expectError("generating the same standing-order day twice", "insert into standing_order_days (standing_order_id, day) values ($1, '2026-11-12')", [so]);

console.log(failed ? `SCHEMA CHECK FAILED (${failed})` : "SCHEMA CHECK PASSED");
process.exit(failed ? 1 : 0);
