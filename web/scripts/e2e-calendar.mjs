// End-to-end check in headless Edge of the orders calendar and of automatic generation of standing orders,
// including the background scheduler (the dev server needs AO_SCHEDULER_INTERVAL_SECONDS=10 in .env.local).
// The automation is switched back to how it was found. Run from the web folder:  node scripts/e2e-calendar.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
// A random far-future month that no other run is likely to share.
const YEAR = 2100 + Math.floor(Math.random() * 400);
const MONTH = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
const KEY = `${YEAR}-${MONTH}`;
const D1 = `${KEY}-10`;
const D2 = `${KEY}-17`;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
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
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return page;
}
const count = (page, sel) => page.locator(sel).count();
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").trim();
async function order(page, lines, date) {
  await page.goto(BASE + "/orders/new");
  await page.waitForSelector("#order-customer");
  await page.selectOption("#order-customer", { index: 1 });
  await page.click("text=המשך");
  await page.waitForSelector("#q-add-line");
  for (const [i, [sku, qty]] of lines.entries()) {
    await page.click("#q-add-line");
    await page.selectOption(`[data-line-sku="${i}"]`, sku);
    await page.fill(`[data-line-qty="${i}"]`, String(qty));
    await page.fill(`[data-line-price="${i}"]`, "5");
  }
  await page.fill("#q-delivery-date", date);
  await page.click("button[value=save]");
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await page.waitForSelector('[data-delivery="0"]');
}
const cell = (day) => `[data-cal-day="${day}"]`;
async function openStanding(page) {
  await page.goto(BASE + "/standing");
  await page.waitForSelector("#auto-days");
}
async function saveAuto(page, enabled, days) {
  await page.locator("#auto-enabled").setChecked(enabled);
  await page.fill("#auto-days", String(days));
  await page.locator("[data-auto] button").click();
  await page.waitForSelector(`[data-auto="${enabled}"] [role=status]`);
  return text(page, "[data-auto] [role=status]");
}

