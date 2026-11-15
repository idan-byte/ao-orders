// End-to-end check in headless Edge of incoming mail: messages that were already sorted are taken in, the inbox
// lists the recommendations and leaves out mail that is neither a request nor an order, a recommendation is
// corrected and approved into a quote draft and into an order, and one is dismissed.
// The mailbox and the AI are not used: the test drops ready-made messages into web/.data/inbound-test, which the
// server reads outside production. Its orders are dated in the years 3100-3899.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-inbound.mjs
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const tag = Date.now() % 1000000;
const DAY = `${3100 + Math.floor(Math.random() * 800)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
const SUBJECT = { quote: `בקשה להצעה בדיקה ${tag}`, order: `הזמנה בדיקה ${tag}`, drop: `הזמנה לדחייה בדיקה ${tag}`, other: `חשבונית בדיקה ${tag}` };

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

// ---------- the messages, as the mail reader and the AI would have handed them over
const candidates = [{ sku: "50002", name: "פריט 50002" }, { sku: "50088", name: "פריט 50088" }];
const analysis = (kind) => ({
  kind,
  summary: `בדיקה ${tag}: מבקשים כריכים ומגש.`,
  deliveryDate: DAY,
  deliveryNote: "עד 9:00 בבוקר",
  items: [
    { text: "כריכים", quantity: 40, unit: "יחידות", sku: "50002", certain: true, candidates },
    { text: "מגש", quantity: 2, unit: null, sku: "50088", certain: false, candidates },
    { text: "משהו שאין בקטלוג", quantity: 3, unit: null, sku: null, certain: false, candidates: [] },
  ],
});
const mail = (key, body) => ({ mailbox: "test/INBOX", messageId: `<${key}-${tag}@inbound.test>`, fromEmail: `sender-${tag}@inbound.test`, fromName: "שולח בדיקה", subject: SUBJECT[key], receivedAt: "2026-11-15T08:00:00Z", body, attachments: key === "order" ? [{ name: "order.pdf", size: 1000 }] : [] });
const dropDir = path.join(process.cwd(), ".data", "inbound-test");
await mkdir(dropDir, { recursive: true });
const drop = (key, a, body = "שלום, אבקש 40 כריכים ושני מגשים.") => writeFile(path.join(dropDir, `${tag}-${key}.json`), JSON.stringify({ mail: mail(key, body), analysis: a }));

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ locale: "he-IL" })).newPage();
const clean = (s) => (s ?? "").replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const text = async (sel) => clean(await page.locator(sel).first().innerText());
const go = async (p, wait) => {
  await page.goto(BASE + p);
  await page.waitForSelector(wait);
};
async function submit(form) {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), form.locator("button").click()]);
  await form.locator("button:not([disabled])").waitFor();
  await form.locator("[role=status], [role=alert]").waitFor();
  return clean(await form.locator("[role=status], [role=alert]").textContent());
}
const open = async (subject) => {
  await go("/inbox", "#inbox-list");
  await page.locator(`[data-inbound="${subject}"]:visible a`).click();
  await page.waitForSelector("#inbound-recommendation");
};
const counts = async () => (await text("#inbox-summary")).match(/\d+/g).map(Number);

try {
  await page.goto(BASE + "/login");
  await page.fill("#mobile", ADMIN);
  await page.click("form button");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("form button");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  // ---------- intake
  await go("/inbox", "#inbox-status");
  const before = await counts();
  await drop("quote", analysis("quote_request"));
  await drop("order", analysis("order"));
  await drop("drop", analysis("order"));
  await drop("other", { kind: "other", summary: "חשבונית מספק.", deliveryDate: null, deliveryNote: null, items: [] }, "מצורפת חשבונית לתשלום.");
  // The scheduler may take the files in a moment before the button does; either way the button reports a clean check.
  const said = await submit(page.locator("#inbox-status form"));
  check("the check takes in the new messages and says what they were", said === "נקראו 4 הודעות חדשות: 3 המלצות, 1 לא רלוונטיות." || said === "אין הודעות חדשות.", true);
  await page.waitForSelector(`[data-inbound="${SUBJECT.order}"]`);
  const after = await counts();
  check("three recommendations wait, and one message was filtered out", [after[0] - before[0], after[1] - before[1]], [3, 1]);
  check("mail that is neither a request nor an order is not listed", await page.locator(`[data-inbound="${SUBJECT.other}"]`).count(), 0);
  check("a recommendation says what it is and that the sender is not a known customer", (await text(`[data-inbound="${SUBJECT.quote}"]`)).includes("בקשה להצעת מחיר · שולח שאינו מזוהה כלקוח"), true);
  check("a second check finds nothing new", await submit(page.locator("#inbox-status form")), "אין הודעות חדשות.");

  // ---------- a request becomes a quote draft
  await open(SUBJECT.quote);
  check("the message is shown as written", await text("#inbound-mail p"), "שלום, אבקש 40 כריכים ושני מגשים.");
  check("a line that is not certain is pointed out, and a line without a product is left out of the document", [await page.locator('[data-line="מגש"]').getAttribute("data-certain"), (await text('[data-line="מגש"]')).includes("ההתאמה אינה ודאית"), await page.locator('[name="use_2"]').isChecked(), await page.locator('[name="use_0"]').isChecked()], ["false", true, false, true]);
  check("a request opens a quote by default, with the date from the message", [await page.inputValue("[name=target]"), await page.inputValue("[name=delivery_date]")], ["quote", DAY]);
  const form = page.locator("#inbound-recommendation form");
  await page.selectOption("[name=customer_id]", { index: 1 });
  await page.locator('[name="use_2"]').setChecked(true);
  check("a ticked line without a product is refused", await submit(form), "שורה 3 מסומנת אבל לא נבחר לה מוצר. בוחרים מוצר, או מורידים את הסימון.");
  await page.locator('[name="use_2"]').setChecked(false);
  await page.fill('[name="qty_0"]', "12");
  await form.locator("button").click();
  await page.waitForURL(/\/quotes\/[0-9a-f-]{36}/);
  check("the approval opens the quote", /\/quotes\/[0-9a-f-]{36}/.test(page.url()), true);
  await open2("approved", SUBJECT.quote);
  check("the recommendation is closed and points at the quote", [await page.locator("#inbound-done").getAttribute("data-status"), (await text("#inbound-done")).includes("הצעת מחיר")], ["approved", true]);

  // ---------- an order becomes an order
  await open(SUBJECT.order);
  check("an order opens an order by default, and its attachments are named", [await page.inputValue("[name=target]"), (await text("#inbound-attachments")).includes("order.pdf")], ["order", true]);
  await page.selectOption("[name=customer_id]", { index: 1 });
  await page.fill("[name=delivery_date]", "");
  check("an order without a delivery date is refused", await submit(page.locator("#inbound-recommendation form")), "להזמנה צריך תאריך אספקה.");
  await page.fill("[name=delivery_date]", DAY);
  await page.fill('[name="other_1"]', "50002");
  await page.locator("#inbound-recommendation form button").click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}/);
  await page.waitForSelector("#order-status");
  check("the approval opens the order, approved, like one typed by hand", await text("#order-status"), "מאושרת");

  // ---------- dismissal
  await open(SUBJECT.drop);
  await page.fill("#inbound-dismiss [name=reason]", "כפילות");
  await page.locator("#inbound-dismiss form button").click();
  await page.waitForURL(/\/inbox$/);
  await open2("dismissed", SUBJECT.drop);
  check("a dismissed recommendation keeps its reason and can no longer be approved", [(await text("#inbound-done")).includes("כפילות"), await page.locator("#inbound-recommendation form").count()], [true, 0]);
  await go("/inbox", "#inbox-summary");
  check("nothing of this test is left waiting", (await counts())[0], before[0]);
} catch (e) {
  failed++;
  console.log("FAIL the run stopped:", e.message.split("\n")[0], "at", new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/, "<id>"), "|", await page.locator("[role=alert]:visible").allTextContents().catch(() => []));
} finally {
  await browser.close();
}
async function open2(tab, subject) {
  await go(`/inbox?tab=${tab}`, "#inbox-list");
  await page.locator(`[data-inbound="${subject}"]:visible a`).click();
  await page.waitForSelector("#inbound-done");
}
console.log(failed === 0 ? "INBOUND E2E PASSED" : `INBOUND E2E FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
