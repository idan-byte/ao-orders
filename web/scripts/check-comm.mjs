// Tests communication management: incoming sources (email addresses and WhatsApp numbers), the incoming
// source on an inquiry, and the sender of documents.
// Run from the web folder:  node scripts/check-comm.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizePhone, formatPhone, addChannel, listChannels, setChannelActive, removeChannel, activeChannels, getOutgoing, setOutgoing, mailSender } from "../src/lib/comm-core.ts";
import { createLead } from "../src/lib/crm-core.ts";

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
const user = (await one("insert into users (mobile, full_name, role) values ('0500000050', 'מנהל', 'admin') returning id::text")).id;

// ---------- phone numbers
check("a mobile with separators", normalizePhone("052-123 4567"), "0521234567");
check("international form", normalizePhone("+972 52-1234567"), "0521234567");
check("a landline", normalizePhone("02-6251234"), "026251234");
check("too short", normalizePhone("052-1234"), null);
check("letters", normalizePhone("052-12345ab"), null);
check("shown with a dash", [formatPhone("0521234567"), formatPhone("026251234")], ["052-1234567", "02-6251234"]);

// ---------- incoming sources
check("nothing is defined at first", [await listChannels(q), await activeChannels(q)], [[], []]);
const mail = await addChannel(q, { kind: "email", address: "  Orders@Example.co.il ", label: "מגשי אירוח" }, user);
const wa = await addChannel(q, { kind: "whatsapp", address: "052-1234567", label: "" }, user);
await addChannel(q, { kind: "whatsapp", address: "0521234567 ".trim().replace("7", "8"), label: "אוכל חם" }, user);
check("sources are kept normalised, email first", (await listChannels(q)).map((c) => [c.kind, c.address, c.label, c.active, c.leads]), [["email", "orders@example.co.il", "מגשי אירוח", true, 0], ["whatsapp", "0521234567", null, true, 0], ["whatsapp", "0521234568", "אוכל חם", true, 0]]);
await refuses("the same address twice", () => addChannel(q, { kind: "email", address: "ORDERS@example.co.il", label: null }, user), "כבר ברשימה");
await refuses("the same number in another form", () => addChannel(q, { kind: "whatsapp", address: "+972521234567", label: null }, user), "כבר ברשימה");
await refuses("a bad email", () => addChannel(q, { kind: "email", address: "orders@", label: null }, user), "אינה תקינה");
await refuses("a bad number", () => addChannel(q, { kind: "whatsapp", address: "12345", label: null }, user), "אינו תקין");
await refuses("an email as a WhatsApp number", () => addChannel(q, { kind: "whatsapp", address: "a@example.co.il", label: null }, user), "אינו תקין");
await refuses("an unknown kind", () => addChannel(q, { kind: "sms", address: "0521234567", label: null }, user), "מייל או וואטסאפ");
check("what is offered when an inquiry is opened", (await activeChannels(q)).map((c) => c.text), ["מייל · orders@example.co.il · מגשי אירוח", "וואטסאפ · 052-1234567", "וואטסאפ · 052-1234568 · אוכל חם"]);

// ---------- the source on an inquiry
const lead = (source, channelId) => createLead(q, { contactName: "פונה", source, summary: "מגשים לאירוע", ownerId: user, channelId });
const l1 = await lead("מייל", mail);
check("an inquiry remembers where it arrived", (await one("select channel_id from leads where id = $1", [l1])).channel_id, mail);
check("an inquiry without a source is still fine", (await one("select channel_id from leads where id = $1", [await lead("טלפון", null)])).channel_id, null);
await refuses("an unknown source is refused", () => lead("מייל", 9999), "אינו פעיל");
await refuses("a source with inquiries cannot be deleted", () => removeChannel(q, mail, user), "1 פניות רשומות");
await setChannelActive(q, mail, false, user);
check("a source that is switched off is no longer offered, and keeps its inquiries", [(await activeChannels(q)).length, (await listChannels(q)).find((c) => c.id === mail).leads], [2, 1]);
await refuses("and cannot be chosen for a new inquiry", () => lead("מייל", mail), "אינו פעיל");
await setChannelActive(q, mail, true, user);
check("it can be switched back on", (await activeChannels(q)).length, 3);
await removeChannel(q, wa, user);
check("a source without inquiries is deleted", (await listChannels(q)).map((c) => c.address), ["orders@example.co.il", "0521234568"]);
await refuses("deleting what is not there", () => removeChannel(q, wa, user), "לא נמצא");

// ---------- the sender of documents
check("no sender at first", [await getOutgoing(q), mailSender(await getOutgoing(q))], [{ email: null, emailName: null, whatsapp: null }, null]);
await setOutgoing(q, { email: " Info@Example.co.il", emailName: "אבי ועופר שירותי מזון", whatsapp: "02-6251234" }, user);
check("the sender is kept normalised", await getOutgoing(q), { email: "info@example.co.il", emailName: "אבי ועופר שירותי מזון", whatsapp: "026251234" });
check("mail goes out in that name, and replies come back to it", mailSender(await getOutgoing(q)), { from: '"אבי ועופר שירותי מזון" <info@example.co.il>', replyTo: "info@example.co.il" });
await setOutgoing(q, { email: "info@example.co.il", emailName: "", whatsapp: "" }, user);
check("without a name, the address alone", mailSender(await getOutgoing(q)), { from: "info@example.co.il", replyTo: "info@example.co.il" });
await refuses("a bad sender address", () => setOutgoing(q, { email: "info", emailName: null, whatsapp: null }, user), "אינה תקינה");
await refuses("a bad WhatsApp account", () => setOutgoing(q, { email: null, emailName: null, whatsapp: "abc" }, user), "אינו תקין");
await refuses("a name that would break the mail header", () => setOutgoing(q, { email: "info@example.co.il", emailName: 'A" <x@y.z>', whatsapp: null }, user), "שם השולח");
await refuses("a name with a line break", () => setOutgoing(q, { email: "info@example.co.il", emailName: "A\nBcc: x@y.z", whatsapp: null }, user), "שם השולח");
await refuses("a name without an address", () => setOutgoing(q, { email: "", emailName: "אבי ועופר", whatsapp: null }, user), "יחד עם כתובת מייל");
check("a refused change leaves the sender as it was", (await getOutgoing(q)).email, "info@example.co.il");
await setOutgoing(q, { email: "", emailName: "", whatsapp: "" }, user);
check("the sender can be cleared", mailSender(await getOutgoing(q)), null);
check("changes are written to the history", (await one("select count(*)::int as n from audit_log where action = 'outgoing_sender'")).n, 3);

console.log(failed ? `COMM CHECK FAILED (${failed})` : "COMM CHECK PASSED");
process.exit(failed ? 1 : 0);
