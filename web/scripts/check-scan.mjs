// Tests scanning delivery labels: the code itself, what a scan means while loading and after leaving,
// refused scans and their history, and the labels of a route.
// Run from the web folder:  node scripts/check-scan.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { saveDriver, saveRoute, setAddressRoute, planDay, dayRoutes } from "../src/lib/shipping-core.ts";
import { depart, parseScanCode, formatScanCode, scanPayload, scanDelivery, routeLabels, setBoxCount, boxName, missingFromRoute, processDeliveryAction, RefusedError, recordRefusal } from "../src/lib/loading-core.ts";
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
const order = async (name) => one("select id::text from deliveries where order_id = $1", [(await createOrder(q, customers[name], manager.id, draft(addresses[name]))).orderId]);
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
const codes = async (name) => (await q("select scan_code from delivery_boxes where delivery_id = $1 order by seq", [d[name].id])).map((r) => r.scan_code);
const boxes = async (name) => (await q("select loaded_at is not null as l, unloaded_at is not null as u from delivery_boxes where delivery_id = $1 order by seq", [d[name].id])).map((r) => (r.u ? "delivered" : r.l ? "loaded" : "-"));
const act = (name, action) => processDeliveryAction(q, { deliveryId: d[name].id, dailyRouteId: A, action, userId: manager.id, source: "manual" });

// ---------- every delivery has a box, every box its own code
check("a new delivery gets one box by itself, with a code of ten characters", [(await codes("גן הדר")).length, /^[0-9A-F]{10}$/.test((await codes("גן הדר"))[0])], [1, true]);
await setBoxCount(q, d["גן הדר"].id, 3, manager.id);
const hadar = await codes("גן הדר");
const noam = await codes("בית ספר נועם");
const reut = await codes("בית ספר רעות");
check("three boxes have three different codes, and no two boxes anywhere share one", [hadar.length, new Set([...hadar, ...noam, ...reut]).size], [3, 5]);
await refuses("the database itself refuses two boxes with one code", () => q("update delivery_boxes set scan_code = $1 where delivery_id = $2", [hadar[0], d["בית ספר נועם"].id]), "unique");
check("the change of the number of boxes is kept in the history", await one("select before, after from audit_log where action = 'box_count' and entity_id = $1", [d["גן הדר"].id]), { before: { boxes: 1 }, after: { boxes: 3 } });
await setBoxCount(q, d["גן הדר"].id, 3, manager.id);
check("saving the same number again writes nothing", (await one("select count(*)::int as n from audit_log where action = 'box_count'")).n, 1);
await refuses("zero boxes is refused", () => setBoxCount(q, d["גן הדר"].id, 0, manager.id), "בין 1 ל-99");
await refuses("a hundred boxes is refused", () => setBoxCount(q, d["גן הדר"].id, 100, manager.id), "בין 1 ל-99");
await refuses("half a box is refused", () => setBoxCount(q, d["גן הדר"].id, 1.5, manager.id), "בין 1 ל-99");

// ---------- labels
const labels = await routeLabels(q, A);
check("a route's labels: one per box, last stop first, numbered within the delivery, each with its own code", labels.map((l) => [l.stop, l.customer, l.seq, l.boxes, l.kind, l.units]), [[2, "בית ספר נועם", 1, 1, "general", 10], [1, "גן הדר", 1, 3, "general", 10], [1, "גן הדר", 2, 3, "general", 10], [1, "גן הדר", 3, 3, "general", 10]]);
check("the codes on the labels are the boxes' codes", [labels.slice(1).map((l) => l.code), labels[0].address], [hadar, "רחוב בית ספר נועם"]);
check("how a box is named", [boxName({ seq: 2, kind: "general" }, 3), boxName({ seq: 1, kind: "hot" }, 2), boxName({ seq: 2, kind: "cold" }, 2)], ["ארגז 2 מתוך 3", "ארגז חם · 1 מתוך 2", "ארגז נלווים (קר) · 2 מתוך 2"]);

