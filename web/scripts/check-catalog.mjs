// Tests product management and variants (fillings): adding, switching off, and the rule that a product
// with variants cannot be quoted, ordered or put in a standing order without one.
// Run from the web folder:  node scripts/check-catalog.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { addVariant, setVariantActive, updateProductOps, checkVariants } from "../src/lib/catalog-core.ts";
import { createOrder, updateDelivery } from "../src/lib/orders-core.ts";
import { createQuote, saveDraft } from "../src/lib/quotes-core.ts";
import { saveStanding, generateStanding } from "../src/lib/standing-core.ts";
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
await q("insert into products (sku, name, base_price) values ('50002', 'כריך 120 גרם', 10), ('50042', 'טוסט', 5.62), ('50010', 'חמגשית', 21.74)");
await q("insert into product_ops (sku, orderable, department_id, default_shift) values ('50002', true, 1, 1), ('50042', true, 1, 1)");
const user = await one("insert into users (mobile, full_name, role) values ('0500000008', 'מנהל', 'admin') returning id::text");
const cust = await one("insert into customers (name) values ('לקוח לבדיקה') returning id::text");
const DAY = "2026-12-08"; // a Tuesday

// ---------- product settings
await updateProductOps(q, "50042", { orderable: false, departmentId: 2, defaultShift: 0 }, user.id);
check("product settings are saved", await one("select orderable, department_id, default_shift from product_ops where sku = '50042'"), { orderable: false, department_id: 2, default_shift: 0 });
await updateProductOps(q, "50010", { orderable: true, departmentId: 2, defaultShift: 0 }, user.id);
check("a product without settings gets them", (await one("select department_id from product_ops where sku = '50010'")).department_id, 2);
await updateProductOps(q, "50042", { orderable: true, departmentId: null, defaultShift: 2 }, user.id);
check("a product can become a service line with no department", (await one("select department_id from product_ops where sku = '50042'")).department_id, null);
check("the change log keeps before and after", (await one("select before->>'department_id' as b, after->>'departmentId' as a from audit_log where action = 'update_product_ops' and entity_id = '50042' order by id desc limit 1")), { b: "2", a: null });
await refuses("an unknown shift is refused", () => updateProductOps(q, "50042", { orderable: true, departmentId: 1, defaultShift: 5 }, user.id), "המשמרת");
await refuses("an unknown department is refused", () => updateProductOps(q, "50042", { orderable: true, departmentId: 99, defaultShift: 1 }, user.id), "המחלקה");
await refuses("an unknown product is refused", () => updateProductOps(q, "99999", { orderable: true, departmentId: 1, defaultShift: 1 }, user.id), "המוצר לא נמצא");
await updateProductOps(q, "50042", { orderable: true, departmentId: 1, defaultShift: 1 }, user.id);

// ---------- variants
await refuses("a one-letter variant name is refused", () => addVariant(q, "50002", " א ", user.id), "שם לסוג");
await refuses("a variant for an unknown product is refused", () => addVariant(q, "99999", "טונה", user.id), "המוצר לא נמצא");
const tuna = await addVariant(q, "50002", "  טונה ", user.id);
const egg = await addVariant(q, "50002", "חביתה", user.id);
check("names are trimmed", (await one("select name from product_variants where id = $1", [tuna])).name, "טונה");
check("the same name again does not create a duplicate", [await addVariant(q, "50002", "טונה", user.id), (await one("select count(*)::int as n from product_variants where sku = '50002'")).n], [tuna, 2]);
const toastCheese = await addVariant(q, "50042", "גבינה", user.id);
await setVariantActive(q, "50042", toastCheese, false, user.id);
await refuses("a variant cannot be switched through another product", () => setVariantActive(q, "50002", toastCheese, true, user.id), "הסוג לא נמצא");

// ---------- the rule
await refuses("a product with variants needs one", () => checkVariants(q, [{ sku: "50002" }]), "יש לבחור אחד מהם");
await refuses("the variant must belong to the product", () => checkVariants(q, [{ sku: "50002", variantId: toastCheese }]), "אינו שייך");
await refuses("a variant that was switched off is refused on a new line", () => checkVariants(q, [{ sku: "50042", variantId: toastCheese }]), "אינו פעיל");
await checkVariants(q, [{ sku: "50042", variantId: toastCheese }], new Set([`50042|${toastCheese}`]));
await checkVariants(q, [{ sku: "50042" }, { sku: "50010" }, { sku: "50002", variantId: tuna }]);
check("a product whose variants are all switched off is ordered as one item, and so is a product without variants", true, true);

