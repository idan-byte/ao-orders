// End-to-end check in headless Edge of live updates between devices: an order opened on one device appears
// on another device's open orders list without reloading the page, what is typed there stays, and the
// change counter is not given to anyone who is not signed in.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-live.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const DAY = new Date(Date.UTC(2500 + Math.floor(Math.random() * 500), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 20))).toISOString().slice(0, 10);

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
async function signIn() {
  const page = await (await browser.newContext({ locale: "he-IL" })).newPage();
  await page.goto(BASE + "/login");
  await page.fill("#mobile", ADMIN);
  await page.click("button[value=request]");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("button[value=verify]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return page;
}
try {
  check("the change counter is not given without signing in", (await (await browser.newContext()).request.get(BASE + "/live")).status(), 401);

  const office = await signIn(); // the screen that stays open
  const tablet = await signIn(); // the device where the work happens
  await office.goto(`${BASE}/orders?from=${DAY}&to=${DAY}`);
  await office.waitForSelector("#orders-q");
  await office.waitForFunction(() => document.documentElement.dataset.live);
  const before = await office.locator("main").textContent();
  await office.evaluate(() => (window.__sameDocument = true));
  await office.fill("#orders-q", "טקסט שהוקלד");

  let index = 0;
  let number = null;
  for (;;) {
    await tablet.goto(BASE + "/orders/new");
    await tablet.waitForSelector("#order-customer");
    await tablet.selectOption("#order-customer", { index: ++index });
    await tablet.click("text=המשך");
    await tablet.waitForSelector("#q-add-line");
    if ((await tablet.locator("#q-address option").count()) < 2) continue;
    await tablet.selectOption("#q-address", { index: 1 });
    await tablet.click("#q-add-line");
    await tablet.selectOption('[data-line-sku="0"]', "50088");
    await tablet.fill('[data-line-qty="0"]', "10");
    await tablet.fill('[data-line-price="0"]', "5");
    await tablet.fill("#q-delivery-date", DAY);
    await tablet.click("button[value=save]");
    await tablet.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
    await tablet.waitForSelector('[data-delivery="0"]');
    number = (await tablet.locator("main h1").first().textContent()).match(/\d{3,}/)[0];
    break;
  }
  check("before the change the open list did not have the order", before.includes(number), false);
  await office.waitForFunction((n) => document.querySelector("main").textContent.includes(n), number, { timeout: 15000 });
  check("the order opened on another device appears on the open list by itself", (await office.locator("main").textContent()).includes(number), true);
  check("the page was not reloaded, and what was typed is still there", [await office.evaluate(() => window.__sameDocument === true), await office.inputValue("#orders-q")], [true, "טקסט שהוקלד"]);
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E LIVE FAILED (${failed})` : "E2E LIVE PASSED");
process.exit(failed ? 1 : 0);
