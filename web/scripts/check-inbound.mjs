// Tests incoming mail: what is kept of a message, recognising the sender's customer, finding catalogue items for
// a line, and a person's approval that turns a recommendation into a quote draft or an order with the system's
// own prices. The mailbox and the AI are not part of this test. All data is made up.
// Run from the web folder:  node scripts/check-inbound.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { storeMail, isKnown, customerOfSender, productCandidates, listInbound, getInbound, inboundCounts, approveInbound, dismissInbound, mailboxState, saveMailboxState, readableByAi, inboundFile, orderableCatalogue } from "../src/lib/inbound-core.ts";

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

const TODAY = "2026-12-01";
await q("insert into products (sku, name, base_price) values ('50002', 'כריך טונה 120 גרם', 10), ('50003', 'כריך ביצים 120 גרם', 9), ('50088', 'מגש פירות', 120), ('50099', 'שירות הובלה', 50), ('50100', 'כריך ישן', 7)");
await q("insert into product_ops (sku, orderable) values ('50002', true), ('50003', true), ('50088', true), ('50099', false), ('50100', true)");
await q("update products set hash_active = false where sku = '50100'");
const user = (await one("insert into users (mobile, full_name, role) values ('0500000051', 'איש מכירות', 'sales') returning id::text")).id;
const cust = (await one("insert into customers (name) values ('לקוח בדיקה') returning id::text")).id;
const other = (await one("insert into customers (name) values ('לקוח אחר') returning id::text")).id;
await q("insert into customer_contacts (customer_id, full_name, email) values ($1, 'דנה', ' Dana@Example.com '), ($1, 'רון', 'shared@example.com'), ($2, 'גיל', 'shared@example.com')", [cust, other]);
await q("insert into customer_prices (customer_id, sku, price, valid_from, approved_at, source) values ($1, '50002', 8.5, '2026-01-01', now(), 'agreement')", [cust]).catch(async () => {
  // The price table's columns differ between versions of the schema; fall back to the minimum.
  await q("insert into customer_prices (customer_id, sku, price, valid_from, approved_at) values ($1, '50002', 8.5, '2026-01-01', now())", [cust]);
});

const mail = (n, over = {}) => ({ mailbox: "box/INBOX", messageId: `<m${n}@example.com>`, fromEmail: "dana@example.com", fromName: "דנה", subject: `הזמנה ${n}`, receivedAt: "2026-12-01T08:00:00Z", body: "שלום, אבקש 40 כריכי טונה ומגש פירות ליום חמישי", attachments: [{ name: "order.pdf", size: 1200 }], ...over });
const item = (text, quantity, sku, certain = true, candidates = []) => ({ text, quantity, unit: null, sku, certain, candidates: candidates.length ? candidates : sku ? [{ sku, name: sku }] : [] });
const order = { kind: "order", summary: "דנה מבקשת כריכים ופירות ליום חמישי.", deliveryDate: "2026-12-03", deliveryNote: "עד 9:00", items: [item("כריכי טונה", 40, "50002"), item("מגש פירות", 1, "50088", false), item("משהו לא ברור", null, null)] };

// ---------- the sender's customer, and catalogue items for a line
check("a sender is recognised by a contact's address, whatever its case", [await customerOfSender(q, "DANA@example.com"), await customerOfSender(q, "nobody@example.com")], [cust, null]);
check("an address that two customers share recognises neither", await customerOfSender(q, "shared@example.com"), null);
check("candidates share words with the line; only items that can be ordered and still exist", (await productCandidates(q, "כריך טונה", null)).map((c) => c.sku), ["50002", "50003"]);
check("an item the customer has a price for comes first among equals", (await productCandidates(q, "כריך 120", cust)).map((c) => c.sku)[0], "50002");
check("a line of numbers and punctuation finds nothing", await productCandidates(q, "12 !!", null), []);

// ---------- keeping a message
const id1 = await storeMail(q, mail(1), order);
check("a message is kept once", [typeof id1, await storeMail(q, mail(1), order), await isKnown(q, "<m1@example.com>")], ["string", null, true]);
const kept = await getInbound(q, id1);
check("a request keeps its body, its attachments' names, its recommendation and the sender's customer", [kept.kind, kept.status, kept.customer, kept.body.includes("כריכי טונה"), kept.attachments, kept.analysis.items.length, kept.lines], ["order", "new", "לקוח בדיקה", true, [{ name: "order.pdf", size: 1200 }], 3, 3]);
const idOther = await storeMail(q, mail(2, { subject: "חשבונית", body: "מצורפת חשבונית מס 123 לתשלום" }), { kind: "other", summary: "חשבונית מספק.", deliveryDate: null, deliveryNote: null, items: [] });
const keptOther = await one("select body, attachments, status, customer_id, analysis from inbound_emails where id = $1", [idOther]);
check("a message that is neither keeps no body, no attachments and no customer, and needs no handling", [keptOther.body, keptOther.attachments, keptOther.status, keptOther.customer_id, keptOther.analysis], [null, [], "dismissed", null, { kind: "other", summary: "חשבונית מספק." }]);
check("the lists show recommendations only", [(await listInbound(q, "new")).map((r) => r.subject), (await listInbound(q, "dismissed")).length, await inboundCounts(q)], [["הזמנה 1"], 0, { waiting: 1, other: 1 }]);