const L = (sku, quantity, variantId = null) => ({ sku, description: sku, quantity, unitPrice: 8, variantId });
const draft = (lines) => ({ lines, discountPct: 0, deliveryFee: 0, deliveryDate: DAY, windowFrom: null, windowTo: null, addressId: null, customerNotes: null, internalNotes: null, validUntil: null, paymentTerms: null });

await refuses("order: line without a variant is refused", () => createOrder(q, cust.id, user.id, draft([L("50002", 10)])), "שורה 1");
await refuses("order: the message names the right line", () => createOrder(q, cust.id, user.id, draft([L("50042", 5), L("50002", 10)])), "שורה 2");
check("order: nothing was left behind by the refusals", (await one("select count(*)::int as n from deliveries")).n, 0);
const order = await createOrder(q, cust.id, user.id, draft([L("50002", 60, tuna), L("50002", 40, egg), L("50042", 20)]));
check("production plan splits the product by variant", (await planRows(q, DAY, 1)).map((r) => [r.product, r.variant, r.quantity]), [["כריך 120 גרם", "טונה", 60], ["כריך 120 גרם", "חביתה", 40], ["טוסט", null, 20]]);

const quote = await createQuote(q, cust.id, user.id, null);
await refuses("quote: line without a variant is refused", () => saveDraft(q, quote.quoteId, draft([L("50002", 10)]), user.id), "יש לבחור אחד מהם");
await saveDraft(q, quote.quoteId, draft([L("50002", 10, egg)]), user.id);
check("quote: the variant is stored on the line", (await one("select variant_id from quote_lines")).variant_id, egg);

const standing = { customerId: cust.id, addressId: null, windowFrom: null, windowTo: null, validFrom: "2026-12-01", validTo: null, productionNotes: null, shippingNotes: null };
await refuses("standing order: line without a variant is refused", () => saveStanding(q, null, { ...standing, lines: [{ weekday: 3, sku: "50002", quantity: 30 }] }, user.id), "יש לבחור אחד מהם");
await saveStanding(q, null, { ...standing, lines: [{ weekday: 3, sku: "50002", variantId: tuna, quantity: 30 }, { weekday: 3, sku: "50002", variantId: egg, quantity: 15 }] }, user.id);
await generateStanding(q, "2026-12-09", "2026-12-09", user.id);
check("standing order: generated order carries the variants into production", (await planRows(q, "2026-12-09", 1)).map((r) => [r.variant, r.quantity]), [["טונה", 30], ["חביתה", 15]]);

// ---------- switching a variant off after it was ordered
await setVariantActive(q, "50002", egg, false, user.id);
const [del] = await q("select id::text from deliveries where order_id = $1", [order.orderId]);
const base = { deliveryDate: DAY, windowFrom: null, windowTo: null, addressId: null, productionNotes: null, shippingNotes: null };
const changes = await updateDelivery(q, del.id, { ...base, lines: [{ sku: "50002", variantId: tuna, quantity: 60, unitPrice: 8 }, { sku: "50002", variantId: egg, quantity: 45, unitPrice: 8 }, { sku: "50042", quantity: 20, unitPrice: 8 }] }, user.id);
check("an existing line keeps a switched-off variant when the delivery is changed", changes.length, 1);
await refuses("a new order cannot use the switched-off variant", () => createOrder(q, cust.id, user.id, draft([L("50002", 10, egg)])), "אינו פעיל");
await setVariantActive(q, "50002", tuna, false, user.id);
await createOrder(q, cust.id, user.id, draft([L("50002", 7)]));
check("with every variant switched off the product is ordered as one item again", (await planRows(q, DAY, 1)).filter((r) => r.sku === "50002").map((r) => [r.variant, r.quantity]), [["טונה", 60], ["חביתה", 45], [null, 7]]);
check("re-adding a name switches the old variant back on", [await addVariant(q, "50002", "חביתה", user.id), (await one("select active from product_variants where id = $1", [egg])).active], [egg, true]);

console.log(failed ? `CATALOG CHECK FAILED (${failed})` : "CATALOG CHECK PASSED");
process.exit(failed ? 1 : 0);