// ---------- scanning while loading: box by box
const first = await scan(scanPayload(hadar[0]));
check("the first of three boxes is taken, and the delivery is not loaded yet", [first.changed, first.complete, first.done, first.boxes, first.message, first.customer, first.stop, await state("גן הדר"), await boxes("גן הדר")], [true, false, 1, 3, "ארגז 1 מתוך 3 הועמס. חסרים עוד 2.", "גן הדר", 1, ["approved", false], ["loaded", "-", "-"]]);
check("the history has the box, not the delivery", [await events("box_loaded"), await events("loaded")], [1, 0]);
const again = await scan(formatScanCode(hadar[0]).toLowerCase());
check("the same box scanned again changes nothing and says what is still missing", [again.changed, again.message, await events("box_loaded")], [false, "ארגז 1 מתוך 3 כבר נסרק. חסרים עוד 2.", 1]);
check("a delivery with a box missing is missing from the route, with its count", (await missingFromRoute(q, A)).map((m) => [m.customer, m.loadedBoxes, m.boxes]), [["גן הדר", 1, 3], ["בית ספר נועם", 0, 1]]);
await scan(noam[0]);
check("a delivery of one box is loaded by its one scan", [await state("בית ספר נועם"), await events("loaded")], [["approved", true], 1]);
await refuses("the route cannot leave while one box of a delivery is not on the vehicle", () => depart(q, A, manager.id), "חסרות 1 אספקות");
await scan(hadar[2]);
const last = await scan(hadar[1]);
check("the last box completes the delivery, whatever the order of scanning", [last.complete, last.message, await state("גן הדר"), await boxes("גן הדר"), await events("loaded")], [true, "ארגז 2 מתוך 3 הועמס. כל הארגזים של האספקה על הרכב.", ["approved", true], ["loaded", "loaded", "loaded"], 2]);
check("nothing is missing now", await missingFromRoute(q, A), []);

// ---------- refused scans
const wrong = await refuses("a box of another route is refused, naming its route", () => scan(reut[0]), "שייכת לקו ירושלים 2");
await recordRefusal(q, wrong, manager.id, "qr_scan");
check("and the attempt is kept in the history as a scan; the box stays unmarked", [wrong instanceof RefusedError, await events("wrong_route_attempt"), await boxes("בית ספר רעות")], [true, 1, ["-"]]);
const unknown = await refuses("a QR that is not one of our labels is refused", () => scan("https://example.com/menu"), "אינו מדבקת ארגז");
const unknown2 = await refuses("a well-formed code that no box has is refused the same way", () => scan("0000000000"), "אינו מדבקת ארגז");
await recordRefusal(q, unknown, manager.id, "qr_scan");
check("an unknown scan is recorded without its content", [unknown.refusal.type, unknown2.refusal.type, await one("select delivery_id, metadata from shipping_events where event_type = 'unknown_code'")], ["unknown_code", "unknown_code", { delivery_id: null, metadata: { length: 24 } }]);

// ---------- undoing, tapping, and changing the number of boxes
await act("גן הדר", "reverse_load");
check("undoing the loading of a delivery clears all its boxes", [await state("גן הדר"), await boxes("גן הדר")], [["approved", false], ["-", "-", "-"]]);
await scan(hadar[0]);
await act("גן הדר", "reverse_load");
check("a partly scanned delivery can be cleared too", await boxes("גן הדר"), ["-", "-", "-"]);
await refuses("someone who may not load cannot load by scanning", () => scan(hadar[0], { load: false, unload: true }), "אין לך הרשאה להעמיס");
check("nothing was loaded by the refused scan", await boxes("גן הדר"), ["-", "-", "-"]);
await act("גן הדר", "load");
check("a tap on the delivery marks all its boxes", [await state("גן הדר"), await boxes("גן הדר")], [["approved", true], ["loaded", "loaded", "loaded"]]);
await refuses("a box that is on the vehicle cannot be made to disappear", () => setBoxCount(q, d["גן הדר"].id, 2, manager.id), "כבר הועמס");
await setBoxCount(q, d["גן הדר"].id, 4, manager.id);
check("a box added to a loaded delivery makes it incomplete again", [await state("גן הדר"), await boxes("גן הדר")], [["approved", false], ["loaded", "loaded", "loaded", "-"]]);
await setBoxCount(q, d["גן הדר"].id, 3, manager.id);
check("taking the unloaded box off again makes the delivery complete, with the same codes as before", [await state("גן הדר"), await codes("גן הדר")], [["approved", true], hadar]);

