// Tests letterheads ("logo pages"), which one a quote uses, and the text of a quote email.
// Run from the web folder:  node scripts/check-letterheads.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { listLetterheads, saveLetterhead, setLogo, getLogo, setDefault, setActive, setQuoteLetterhead, sniffImage, MAX_LOGO_BYTES } from "../src/lib/letterheads-core.ts";
import { buildQuoteEmail, isEmail, recordEmail, emailsOf } from "../src/lib/mail-core.ts";
import { createQuote, rejectQuote } from "../src/lib/quotes-core.ts";

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

const user = await one("insert into users (mobile, full_name, role) values ('0500000009', 'מנהל', 'admin') returning id::text");
const cust = await one("insert into customers (name) values ('לקוח לבדיקה') returning id::text");
const names = async () => (await listLetterheads(q)).map((l) => [l.name, l.isDefault, l.active]);

// ---------- letterheads
check("the system starts with one default letterhead", await names(), [["כללי", true, true]]);
const general = (await listLetterheads(q))[0].id;
await refuses("a letterhead needs a name", () => saveLetterhead(q, null, { name: " ", title: "x", subtitle: null, footer: null }, user.id), "שם לדף");
await refuses("a letterhead needs the business name", () => saveLetterhead(q, null, { name: "מגשי אירוח", title: "", subtitle: null, footer: null }, user.id), "שם העסק");
const trays = await saveLetterhead(q, null, { name: "מגשי אירוח", title: "A&O מגשי אירוח", subtitle: "  עטרות   ירושלים ", footer: "כשר למהדרין" }, user.id);
const hot = await saveLetterhead(q, null, { name: "אוכל חם", title: "A&O אוכל חם", subtitle: null, footer: null }, user.id);
await refuses("two letterheads cannot share a name", () => saveLetterhead(q, null, { name: "מגשי אירוח", title: "אחר", subtitle: null, footer: null }, user.id), "כבר קיים");
await saveLetterhead(q, trays, { name: "מגשי אירוח", title: "A&O מגשי אירוח", subtitle: "עטרות ירושלים", footer: "כשר למהדרין" }, user.id);
check("a letterhead can be saved again under its own name, and text is tidied", (await listLetterheads(q)).find((l) => l.id === trays).subtitle, "עטרות ירושלים");

// ---------- logo
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
check("file type is read from the bytes", [sniffImage(png), sniffImage(jpg), sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))], ["image/png", "image/jpeg", null]);
await refuses("a file that is not an image is refused", () => setLogo(q, trays, new TextEncoder().encode("<script>"), user.id), "אינו תמונה");
await refuses("an oversized logo is refused", () => setLogo(q, trays, new Uint8Array(MAX_LOGO_BYTES + 1), user.id), "גדול מדי");
await refuses("an empty file is refused", () => setLogo(q, trays, new Uint8Array(0), user.id), "יש לבחור קובץ");
await setLogo(q, trays, png, user.id);
const stored = await getLogo(q, trays);
check("the logo is stored with its type", [stored.mime, [...stored.bytes]], ["image/png", [...png]]);
check("each letterhead has its own logo", [(await listLetterheads(q)).filter((l) => l.hasLogo).map((l) => l.name), await getLogo(q, hot)], [["מגשי אירוח"], null]);
await setLogo(q, trays, null, user.id);
check("a logo can be removed", await getLogo(q, trays), null);
await setLogo(q, trays, png, user.id);

// ---------- default and active
await refuses("the default letterhead cannot be switched off", () => setActive(q, general, false), "ברירת המחדל");
await setDefault(q, hot);
check("exactly one default at a time", (await names()).filter((n) => n[1]).map((n) => n[0]), ["אוכל חם"]);
await setActive(q, general, false);
await refuses("a switched-off letterhead cannot become the default", () => setDefault(q, general), "אינו בשימוש");

