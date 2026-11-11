// End-to-end check of the Hashavshevet sync, the customers screens and price agreements, in headless Edge.
// Needs the dev server on http://localhost:3000 and a reachable Hashavshevet database (HASH_SQL_CONNECTION).
// It reads real customers but prints only counts, never names. It approves and edits prices on ONE customer
// in the development database only. Run from the web folder:  node scripts/e2e-customers.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");

let failed = 0;
function check(label, actual, expected) {
  const ok = typeof expected === "function" ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? (typeof expected === "function" ? ` (${JSON.stringify(actual)})` : "") : ` -> got ${JSON.stringify(actual)}`}`);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
async function signIn(mobile) {
  const page = await (await browser.newContext({ locale: "he-IL" })).newPage();
  await page.goto(BASE + "/login");
  await page.fill("#mobile", mobile);
  await page.click("button[value=request]");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("button[value=verify]");
  await page.waitForURL(BASE + "/");
  return page;
}
const count = (page, selector) => page.locator(selector).count();
const pendingCount = async (page) => Number((await page.locator("h2", { hasText: "מחירים ממתינים לבדיקה" }).textContent()).split("·")[1]);
const agreedCount = async (page) => Number((await page.locator("h2", { hasText: "הסכם מחיר" }).textContent()).split("·")[1].replace(/\D/g, ""));

try {
  const admin = await signIn(ADMIN);

  // --- sync
  await admin.goto(BASE + "/customers");
  await admin.click("text=סנכרן עכשיו");
  await admin.waitForSelector("main [role=status], main [role=alert]", { timeout: 240_000 });
  check("sync finished without error", await count(admin, "main [role=alert]"), 0);
  await admin.goto(BASE + "/customers");
  await admin.waitForSelector("main table tbody tr");
  const header = await admin.locator("main h1 + span").textContent();
  const [customers, pending] = header.match(/[\d,]+/g).map((n) => Number(n.replace(/,/g, "")));
  check("customers loaded from Hashavshevet", customers, (n) => n >= 300);
  check("pending prices loaded", pending, (n) => n >= 500);
  check("list is capped at 100 rows", await count(admin, "main table tbody tr"), 100);

  // --- running the sync again must not duplicate anything
  await admin.click("text=סנכרן עכשיו");
  await admin.waitForSelector("main [role=status], main [role=alert]", { timeout: 240_000 });
  const second = await admin.locator("main [role=status]").textContent();
  check("second sync creates no new customers", /לקוחות: 0 חדשים/.test(second), true);
  check("second sync creates no new prices", /מחירים לבדיקה: 0 חדשים/.test(second), true);

  // --- search
  await admin.goto(BASE + "/customers?q=" + encodeURIComponent("זזזזזזזז"));
  await admin.waitForSelector("main form#nothing, main p:has-text('לא נמצאו')");
  check("search with no match", await count(admin, "main table tbody tr"), 0);

  // --- one customer with pending prices
  await admin.goto(BASE + "/customers?pending=1");
  await admin.waitForSelector("main table tbody tr a");
  await admin.locator("main table tbody tr a").first().click();
  await admin.waitForSelector("h2:has-text('מחירים ממתינים לבדיקה')");
  const url = admin.url();
  const before = await pendingCount(admin);
  check("customer has pending prices", before, (n) => n > 0);

  await admin.locator("button", { hasText: /^אשר$/ }).first().click();
  await admin.waitForFunction((n) => Number(document.querySelector("h2")?.textContent && [...document.querySelectorAll("h2")].find((h) => h.textContent.includes("מחירים ממתינים"))?.textContent.split("·")[1]) === n, before - 1);
  check("approving one row", [await pendingCount(admin), await agreedCount(admin)], [before - 1, 1]);

  if (before > 1) {
    await admin.locator("button", { hasText: "אשר את כל" }).click();
    await admin.waitForSelector("text=אין מחירים שממתינים לבדיקה");
  }
  check("approve all clears the pending list", await pendingCount(admin), 0);
  check("all prices are now in the agreement", await agreedCount(admin), before);

  // --- manual price with a future start date
  const sku = await admin.locator("#price-sku option").nth(1).getAttribute("value");
  await admin.selectOption("#price-sku", sku);
  await admin.fill("#price-value", "7.77");
  await admin.fill("#price-from", "2027-01-01");
  await admin.click("text=שמור מחיר");
  await admin.waitForSelector("td:has-text('עתידי')");
  check("future price is listed as future", await count(admin, "td:has-text('עתידי')"), 1);
  // The form resets after a successful save, so the product is chosen again.
  await admin.selectOption("#price-sku", sku);
  await admin.fill("#price-value", "-3");
  await admin.fill("#price-from", "2027-01-01");
  await admin.click("text=שמור מחיר");
  await admin.waitForSelector("main [role=alert]");
  check("negative price refused", (await admin.locator("main [role=alert]").textContent()).includes("אינו תקין"), true);

  // --- address and contact
  const addressesBefore = await count(admin, "section:has(h2:has-text('כתובות אספקה')) li");
  await admin.fill("#address-street", "רחוב הבדיקה 5");
  await admin.fill("#address-city", "ירושלים");
  await admin.click("text=הוסף כתובת");
  await admin.waitForFunction((n) => document.querySelectorAll("section li").length > 0 && [...document.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent.includes("כתובות אספקה")).querySelectorAll("li").length === n + 1, addressesBefore);
  check("address added", await count(admin, "section:has(h2:has-text('כתובות אספקה')) li"), addressesBefore + 1);
  await admin.fill("#contact-name", "איש קשר לבדיקה");
  await admin.fill("#contact-email", "לא-מייל");
  await admin.evaluate(() => document.querySelector("#contact-email").setAttribute("type", "text"));
  await admin.click("text=הוסף איש קשר");
  await admin.waitForSelector("section:has(h2:has-text('אנשי קשר')) [role=alert]");
  check("invalid email refused by the server", await count(admin, "section:has(h2:has-text('אנשי קשר')) li"), 0);

  // --- a third sync must leave the approved prices alone
  await admin.goto(BASE + "/customers");
  await admin.click("text=סנכרן עכשיו");
  await admin.waitForSelector("main [role=status], main [role=alert]", { timeout: 240_000 });
  await admin.goto(url);
  await admin.waitForSelector("h2:has-text('הסכם מחיר')");
  check("sync does not reopen approved prices", await pendingCount(admin), 0);

  // --- roles
  await admin.goto(BASE + "/users");
  await admin.waitForSelector("#new-user-name");
  const add = async (name, mobile, role) => {
    await admin.fill("#new-user-name", name);
    await admin.fill("#new-user-mobile", mobile);
    await admin.selectOption("#new-user-role", role);
    if (await count(admin, "#new-user-department")) await admin.selectOption("#new-user-department", await admin.locator("#new-user-department option").nth(1).getAttribute("value"));
    await admin.click("text=הוסף משתמש");
    await admin.waitForSelector(`td:has-text("${name}")`);
  };
  const tag = Date.now() % 100000;
  const clerk = rnd(), manager = rnd();
  await add("עובד הזמנות בדיקה " + tag, clerk, "order_clerk");
  await add("מנהל מחלקה בדיקה " + tag, manager, "dept_manager");

  const c = await signIn(clerk);
  await c.goto(url);
  await c.waitForSelector("h2:has-text('הסכם מחיר')");
  check("order clerk sees prices but cannot change them", [await count(c, "#price-sku"), await count(c, "button:has-text('הסר')"), await count(c, "#address-street")], [0, 0, 0]);
  await c.goto(BASE + "/customers");
  await c.waitForSelector("main table");
  check("order clerk has no sync button", await count(c, "text=סנכרן עכשיו"), 0);

  const m = await signIn(manager);
  await m.goto(BASE + "/customers");
  await m.waitForSelector("main h1");
  check("department manager: customers refused", (await m.locator("main h1").textContent()).trim(), "אין הרשאה למסך הזה");
  await m.goto(url);
  await m.waitForSelector("main h1");
  check("department manager: customer card refused", (await m.locator("main h1").textContent()).trim(), "אין הרשאה למסך הזה");
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E CUSTOMERS FAILED (${failed})` : "E2E CUSTOMERS PASSED");
process.exit(failed ? 1 : 0);
