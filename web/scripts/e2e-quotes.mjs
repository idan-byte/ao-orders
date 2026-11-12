// End-to-end check of quotes in headless Edge: build, totals, send, customer approval by link, new version,
// manual approval, rejection, print view and roles.
// Needs the dev server on http://localhost:3000. Uses the first customer in the development database and
// prints no customer names. Run from the web folder:  node scripts/e2e-quotes.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const SECRET_NOTE = "הערה-פנימית-" + Date.now();

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const newPage = async () => (await browser.newContext({ locale: "he-IL" })).newPage();
async function signIn(mobile) {
  const page = await newPage();
  await page.goto(BASE + "/login");
  await page.fill("#mobile", mobile);
  await page.click("button[value=request]");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("button[value=verify]");
  await page.waitForURL(BASE + "/");
  return page;
}
const count = (page, sel) => page.locator(sel).count();
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").trim();
const digits = (s) => s.replace(/[^\d.]/g, "");

async function newQuote(page) {
  await page.goto(BASE + "/quotes");
  await page.waitForSelector("#new-quote-customer");
  await page.selectOption("#new-quote-customer", { index: 1 });
  await page.click("text=פתח הצעה");
  await page.waitForURL(/\/quotes\/[0-9a-f-]{36}$/);
  await page.waitForSelector("#q-add-line");
  return page.url();
}
async function addLine(page, i, sku, qty, price, date) {
  await page.click("#q-add-line");
  await page.selectOption(`[data-line-sku="${i}"]`, sku);
  await page.fill(`[data-line-qty="${i}"]`, String(qty));
  if (price !== undefined) await page.fill(`[data-line-price="${i}"]`, String(price));
  if (date) await page.fill(`[data-line-date="${i}"]`, date);
}
const send = async (page) => {
  await page.click("button[value=send]");
  await page.waitForSelector("input[aria-label='קישור לאישור ההצעה']");
  await page.waitForFunction(() => document.querySelector("input[aria-label='קישור לאישור ההצעה']").value.startsWith("http"));
  return page.inputValue("input[aria-label='קישור לאישור ההצעה']");
};

