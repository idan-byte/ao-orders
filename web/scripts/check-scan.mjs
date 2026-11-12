// Tests scanning delivery labels: the code itself, what a scan means while loading and after leaving,
// refused scans and their history, and the labels of a route.
// Run from the web folder:  node scripts/check-scan.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { saveDriver, saveRoute, setAddressRoute, planDay, dayRoutes } from "../src/lib/shipping-core.ts";
import { depart, parseScanCode, formatScanCode, scanPayload, scanDelivery, routeLabels, RefusedError, recordRefusal } from "../src/lib/loading-core.ts";
import { createOrder } from "../src/lib/orders-core.ts";

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

// ---------- the code
check("a code is read with or without the prefix, in any case, with separators", [parseScanCode("AOD:3F9A1C07B2"), parseScanCode("3f9a1-c07b2"), parseScanCode(" 3F9A1 C07B2 "), parseScanCode("aod:3f9a1c07b2")], ["3F9A1C07B2", "3F9A1C07B2", "3F9A1C07B2", "3F9A1C07B2"]);
check("anything else is not a code", [parseScanCode(""), parseScanCode("3F9A1C07B"), parseScanCode("3F9A1C07B2X"), parseScanCode("https://example.com/x"), parseScanCode("ZZZZZZZZZZ"), parseScanCode(null)], [null, null, null, null, null, null]);
check("how a code is printed and what the QR carries", [formatScanCode("3F9A1C07B2"), scanPayload("3F9A1C07B2")], ["3F9A1-C07B2", "AOD:3F9A1C07B2"]);
// The QR that is printed is read back by the reader the phone uses when the browser has none of its own.
const qr = QRCode.create(scanPayload("3F9A1C07B2"), { errorCorrectionLevel: "M" });
const [size, cell, margin] = [qr.modules.size, 6, 4];
const side = (size + margin * 2) * cell;
const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (qr.modules.get(y, x)) for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) pixels.fill(0, (((y + margin) * cell + dy) * side + (x + margin) * cell + dx) * 4, (((y + margin) * cell + dy) * side + (x + margin) * cell + dx) * 4 + 3);
check("the printed QR is read back as the same code", parseScanCode(jsQR(pixels, side, side)?.data ?? ""), "3F9A1C07B2");

// ---------- a day with two routes
await q("insert into products (sku, name, base_price) values ('50088', 'קוקטיל', 5)");
await q("insert into product_ops (sku, orderable) values ('50088', true)");
const mk = async (mobile, name, role) => ({ id: (await one("insert into users (mobile, full_name, role) values ($1, $2, $3) returning id::text", [mobile, name, role])).id, mobile, role });
const manager = await mk("0500000020", "מנהל שילוח", "shipping_manager");
const DAY = "2026-12-08";
const customers = {};
const addresses = {};
for (const name of ["גן הדר", "בית ספר נועם", "בית ספר רעות"]) {
  customers[name] = (await one("insert into customers (name) values ($1) returning id::text", [name])).id;
  addresses[name] = (await one("insert into customer_addresses (customer_id, street) values ($1, $2) returning id::text", [customers[name], "רחוב " + name])).id;
}
const draft = (address) => ({ lines: [{ sku: "50088", description: "x", quantity: 10, unitPrice: 5, variantId: null }], discountPct: 0, deliveryFee: 0, deliveryDate: DAY, windowFrom: null, windowTo: null, addressId: address, customerNotes: null, internalNotes: null, validUntil: null, paymentTerms: null });
const order = async (name) => one("select id::text, scan_code from deliveries where order_id = $1", [(await createOrder(q, customers[name], manager.id, draft(addresses[name]))).orderId]);
const driver = await saveDriver(q, null, { name: "משה כהן", phone: "050-1234567", vehicleRegistration: "12-345-67", vehicleDescription: null }, manager.id);
const r1 = await saveRoute(q, null, { name: "ירושלים 1", description: null, defaultDriverId: driver }, manager.id);
const r2 = await saveRoute(q, null, { name: "ירושלים 2", description: null, defaultDriverId: null }, manager.id);
await setAddressRoute(q, addresses["גן הדר"], r1, manager.id);
await setAddressRoute(q, addresses["בית ספר נועם"], r1, manager.id);
await setAddressRoute(q, addresses["בית ספר רעות"], r2, manager.id);
const d = {};
for (const name of ["גן הדר", "בית ספר נועם", "בית ספר רעות"]) d[name] = await order(name);
await planDay(q, DAY, manager.id);
const A = (await dayRoutes(q, DAY)).find((r) => r.name === "ירושלים 1").id;
const all = { load: true, unload: true };
const scan = (code, access = all) => scanDelivery(q, { code, dailyRouteId: A, userId: manager.id, access });
const state = async (name) => { const r = await one("select status::text, loaded_at is not null as loaded from deliveries where id = $1", [d[name].id]); return [r.status, r.loaded]; };
const events = async (type, source = "qr_scan") => (await one("select count(*)::int as n from shipping_events where event_type = $1 and source = $2", [type, source])).n;

