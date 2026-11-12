// Tests leads, derived stages, tasks and the activity log on a throwaway in-memory PostgreSQL.
// Run from the web folder:  node scripts/check-crm.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createLead, getLeadStage, setFollowUp, closeLead, convertLeadToCustomer, addActivity, addTask, completeTask, logQuoteEvent } from "../src/lib/crm-core.ts";
import { createQuote, saveDraft, sendQuote, approveQuote, rejectQuote } from "../src/lib/quotes-core.ts";

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

await q("insert into products (sku, name, base_price) values ('50002', 'כריך 120 גרם', 10)");
const user = await one("insert into users (mobile, full_name, role) values ('0500000003', 'מוכרת', 'sales') returning id::text");
const cust = await one("insert into customers (name) values ('לקוח קיים') returning id::text");
const draft = { lines: [{ sku: "50002", description: "כריך", quantity: 10, unitPrice: 8 }], discountPct: 0, deliveryFee: 0, deliveryDate: "2026-12-01", windowFrom: null, windowTo: null, addressId: null, customerNotes: null, internalNotes: null, validUntil: "2026-12-31", paymentTerms: null };

// ---------- creating leads
await refuses("lead needs a summary", () => createLead(q, { customerId: cust.id, source: "טלפון", summary: " ", ownerId: user.id }), "לתאר");
await refuses("lead needs a known source", () => createLead(q, { customerId: cust.id, source: "יונת דואר", summary: "x", ownerId: user.id }), "מקור");
await refuses("lead needs a customer or a name", () => createLead(q, { source: "טלפון", summary: "מבקשים הצעה", ownerId: user.id }), "שם הפונה");
await refuses("lead for unknown customer", () => createLead(q, { customerId: "00000000-0000-0000-0000-000000000000", source: "טלפון", summary: "x", ownerId: user.id }), "לא נמצא");

const leadA = await createLead(q, { customerId: cust.id, source: "טלפון", summary: "כיבוד לכנס, 120 איש", ownerId: user.id, followUpDate: "2026-11-15" });
check("new lead starts as new", await getLeadStage(q, leadA), "new");
check("follow-up date creates a task", (await one("select title, due_date::text as d from tasks where lead_id = $1", [leadA])), { title: "לחזור לפונה", d: "2026-11-15" });
check("opening is logged on the customer timeline", (await one("select count(*)::int as n from activities where customer_id = $1 and kind = 'system'", [cust.id])).n, 1);

// ---------- the stage follows the quote
const quote = await createQuote(q, cust.id, user.id, leadA);
check("quote opened -> quote in progress", await getLeadStage(q, leadA), "quote_in_progress");
await saveDraft(q, quote.quoteId, draft);
await sendQuote(q, quote.quoteId);
check("quote sent -> sent", await getLeadStage(q, leadA), "sent");
await setFollowUp(q, leadA, true);
check("marked for follow-up", await getLeadStage(q, leadA), "follow_up");
await setFollowUp(q, leadA, false);
check("follow-up cleared -> back to sent", await getLeadStage(q, leadA), "sent");
await saveDraft(q, quote.quoteId, { ...draft, lines: [{ ...draft.lines[0], quantity: 20 }] });
check("quote reopened for a new version -> in progress again", await getLeadStage(q, leadA), "quote_in_progress");
const sent2 = await sendQuote(q, quote.quoteId);
await approveQuote(q, quote.quoteId, sent2.versionId, { method: "manual", name: "דנה", userId: user.id }, "2026-11-12");
check("quote approved -> won", await getLeadStage(q, leadA), "won");
const board = await one("select quote_number, quote_total::float as total, display_name from lead_board where id = $1", [leadA]);
check("board shows the quote and its total", [board.quote_number === quote.number, board.total, board.display_name], [true, 188.8, "לקוח קיים"]);
await refuses("won lead cannot be closed as lost", () => closeLead(q, leadA, "מחיר", user.id), "אושרה");
await refuses("won lead cannot be moved to follow-up", () => setFollowUp(q, leadA, true), "נסגרה");