// ---------- which letterhead a quote uses
const effective = async (quoteId) => (await one("select lh.name from quotes qt join letterheads lh on lh.id = coalesce(qt.letterhead_id, (select id from letterheads where is_default)) where qt.id = $1", [quoteId])).name;
const quote = await createQuote(q, cust.id, user.id, null);
check("a new quote uses the default letterhead", await effective(quote.quoteId), "אוכל חם");
await setQuoteLetterhead(q, quote.quoteId, trays, user.id);
check("a quote can choose another letterhead", await effective(quote.quoteId), "מגשי אירוח");
await setDefault(q, trays);
await setDefault(q, hot);
check("changing the default does not move a quote that made a choice", await effective(quote.quoteId), "מגשי אירוח");
await refuses("a switched-off letterhead cannot be chosen", () => setQuoteLetterhead(q, quote.quoteId, general, user.id), "אינו בשימוש");
await refuses("an unknown letterhead cannot be chosen", () => setQuoteLetterhead(q, quote.quoteId, 999, user.id), "לא נמצא");
await setActive(q, trays, false);
check("a quote keeps a letterhead that was switched off later", await effective(quote.quoteId), "מגשי אירוח");
await setQuoteLetterhead(q, quote.quoteId, null, user.id);
check("a quote can return to the default", await effective(quote.quoteId), "אוכל חם");
check("the choice is written to the history", (await one("select count(*)::int as n from audit_log where action = 'quote_letterhead'")).n, 2);
check("the list counts quotes per letterhead", (await listLetterheads(q)).map((l) => [l.name, l.quotes]), [["אוכל חם", 0], ["כללי", 0], ["מגשי אירוח", 0]]);
await rejectQuote(q, quote.quoteId, "מחיר", user.id).catch(() => q("update quotes set status = 'rejected' where id = $1", [quote.quoteId]));
await refuses("a closed quote keeps its letterhead", () => setQuoteLetterhead(q, quote.quoteId, hot, user.id), "סגורה");

// ---------- email text
check("email addresses", [isEmail("dana@example.co.il"), isEmail("dana@example"), isEmail("a b@example.com"), isEmail("x@y.com, z@y.com")], [true, false, false, false]);
const base = { to: " dana@example.co.il ", number: 1042, customerName: "בית ספר", senderName: "רונית", businessName: "A&O מגשי אירוח", message: null, approvalUrl: null };
const plain = buildQuoteEmail(base);
check("subject carries the number and the letterhead's business name", [plain.to, plain.subject], ["dana@example.co.il", "הצעת מחיר 1042 · A&O מגשי אירוח"]);
check("without a public address there is no link in the email", [plain.text.includes("http"), plain.text.includes("PDF")], [false, true]);
const linked = buildQuoteEmail({ ...base, message: "כפי שסיכמנו <b>בטלפון</b>", approvalUrl: "https://orders.example.co.il/q/abc" });
check("with a public address the link is included", [linked.text.includes("https://orders.example.co.il/q/abc"), linked.html.includes('<a href="https://orders.example.co.il/q/abc">')], [true, true]);
check("the employee's words are text, never markup", [linked.html.includes("<b>"), linked.html.includes("&lt;b&gt;בטלפון&lt;/b&gt;")], [false, true]);
try { buildQuoteEmail({ ...base, to: "not-an-address" }); failed++; console.log("FAIL bad address accepted"); } catch (e) { check("a bad address is refused", e.message.includes("אינה תקינה"), true); }
try { buildQuoteEmail({ ...base, message: "א".repeat(2001) }); failed++; console.log("FAIL long message accepted"); } catch (e) { check("an overlong message is refused", e.message.includes("ארוכה"), true); }

await recordEmail(q, { entityType: "quote", entityId: quote.quoteId, to: plain.to, subject: plain.subject, body: plain.text, attachment: "quote-1042-v1.pdf", status: "failed", error: "x".repeat(900), userId: user.id });
await recordEmail(q, { entityType: "quote", entityId: quote.quoteId, to: plain.to, subject: plain.subject, body: plain.text, attachment: "quote-1042-v1.pdf", status: "sent", error: null, userId: user.id });
const log = await emailsOf(q, "quote", quote.quoteId);
check("every attempt is recorded, with who and whether it went out", [log.length, log.map((e) => e.status).sort(), log[0].by, log.find((e) => e.status === "failed").error.length], [2, ["failed", "sent"], "מנהל", 500]);

console.log(failed ? `LETTERHEADS CHECK FAILED (${failed})` : "LETTERHEADS CHECK PASSED");
process.exit(failed ? 1 : 0);