try {
  const admin = await signIn(ADMIN);
  await admin.goto(BASE + "/customers");
  await admin.waitForSelector("main h1 + span");
  if ((await text(admin, "main h1 + span")).startsWith("0 ")) {
    await admin.click("text=סנכרן עכשיו");
    await admin.waitForSelector("main [role=status]", { timeout: 240_000 });
  }

  // ---------- build a quote and check the live totals
  const url1 = await newQuote(admin);
  check("new quote opens as a draft", await text(admin, "#quote-status"), "טיוטה");
  await addLine(admin, 0, "50002", 10, undefined);
  check("price is filled from the catalog or the agreement", Number(await admin.inputValue('[data-line-price="0"]')) > 0, true);
  await admin.fill('[data-line-price="0"]', "8");
  await addLine(admin, 1, "50088", 5, 4.5, "2026-12-02");
  await admin.fill("#q-discount", "10");
  await admin.fill("#q-delivery-fee", "100");
  await admin.fill("#q-internal-notes", SECRET_NOTE);
  await admin.fill("#q-customer-notes", "נא לספק עד שמונה בבוקר");
  // 80 + 22.50 = 102.50; minus 10% = 92.25; plus 100 delivery = 192.25; VAT 18% = 34.61; total 226.86
  check("live total in the editor", digits(await text(admin, "#q-total")), "226.86");

  await admin.click("button[value=send]");
  await admin.waitForSelector("form [role=alert]");
  check("cannot send without a delivery date", (await text(admin, "form [role=alert]")).includes("תאריך אספקה"), true);
  await admin.fill("#q-delivery-date", "2026-12-01");
  await admin.click("button[value=save]");
  await admin.waitForSelector("form [role=status]");
  check("draft saved", (await text(admin, "form [role=status]")).includes("גרסה 1"), true);
  await admin.reload();
  await admin.waitForSelector('[data-line-qty="1"]');
  check("draft survives a reload", [await admin.inputValue('[data-line-qty="0"]'), await admin.inputValue('[data-line-price="1"]'), digits(await text(admin, "#q-total"))], ["10", "4.5", "226.86"]);

  const link1 = await send(admin);
  check("sent: status and link", [await text(admin, "#quote-status"), /\/q\/[\w-]{20,}$/.test(link1)], ["נשלחה", true]);

  // ---------- the customer's view
  const customer = await newPage();
  await customer.goto(link1);
  await customer.waitForSelector(".quote-doc");
  const html = await customer.content();
  check("customer sees the total", html.includes("226.86"), true);
  check("customer sees the customer note, not the internal one", [html.includes("נא לספק עד שמונה בבוקר"), html.includes(SECRET_NOTE)], [true, false]);
  check("customer page has no navigation or sign-out", [await count(customer, "header nav a"), await count(customer, "header form")], [0, 0]);
  await customer.goto(BASE + "/q/" + "x".repeat(32));
  await customer.waitForSelector("main h1");
  check("made-up link shows nothing", await text(customer, "main h1"), "הקישור אינו בתוקף");
  await customer.goto(link1);
  await customer.fill("#public-name", "לקוח בדיקה");
  await customer.click("text=אני מאשר/ת את ההצעה");
  await customer.waitForSelector("#public-approved");
  await customer.reload();
  await customer.waitForSelector("#public-approved");
  check("approved by link, and the approve form is gone", await count(customer, "#public-name"), 0);

  await admin.goto(url1);
  await admin.waitForSelector("#quote-approved");
  const approvedText = await text(admin, "#quote-approved");
  check("employee sees approval and the order", [await text(admin, "#quote-status"), approvedText.includes("לקוח בדיקה"), /הזמנה\s*\d{4,}/.test(approvedText)], ["אושרה", true, true]);
  check("approved quote is no longer editable", await count(admin, "#q-add-line"), 0);

  // ---------- new version replaces the old link, then manual approval
  const url2 = await newQuote(admin);
  await addLine(admin, 0, "50002", 20, 9);
  await admin.fill("#q-delivery-date", "2026-12-03");
  const link2a = await send(admin);
  await admin.fill('[data-line-qty="0"]', "30");
  await admin.click("button[value=save]");
  await admin.waitForFunction(() => document.querySelector("#quote-status")?.textContent.trim() === "טיוטה");
  check("editing a sent quote opens version 2", (await admin.locator("h2", { hasText: "עריכת גרסה" }).textContent()).trim(), "עריכת גרסה 2");
  const link2b = await send(admin);
  check("version 2 gets its own link", link2a !== link2b, true);
  await customer.goto(link2a);
  await customer.waitForSelector("main h1");
  check("old link stops working", await text(customer, "main h1"), "הקישור אינו בתוקף");
  await customer.goto(link2b);
  await customer.waitForSelector(".quote-doc");
  check("new link shows the corrected quantity", (await customer.content()).includes("318.60"), true); // 30 x 9 = 270, + 18% VAT

  await admin.fill("#manual-approver", "דנה, בטלפון");
  await admin.click("text=אשר ופתח הזמנה");
  await admin.waitForSelector("#quote-approved");
  check("manual approval is recorded as such", (await text(admin, "#quote-approved")).includes("אישור ידני"), true);
  await customer.reload();
  await customer.waitForSelector("#public-approved");
  check("customer link shows it as approved", await count(customer, "#public-name"), 0);

  // ---------- rejection
  await newQuote(admin);
  await addLine(admin, 0, "50002", 5, 9);
  await admin.fill("#q-delivery-date", "2026-12-04");
  const link3 = await send(admin);
  await admin.selectOption("#reject-reason", "מחיר");
  await admin.click("text=סגור כנדחתה");
  await admin.waitForFunction(() => document.querySelector("#quote-status")?.textContent.trim() === "נדחתה");
  check("rejected quote is closed for editing", await count(admin, "#q-add-line"), 0);
  await customer.goto(link3);
  await customer.waitForSelector("main h1");
  check("rejected quote link stops working", await text(customer, "main h1"), "הקישור אינו בתוקף");

  // ---------- list and print
  await admin.goto(BASE + "/quotes?status=approved");
  await admin.waitForSelector("main table tbody tr");
  check("list filter by status", (await admin.locator("main table tbody tr td:nth-child(3)").allTextContents()).every((s) => s.trim() === "אושרה"), true);
  await admin.goto(url1 + "/print?v=1");
  await admin.waitForSelector(".quote-doc");
  check("print view shows the document", (await admin.content()).includes("226.86"), true);
  await customer.goto(url1 + "/print?v=1");
  await customer.waitForURL(BASE + "/login");
  check("print view needs a login", new URL(customer.url()).pathname, "/login");

  // ---------- roles
  await admin.goto(BASE + "/users");
  await admin.waitForSelector("#new-user-name");
  const add = async (name, mobile, role) => {
    await admin.fill("#new-user-name", name);
    await admin.fill("#new-user-mobile", mobile);
    await admin.selectOption("#new-user-role", role);
    if (await count(admin, "#new-user-department")) await admin.selectOption("#new-user-department", { index: 1 });
    await admin.click("text=הוסף משתמש");
    await admin.waitForSelector(`td:has-text("${name}")`);
  };
  const tag = Date.now() % 100000, clerk = rnd(), manager = rnd();
  await add("עובד הזמנות ה " + tag, clerk, "order_clerk");
  await add("מנהל מחלקה ה " + tag, manager, "dept_manager");
  const c = await signIn(clerk);
  await c.goto(BASE + "/quotes");
  await c.waitForSelector("main table");
  check("order clerk sees quotes but cannot open a new one", await count(c, "#new-quote-customer"), 0);
  await c.goto(url2);
  await c.waitForSelector(".quote-doc");
  check("order clerk cannot edit or approve", [await count(c, "#q-add-line"), await count(c, "#manual-approver")], [0, 0]);
  const m = await signIn(manager);
  await m.goto(BASE + "/quotes");
  await m.waitForSelector("main h1");
  check("department manager: quotes refused", await text(m, "main h1"), "אין הרשאה למסך הזה");
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E QUOTES FAILED (${failed})` : "E2E QUOTES PASSED");
process.exit(failed ? 1 : 0);