const leadB = await createLead(q, { customerId: cust.id, source: "מייל", summary: "מגשי אירוח", ownerId: user.id });
const quoteB = await createQuote(q, cust.id, user.id, leadB);
await saveDraft(q, quoteB.quoteId, draft);
await sendQuote(q, quoteB.quoteId);
await rejectQuote(q, quoteB.quoteId, "מחיר");
check("quote rejected -> lost, with the quote's reason", await one("select stage, lost_reason from lead_board where id = $1", [leadB]), { stage: "lost", lost_reason: "מחיר" });

// ---------- a lead from someone who is not a customer yet
const leadC = await createLead(q, { contactName: "גן ילדים חדש", contactPhone: "050-0000009", source: "וואטסאפ", summary: "חמגשיות ל-35 ילדים", ownerId: user.id, followUpDate: "2026-11-13" });
check("board shows the contact name", (await one("select display_name, customer_id from lead_board where id = $1", [leadC])), { display_name: "גן ילדים חדש", customer_id: null });
await addActivity(q, { leadId: leadC, kind: "call", body: "שוחחנו, מבקשים הצעה עד יום ה׳", userId: user.id });
const newCust = await convertLeadToCustomer(q, leadC, user.id);
const again = await convertLeadToCustomer(q, leadC, user.id);
check("converting twice gives the same customer", [newCust === again, (await one("select count(*)::int as n from customers where name = 'גן ילדים חדש'")).n], [true, 1]);
check("contact is carried over", (await one("select full_name, phone from customer_contacts where customer_id = $1", [newCust])), { full_name: "גן ילדים חדש", phone: "050-0000009" });
check("earlier activities and tasks move to the customer", [(await one("select count(*)::int as n from activities where customer_id = $1", [newCust])).n, (await one("select count(*)::int as n from tasks where customer_id = $1", [newCust])).n], [3, 1]);
check("new customer is not linked to Hashavshevet yet", (await one("select hash_account_key from customers where id = $1", [newCust])).hash_account_key, null);

// ---------- closing
await refuses("closing needs a reason", () => closeLead(q, leadC, " ", user.id), "סיבה");
await closeLead(q, leadC, "לא רלוונטי", user.id);
check("closed lead: stage, reason, open tasks done", [await one("select stage, lost_reason from lead_board where id = $1", [leadC]), (await one("select count(*)::int as n from tasks where lead_id = $1 and done_at is null", [leadC])).n], [{ stage: "lost", lost_reason: "לא רלוונטי" }, 0]);
await refuses("closed lead cannot be moved to follow-up", () => setFollowUp(q, leadC, true), "נסגרה");

// ---------- tasks and activities
await refuses("task needs a title", () => addTask(q, { leadId: leadA, title: "", dueDate: "2026-11-20", ownerId: user.id, createdBy: user.id }), "מה צריך");
await refuses("task needs a date", () => addTask(q, { leadId: leadA, title: "לשלוח תפריט", dueDate: "מחר", ownerId: user.id, createdBy: user.id }), "תאריך");
await refuses("task needs a customer or a lead", () => addTask(q, { title: "x", dueDate: "2026-11-20", ownerId: user.id, createdBy: user.id }), "משויכת");
const task = await addTask(q, { customerId: cust.id, title: "לשלוח תפריט חורף", dueDate: "2026-11-20", ownerId: user.id, createdBy: user.id });
check("completing a task", [await completeTask(q, task), await completeTask(q, task)], [true, false]);
await refuses("activity needs text", () => addActivity(q, { customerId: cust.id, kind: "call", body: "", userId: user.id }), "מה היה");
await refuses("activity needs a known kind", () => addActivity(q, { customerId: cust.id, kind: "fax", body: "x", userId: user.id }), "אינו מוכר");
await refuses("activity needs a customer or a lead", () => addActivity(q, { kind: "note", body: "x", userId: user.id }), "משויכת");

await logQuoteEvent(q, quote.quoteId, `הצעה ${quote.number} אושרה`, user.id);
const ev = await one("select customer_id::text as c, lead_id::text as l, entity_type, entity_id from activities where body like 'הצעה % אושרה'");
check("quote events land on the customer and on the lead", ev, { c: cust.id, l: leadA, entity_type: "quote", entity_id: quote.quoteId });
check("garbage quote id is ignored", await logQuoteEvent(q, "00000000-0000-0000-0000-000000000000", "x", user.id), undefined);

console.log(failed ? `CRM CHECK FAILED (${failed})` : "CRM CHECK PASSED");
process.exit(failed ? 1 : 0);