// ---------- approval
const lines = [{ sku: "50002", quantity: 40 }, { sku: "50088", quantity: 1 }];
await refuses("an order needs a delivery date", () => approveInbound(q, id1, { target: "order", customerId: cust, deliveryDate: null, lines }, user, TODAY), "תאריך אספקה");
await refuses("an approval needs lines", () => approveInbound(q, id1, { target: "order", customerId: cust, deliveryDate: "2026-12-03", lines: [] }, user, TODAY), "בלי שורות");
await refuses("an approval needs a customer", () => approveInbound(q, id1, { target: "order", customerId: "", deliveryDate: "2026-12-03", lines }, user, TODAY), "לקוח");
await refuses("a SKU that does not exist is refused", () => approveInbound(q, id1, { target: "order", customerId: cust, deliveryDate: "2026-12-03", lines: [{ sku: "99999", quantity: 1 }] }, user, TODAY), "אינו קיים");
await refuses("an item that cannot be ordered is refused", () => approveInbound(q, id1, { target: "order", customerId: cust, deliveryDate: "2026-12-03", lines: [{ sku: "50099", quantity: 1 }] }, user, TODAY), "אפשר להזמין");
await refuses("a quantity must be above zero", () => approveInbound(q, id1, { target: "order", customerId: cust, deliveryDate: "2026-12-03", lines: [{ sku: "50002", quantity: 0 }] }, user, TODAY), "כמות");
check("a refused approval leaves the recommendation waiting", (await getInbound(q, id1)).status, "new");

const o = await approveInbound(q, id1, { target: "order", customerId: cust, deliveryDate: "2026-12-03", lines }, user, TODAY);
const ord = await one("select source::text as source, customer_id::text as c from orders where id = $1", [o.orderId]);
const ordLines = await q("select dl.sku, dl.quantity::float as qty, dl.unit_price::float as price, d.delivery_date::text as day, d.status::text as status, d.production_notes as notes from delivery_lines dl join deliveries d on d.id = dl.delivery_id where d.order_id = $1 order by dl.sku", [o.orderId]);
check("an approved order records that it came by email", [ord.source, ord.c === cust], ["email", true]);
check("its lines are priced by the customer's agreement, or the base price, never by the mail", ordLines.map((l) => [l.sku, l.qty, l.price, l.day, l.status]), [["50002", 40, 8.5, "2026-12-03", "approved"], ["50088", 1, 120, "2026-12-03", "approved"]]);
check("the order says which message it came from", ordLines[0].notes.startsWith("נוצר ממייל של דנה <dana@example.com> מתאריך 01/12/2026: הזמנה 1"), true);
const done = await getInbound(q, id1);
check("the recommendation is closed and points at the order", [done.status, done.orderId === o.orderId, done.orderNumber === o.number, done.handledBy], ["approved", true, true, "איש מכירות"]);
check("the customer's timeline has the message", (await one("select kind, entity_type, body from activities where customer_id = $1 order by created_at desc limit 1", [cust])).body.startsWith(`התקבלה הזמנה במייל, ונפתחה ממנה הזמנה ${o.number}.`), true);
await refuses("an approved recommendation cannot be approved again", () => approveInbound(q, id1, { target: "order", customerId: cust, deliveryDate: "2026-12-03", lines }, user, TODAY), "כבר טופלה");

const id3 = await storeMail(q, mail(3, { fromEmail: "new@example.com", fromName: null, subject: "בקשה להצעה" }), { ...order, kind: "quote_request" });
check("an unknown sender has no customer until a person chooses one", (await getInbound(q, id3)).customerId, null);
const qt = await approveInbound(q, id3, { target: "quote", customerId: other, deliveryDate: null, lines: [{ sku: "50002", quantity: 12 }] }, user, TODAY);
const version = await one("select v.sent_at, v.total_before_vat::float as total, qt.status::text as status, qt.customer_id::text as c from quote_versions v join quotes qt on qt.id = v.quote_id where v.quote_id = $1 order by v.version desc limit 1", [qt.quoteId]);
check("a quote is opened as a draft that was not sent, for the chosen customer, at the base price", [version.sent_at, version.total, version.status, version.c === other], [null, 120, "draft", true]);
check("the recommendation takes the chosen customer and points at the quote", [(await getInbound(q, id3)).customer, (await getInbound(q, id3)).quoteNumber === qt.number], ["לקוח אחר", true]);