const admin = await signIn(ADMIN);
let original = null;
try {
  // ---------- calendar
  await order(admin, [["50002", 60], ["50088", 40]], D1);
  await order(admin, [["50002", 25]], D1);
  await order(admin, [["50088", 10]], D2);
  await admin.goto(`${BASE}/orders/calendar?month=${KEY}`);
  await admin.waitForSelector(cell(D1));
  check("the month has a cell for every day", (await count(admin, "[data-cal-day]")) >= 28, true);
  check("a day sums its deliveries and units", [await text(admin, `${cell(D1)} [data-cal-deliveries]`), await text(admin, `${cell(D1)} [data-cal-units]`)], ["2", "125"]);
  check("another day stands on its own", [await text(admin, `${cell(D2)} [data-cal-deliveries]`), await text(admin, `${cell(D2)} [data-cal-units]`)], ["1", "10"]);
  check("month summary", (await text(admin, "#cal-summary")).startsWith("3 אספקות · 135 יחידות"), true);
  check("an empty day shows no counts", await count(admin, `${cell(`${KEY}-11`)} [data-cal-deliveries]`), 0);

  // A cancelled delivery leaves the calendar.
  await admin.click(cell(D2));
  await admin.waitForURL((u) => u.pathname === "/orders" && u.searchParams.get("from") === D2 && u.searchParams.get("to") === D2);
  await admin.waitForSelector(`[data-day="${D2}"]`);
  check("a day opens the orders list for that date", await count(admin, "[data-day]:visible"), 1);
  await admin.locator(`[data-day="${D2}"] a`).first().click();
  await admin.waitForSelector('[data-delivery="0"]');
  await admin.locator('[data-delivery="0"] [data-cancel-reason]').fill("בדיקת לוח שנה");
  await admin.locator('[data-delivery="0"] button:has-text("בטל אספקה")').click();
  await admin.waitForFunction(() => document.querySelector('[data-delivery="0"] [data-delivery-status]')?.textContent.trim() === "מבוטלת");
  await admin.goto(`${BASE}/orders/calendar?month=${KEY}`);
  await admin.waitForSelector(cell(D1));
  check("a cancelled delivery is not counted", [await count(admin, `${cell(D2)} [data-cal-deliveries]`), (await text(admin, "#cal-summary")).startsWith("2 אספקות · 125 יחידות")], [0, true]);

  // Moving between months, and back to the list.
  await admin.click("#cal-next");
  await admin.waitForFunction((k) => !new URL(location.href).searchParams.get("month")?.startsWith(k) && document.querySelector("#cal-summary:not([hidden])"), KEY);
  const next = new URL(admin.url()).searchParams.get("month");
  const expectedNext = MONTH === "12" ? `${YEAR + 1}-01` : `${YEAR}-${String(Number(MONTH) + 1).padStart(2, "0")}`;
  check("next month", next, expectedNext);
  await admin.goto(BASE + "/orders");
  await admin.waitForSelector("#calendar-link");
  await admin.click("#calendar-link");
  await admin.waitForURL((u) => u.pathname === "/orders/calendar");
  await admin.waitForSelector("[data-cal-day]");
  check("the orders list links to the calendar of the current month", await count(admin, "#cal-today"), 0);

  // A closed day is marked.
  await openStanding(admin);
  const closedDay = `${KEY}-20`;
  await admin.fill("#closed-day", closedDay);
  await admin.fill("#closed-reason", "חג לבדיקה");
  await admin.click("text=הוסף יום סגור");
  await admin.waitForSelector(`[data-closed-days] li:has-text("חג לבדיקה")`);
  await admin.goto(`${BASE}/orders/calendar?month=${KEY}`);
  await admin.waitForSelector(cell(closedDay));
  check("a closed day is marked on the calendar", (await text(admin, `${cell(closedDay)} [data-cal-closed]`)).includes("חג לבדיקה"), true);

  // ---------- automatic generation
  await openStanding(admin);
  original = { enabled: await admin.locator("#auto-enabled").isChecked(), days: await admin.locator("#auto-days").inputValue() };
  await admin.locator("#auto-enabled").setChecked(true);
  await admin.fill("#auto-days", "0");
  await admin.evaluate(() => document.querySelector("#auto-days").removeAttribute("min"));
  await admin.locator("[data-auto] button").click();
  await admin.waitForSelector("[data-auto] [role=alert]");
  check("zero days ahead is refused by the server", (await text(admin, "[data-auto] [role=alert]")).includes("בין 1 ל-30"), true);
  await openStanding(admin);
  check("switching on runs it at once", /פעילה\. נוצרו עכשיו \d+ הזמנות/.test(await saveAuto(admin, true, 8)), true);
  await openStanding(admin);
  check("the last run is shown", (await text(admin, "#auto-last")).startsWith("ריצה אחרונה:"), true);

  // A standing order created now, delivering every day: the background scheduler must pick it up by itself.
  await admin.selectOption("#standing-customer", { index: 2 });
  await admin.click("text=המשך");
  await admin.waitForSelector("#st-add-row");
  await admin.click("#st-add-row");
  await admin.selectOption('[data-st-sku="0"]', "50088");
  for (let k = 0; k < 6; k++) await admin.fill(`[data-st-qty="0-${k}"]`, "7");
  await admin.click("#st-save");
  await admin.waitForURL(/\/standing\/[0-9a-f-]{36}$/);
  const standingUrl = admin.url();
  let generated = 0;
  for (let i = 0; i < 12 && generated === 0; i++) {
    await admin.waitForTimeout(4000);
    await admin.goto(standingUrl);
    await admin.waitForSelector("#st-save");
    generated = await count(admin, "[data-generated] li:visible, [data-generated] tr:visible");
  }
  check("the scheduler created the orders with nobody pressing anything", generated >= 6, true);
  // End that standing order so it stops producing orders.
  await admin.fill("#st-valid-to", await admin.locator("#st-valid-from").inputValue());
  await admin.click("#st-save");
  await admin.waitForSelector("main form [role=status]");

  await openStanding(admin);
  check("switching off", (await saveAuto(admin, false, 8)).includes("כבויה"), true);
  original = null;
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  if (original && !original.enabled) {
    try {
      await openStanding(admin);
      await saveAuto(admin, false, original.days || 7);
    } catch {
      console.log("WARNING: automatic generation may have been left switched on. Switch it off at /standing.");
    }
  }
  await browser.close();
}
console.log(failed ? `E2E CALENDAR FAILED (${failed})` : "E2E CALENDAR PASSED");
process.exit(failed ? 1 : 0);