check("every delivery gets its own code of ten characters", [Object.values(d).every((x) => /^[0-9A-F]{10}$/.test(x.scan_code)), new Set(Object.values(d).map((x) => x.scan_code)).size], [true, 3]);
await refuses("two deliveries cannot share a code", () => q("update deliveries set scan_code = $1 where id = $2", [d["גן הדר"].scan_code, d["בית ספר נועם"].id]), "unique");

// ---------- labels
const labels = await routeLabels(q, A);
check("a route's labels: one per delivery, last stop first, with what the loader needs to see", labels.map((l) => [l.stop, l.customer, l.units, l.code === d[l.customer].scan_code, l.address]), [[2, "בית ספר נועם", 10, true, "רחוב בית ספר נועם"], [1, "גן הדר", 10, true, "רחוב גן הדר"]]);

// ---------- scanning while loading
const first = await scan(scanPayload(d["גן הדר"].scan_code));
check("a scan while loading marks the delivery as loaded and says whose it is", [first.changed, first.message, first.customer, first.stop, first.orderNumber > 0, await state("גן הדר")], [true, "הועמסה", "גן הדר", 1, true, ["approved", true]]);
check("the history says it was a scan", [await events("loaded"), await events("loaded", "manual")], [1, 0]);
check("the same label scanned again changes nothing", [(await scan(formatScanCode(d["גן הדר"].scan_code).toLowerCase())).changed, await events("loaded")], [false, 1]);
const wrong = await refuses("a label of another route is refused, naming its route", () => scan(d["בית ספר רעות"].scan_code), "שייכת לקו ירושלים 2");
await recordRefusal(q, wrong, manager.id, "qr_scan");
check("and the attempt is kept in the history as a scan", [wrong instanceof RefusedError, await events("wrong_route_attempt"), await state("בית ספר רעות")], [true, 1, ["approved", false]]);
const unknown = await refuses("a QR that is not one of our labels is refused", () => scan("https://example.com/menu"), "אינו מדבקת אספקה");
const unknown2 = await refuses("a well-formed code that no delivery has is refused the same way", () => scan("0000000000"), "אינו מדבקת אספקה");
await recordRefusal(q, unknown, manager.id, "qr_scan");
check("an unknown scan is recorded without its content", [unknown.refusal.type, unknown2.refusal.type, await one("select delivery_id, metadata from shipping_events where event_type = 'unknown_code'")], ["unknown_code", "unknown_code", { delivery_id: null, metadata: { length: 24 } }]);
await refuses("someone who may not load cannot load by scanning", () => scan(d["בית ספר נועם"].scan_code, { load: false, unload: true }), "אין לך הרשאה להעמיס");
check("nothing was loaded by the refused scan", await state("בית ספר נועם"), ["approved", false]);

// ---------- scanning after the route left
await scan(d["בית ספר נועם"].scan_code);
await depart(q, A, manager.id);
await refuses("someone who may not hand over cannot hand over by scanning", () => scan(d["גן הדר"].scan_code, { load: true, unload: false }), "אין לך הרשאה לסמן מסירה");
const handed = await scan(d["גן הדר"].scan_code);
check("after the route left, the same label marks the hand-over", [handed.changed, handed.message, await state("גן הדר"), await events("unloaded")], [true, "נמסרה", ["delivered", true], 1]);
check("a second scan at the customer changes nothing", [(await scan(d["גן הדר"].scan_code)).changed, await events("unloaded")], [false, 1]);
await scan(d["בית ספר נועם"].scan_code);
check("the last scan completes the route", (await one("select delivery_completed_at is not null as t from daily_routes where id = $1", [A])).t, true);

console.log(failed ? `SCAN CHECK FAILED (${failed})` : "SCAN CHECK PASSED");
process.exit(failed ? 1 : 0);