// ---------- dismissal
const id4 = await storeMail(q, mail(4), order);
await dismissInbound(q, id4, "  כפילות   של הזמנה קיימת ", user);
check("a dismissed recommendation keeps the reason", [(await getInbound(q, id4)).status, (await getInbound(q, id4)).dismissReason], ["dismissed", "כפילות של הזמנה קיימת"]);
await refuses("a dismissed recommendation cannot be approved", () => approveInbound(q, id4, { target: "order", customerId: cust, deliveryDate: "2026-12-03", lines }, user, TODAY), "כבר טופלה");
check("the lists after handling", [(await listInbound(q, "new")).length, (await listInbound(q, "approved")).length, (await listInbound(q, "dismissed")).map((r) => r.subject)], [0, 2, ["הזמנה 4"]]);

// ---------- the delivery address of a mail-made document
const addr = await one("insert into customer_addresses (customer_id, street, is_default) values ($1, 'רחוב בדיקה 1', true) returning id::text", [cust]);
const id5 = await storeMail(q, mail(5), order);
const o5 = await approveInbound(q, id5, { target: "order", customerId: cust, deliveryDate: "2026-12-03", lines }, user, TODAY);
const day5 = await one("select d.address_id::text as a from deliveries d where d.order_id = $1", [o5.orderId]);
check("a mail-made order takes the customer's default address", day5.a, addr.id);

// ---------- where the reading stands
check("a mailbox that was never read has no state", await mailboxState(q, "box/INBOX"), null);
await saveMailboxState(q, "box/INBOX", 77, 1200, null);
await saveMailboxState(q, "box/INBOX", 77, 1205, "Error: connection refused");
const st = await mailboxState(q, "box/INBOX");
check("the place in the mailbox and the last failure are kept", [st.uidValidity, st.lastUid, st.lastError, typeof st.checkedAt], [77, 1205, "Error: connection refused", "string"]);

// ---------- attached files, kept with the request
check("the AI reads only PDF and pictures of a sensible size", [readableByAi("application/pdf", 9 * 1024 * 1024), readableByAi("application/pdf", 11 * 1024 * 1024), readableByAi("image/png", 6 * 1024 * 1024), readableByAi("application/vnd.openxmlformats-officedocument.wordprocessingml.document", 1000)], [true, false, false, false]);
const pdfBytes = Buffer.from("%PDF-1.4 הזמנה");
const id6 = await storeMail(q, mail(6, { attachments: [{ name: "order.pdf", size: pdfBytes.length, mime: "application/pdf" }, { name: "list.docx", size: 2, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }], files: [{ name: "order.pdf", mime: "application/pdf", data: pdfBytes }, { name: "list.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: Buffer.from("PK") }] }), { ...order, filesRead: ["order.pdf"], filesNote: null });
const kept6 = await getInbound(q, id6);
check("a kept request keeps its files, and says which ones the AI read", kept6.files.map((f) => [f.name, f.readByAi, f.size]), [["list.docx", false, 2], ["order.pdf", true, pdfBytes.length]]);
const pdfBack = await inboundFile(q, kept6.files.find((f) => f.name === "order.pdf").id);
check("a kept file can be opened again, as it was received", [pdfBack.name, pdfBack.mime, pdfBack.data.toString("utf8")], ["order.pdf", "application/pdf", "%PDF-1.4 הזמנה"]);
check("a file id that is not one gives nothing", [await inboundFile(q, "not-an-id"), await inboundFile(q, "00000000-0000-0000-0000-000000000000")], [null, null]);
const idFiles = await storeMail(q, mail(7, { files: [{ name: "order.pdf", mime: "application/pdf", data: pdfBytes }] }), { ...order, filesRead: [], filesNote: "הקבצים המצורפים לא נקראו." });
check("a file the AI could not read is kept and the note is shown", [(await getInbound(q, idFiles)).files.map((f) => f.readByAi), (await getInbound(q, idFiles)).analysis.filesNote], [[false], "הקבצים המצורפים לא נקראו."]);
const otherWithFile = await storeMail(q, mail(8, { subject: "עדכון", files: [{ name: "logo.png", mime: "image/png", data: Buffer.from([1, 2, 3]) }] }), { kind: "other", summary: "הודעה כללית.", deliveryDate: null, deliveryNote: null, items: [] });
check("a message that is neither keeps no file", (await one("select count(*)::int as n from inbound_files where inbound_id = $1", [otherWithFile])).n, 0);

// ---------- the catalogue the AI proposes from
check("the proposals come only from items that can be ordered and still exist", (await orderableCatalogue(q)).map((c) => c.sku).sort(), ["50002", "50003", "50088"]);

console.log(failed === 0 ? "INBOUND CHECK PASSED" : `INBOUND CHECK FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