// ---------- after the route left: handing over box by box
await depart(q, A, manager.id);
await refuses("the number of boxes cannot change after the delivery left", () => setBoxCount(q, d["גן הדר"].id, 5, manager.id), "כבר יצאה");
await refuses("someone who may not hand over cannot hand over by scanning", () => scan(hadar[0], { load: true, unload: false }), "אין לך הרשאה לסמן מסירה");
const handed = await scan(hadar[0]);
check("the first box handed over does not deliver the delivery", [handed.complete, handed.message, await state("גן הדר"), await boxes("גן הדר"), await events("box_unloaded"), await events("unloaded")], [false, "ארגז 1 מתוך 3 נמסר. חסרים עוד 2.", ["shipped", true], ["delivered", "loaded", "loaded"], 1, 0]);
check("the same box again changes nothing", [(await scan(hadar[0])).changed, await events("box_unloaded")], [false, 1]);
await scan(hadar[1]);
const done = await scan(hadar[2]);
check("the last box delivers the delivery", [done.complete, done.message, await state("גן הדר"), await events("unloaded")], [true, "ארגז 3 מתוך 3 נמסר. כל הארגזים של האספקה נמסרו.", ["delivered", true], 1]);
await act("גן הדר", "reverse_unload");
check("undoing a hand-over puts all the boxes back on the vehicle", [await state("גן הדר"), await boxes("גן הדר")], [["shipped", true], ["loaded", "loaded", "loaded"]]);
await act("גן הדר", "unload");
const single = await scan(noam[0]);
check("a delivery of one box keeps its short answer, and the last scan completes the route", [single.message, single.complete, (await one("select delivery_completed_at is not null as t from daily_routes where id = $1", [A])).t], ["נמסרה", true, true]);

// ---------- a delivery left behind takes its boxes off the vehicle
const B = (await dayRoutes(q, DAY)).find((r) => r.name === "ירושלים 2").id;
const extra = await order("בית ספר רעות");
await planDay(q, DAY, manager.id);
await q("update daily_routes set driver_id = $2 where id = $1", [B, driver]);
await setBoxCount(q, extra.id, 2, manager.id);
const extraCodes = (await q("select scan_code from delivery_boxes where delivery_id = $1 order by seq", [extra.id])).map((r) => r.scan_code);
const scanB = (code) => scanDelivery(q, { code, dailyRouteId: B, userId: manager.id, access: all });
await scanB(reut[0]);
await scanB(extraCodes[0]);
check("leaving with one box of two missing needs the manager's reason, and the delivery stays behind as a whole", [await depart(q, B, manager.id, { allowMissing: true, reason: "ארגז אחד לא נמצא" }), (await q("select loaded_at is not null as l from delivery_boxes where delivery_id = $1 order by seq", [extra.id])).map((r) => r.l), (await one("select daily_route_id from deliveries where id = $1", [extra.id])).daily_route_id], [{ shipped: 1, leftBehind: 1 }, [false, false], null]);
check("the history of the delivery left behind says how many of its boxes had been loaded", await one("select metadata->'boxes' as boxes, metadata->'loadedBoxes' as loaded from shipping_events where event_type = 'left_behind' and delivery_id = $1", [extra.id]), { boxes: 2, loaded: 1 });

console.log(failed ? `SCAN CHECK FAILED (${failed})` : "SCAN CHECK PASSED");
process.exit(failed ? 1 : 0);
