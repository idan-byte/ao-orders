// End-to-end check in headless Edge of loading and delivery: the driver's screen, loading, a departure with a
// missing delivery approved by a manager, handing over, reversal, progress on the board, and who sees what.
// The test keeps one route ("קו בדיקה טעינה") and one driver ("נהג בדיקה טעינה") and switches them off at the end.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-loading.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const [ROUTE, DRIVER] = ["קו בדיקה טעינה", "נהג בדיקה טעינה"];
const tag = Date.now() % 1000000;
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const DAY = new Date(Date.UTC(3200 + Math.floor(Math.random() * 200), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 20))).toISOString().slice(0, 10);
const routeCard = `[data-route="${ROUTE}"]`;
const driverCard = `[data-driver="${DRIVER}"]`;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
async function signIn(mobile) {
  const page = await (await browser.newContext({ locale: "he-IL" })).newPage();
  page.on("dialog", (d) => d.accept());
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
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const admin = await signIn(ADMIN);
const go = async (page, path, wait) => {
  await page.goto(BASE + path);
  await page.waitForSelector(wait);
};
const tap = async (page, number, marked) => {
  await page.locator(`[data-delivery="${number}"] button`).first().click();
  await page.waitForSelector(`[data-delivery="${number}"][data-marked="${marked}"]`);
};
const stopNames = (page) => page.locator("[data-stop]:visible [data-stop-customer]").allTextContents().then((l) => l.map((s) => s.trim()));
let customerIndex = 0;
async function newOrder() {
  for (;;) {
    await go(admin, "/orders/new", "#order-customer");
    await admin.selectOption("#order-customer", { index: ++customerIndex });
    const name = (await admin.locator("#order-customer option:checked").textContent()).trim();
    await admin.click("text=המשך");
    await admin.waitForSelector("#q-add-line");
    if ((await count(admin, "#q-address option")) < 2) continue;
    await admin.selectOption("#q-address", { index: 1 });
    await admin.click("#q-add-line");
    await admin.selectOption('[data-line-sku="0"]', "50088");
    await admin.fill('[data-line-qty="0"]', "10");
    await admin.fill('[data-line-price="0"]', "5");
    await admin.fill("#q-delivery-date", DAY);
    await admin.fill("#q-customer-notes", `להשאיר אצל השומר ${tag}`);
    await admin.click("button[value=save]");
    await admin.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
    await admin.waitForSelector('[data-delivery="0"]');
    return { name, number: (await text(admin, "main h1")).match(/\d{3,}/)[0], url: new URL(admin.url()).pathname };
  }
}
async function addUser(name, role, mobile = rnd()) {
  await go(admin, "/users", "#new-user-name");
  await admin.fill("#new-user-name", name);
  await admin.fill("#new-user-mobile", mobile);
  await admin.selectOption("#new-user-role", role);
  await admin.click("text=הוסף משתמש");
  await admin.waitForSelector(`text=${name}`);
  return mobile;
}

let made = false;
try {
  check("the menu has the loading and delivery screen", (await admin.locator("header nav a").allTextContents()).includes("טעינה והפצה"), true);

  // ---------- a driver whose phone is also a login
  const driverMobile = rnd();
  await go(admin, "/shipping/drivers", "#new-driver");
  if ((await count(admin, driverCard)) === 0) {
    await admin.fill("#new-driver [name=name]", DRIVER);
    await admin.fill("#new-driver [name=registration]", "99-999-02");
    await admin.click("#new-driver button");
    await admin.waitForSelector(driverCard);
  } else if ((await admin.locator(driverCard).getAttribute("data-active")) === "false") {
    await admin.locator(`${driverCard} button:has-text("החזר לפעילות")`).click();
    await admin.waitForSelector(`${driverCard}[data-active="true"]`);
  }
  made = true;
  await admin.locator(`${driverCard} [name=phone]`).fill(driverMobile);
  await admin.locator(`${driverCard} form:has([name=name]) button`).click();
  await admin.waitForSelector(`${driverCard} form:has([name=name]) [role=status]`);
  await go(admin, "/shipping/drivers", "#new-driver");
  check("a driver without a login is flagged", await admin.locator(`${driverCard} [data-login]`).getAttribute("data-login"), "false");
  await addUser(`נהג ${tag}`, "driver", driverMobile);
  const otherDriverMobile = await addUser(`נהג אחר ${tag}`, "driver");
  const loaderMobile = await addUser(`מעמיס ${tag}`, "loading_manager");
  await go(admin, "/shipping/drivers", "#new-driver");
  check("once a user has the same phone, the driver has a login", await admin.locator(`${driverCard} [data-login]`).getAttribute("data-login"), "true");

  // ---------- route, orders, assignment
  await go(admin, "/shipping/routes", "#new-route");
  if ((await count(admin, routeCard)) === 0) {
    await admin.fill("#new-route [name=name]", ROUTE);
    await admin.click("#new-route button");
    await admin.waitForSelector(routeCard);
  } else if ((await admin.locator(routeCard).getAttribute("data-active")) === "false") {
    await admin.locator(`${routeCard} button:has-text("החזר לשימוש")`).click();
    await admin.waitForSelector(`${routeCard}[data-active="true"]`);
  }
  await go(admin, "/shipping/routes", "#new-route");
  await admin.locator(`${routeCard} [name=driver_id]`).selectOption({ label: DRIVER });
  await admin.locator(`${routeCard} form:has([name=name]) button`).click();
  await admin.waitForSelector(`${routeCard} form:has([name=name]) [role=status]`);
  const a = await newOrder();
  const b = await newOrder();
  const c = await newOrder();
  await go(admin, `/shipping?date=${DAY}`, "#unassigned");
  for (const o of [a, b, c]) {
    const row = admin.locator(`[data-unassigned="${o.number}"]`);
    await row.locator("select").selectOption({ label: ROUTE });
    await row.locator("[name=permanent]").setChecked(false);
    await row.locator("button").click();
    await admin.waitForFunction((n) => !document.querySelector(`[data-unassigned="${n}"]`), o.number);
  }
  await go(admin, `/shipping?date=${DAY}`, "[data-route-card]");
  check("the board shows the route in loading mode with nothing loaded", await text(admin, `[data-route-card="${ROUTE}"] [data-progress]`), "טעינה · הועמסו 0/3");
  const work = (await admin.locator(`[data-route-card="${ROUTE}"]`).getAttribute("href")).replace("/shipping/day/", "/drive/");

  // ---------- the driver loads
  const driver = await signIn(driverMobile);
  await driver.waitForURL(BASE + "/drive");
  await driver.waitForSelector("main h1");
  check("a driver lands on the loading and delivery screen, with only that in the menu", [await text(driver, "main h1"), await driver.locator("header nav a").allTextContents()], ["טעינה והפצה", ["טעינה והפצה"]]);
  await go(driver, work, "#route-state");
  check("the route opens in loading mode, in loading order (last stop first)", [await driver.locator("#route-state").getAttribute("data-mode"), await text(driver, "#progress"), await stopNames(driver)], ["loading", "הועמסו 0 מתוך 3 · טרם התחיל", [c.name, b.name, a.name]]);
  check("the shipping note of the order is shown to the driver", (await text(driver, `[data-delivery="${a.number}"]`)).includes(`להשאיר אצל השומר ${tag}`), true);
  await tap(driver, a.number, "true");
  await tap(driver, b.number, "true");
  // Optional: a phone-sized picture of the driver's screen, for looking at the layout (AO_SCREENSHOT=path.png).
  if (process.env.AO_SCREENSHOT) {
    await driver.setViewportSize({ width: 390, height: 844 });
    await driver.screenshot({ path: process.env.AO_SCREENSHOT, fullPage: true });
    await driver.setViewportSize({ width: 1280, height: 720 });
  }
  check("two taps, two loaded", [await text(driver, "#progress"), await count(driver, '[data-marked="true"]')], ["הועמסו 2 מתוך 3 · בתהליך", 2]);
  check("the driver cannot undo a mark and cannot leave with a delivery missing", [await count(driver, `[data-delivery="${a.number}"] button`), (await text(driver, "[data-missing]")).includes("חסרות 1"), await count(driver, "#depart form")], [0, true, 0]);

  // ---------- who else sees the route
  const other = await signIn(otherDriverMobile);
  await go(other, work, "main h1");
  check("another driver cannot open this route", await text(other, "main h1"), "הקו לא נמצא");
  await go(other, "/drive", "main h1");
  check("and their own list is empty", await count(other, "[data-work-route]"), 0);
  const loader = await signIn(loaderMobile);
  await go(loader, work, "#route-state");
  check("a loading manager can load but cannot approve leaving with a delivery missing", [await count(loader, `[data-delivery="${c.number}"] button`), await count(loader, "#depart form")], [1, 0]);

  // ---------- the manager approves leaving without the missing delivery
  await go(admin, work, "#depart");
  await admin.fill("#depart [name=reason]", `הייצור מתעכב ${tag}`);
  await admin.click("#depart button");
  await admin.waitForSelector('#route-state[data-mode="unloading"]');
  check("the route switches to delivery mode, in delivery order, without the delivery left behind", [await text(admin, "#progress"), await stopNames(admin), (await text(admin, "#route-state")).includes(`הייצור מתעכב ${tag}`)], ["נמסרו 0 מתוך 2 · טרם התחיל", [a.name, b.name], true]);
  await go(admin, `/shipping?date=${DAY}`, "[data-route-card]");
  check("the board shows delivery progress, and what was left behind is waiting again", [await text(admin, `[data-route-card="${ROUTE}"] [data-progress]`), await count(admin, `[data-unassigned="${c.number}"]`)], ["הפצה · הועמסו 2/2 · נמסרו 0/2", 1]);
  // ---------- alerts and exceptions
  check("the board points at the open alerts", Number(await admin.locator("#alerts-link").getAttribute("data-open")) >= 2, true);
  await go(admin, "/shipping/alerts", "#alerts-summary");
  const leftAlert = admin.locator('[data-alert="left_behind"]', { hasText: `הזמנה ${c.number}` });
  check("the delivery left behind is an urgent alert with the reason", [await leftAlert.count(), await leftAlert.getAttribute("data-severity"), (await leftAlert.textContent()).includes(`הייצור מתעכב ${tag}`)], [1, "high", true]);
  check("the departure without everything is reported too", await admin.locator('[data-alert="departed_with_missing"]', { hasText: `הייצור מתעכב ${tag}` }).count(), 1);
  await leftAlert.locator("[name=note]").fill(`שובץ מחדש ${tag}`);
  await leftAlert.locator("button").click();
  await admin.waitForFunction((n) => ![...document.querySelectorAll('[data-alert="left_behind"]')].some((li) => li.textContent.includes(`הזמנה ${n}`)), c.number);
  check("marking it handled moves it to the handled list with what was done", (await text(admin, "[data-handled]")).includes(`שובץ מחדש ${tag}`), true);

  await go(admin, a.url, '[data-delivery="0"]');
  check("the order shows that it left", await text(admin, '[data-delivery="0"] [data-delivery-status]'), "יצאה לשילוח");

  // ---------- the driver hands over
  await go(driver, work, "#route-state");
  check("each stop has a Waze link built from its address", (await driver.locator("[data-waze]").first().getAttribute("href")).startsWith("https://waze.com/ul?q="), true);
  await tap(driver, a.number, "true");
  check("one handed over", await text(driver, "#progress"), "נמסרו 1 מתוך 2 · בתהליך");
  await go(admin, work, "#route-state");
  await tap(admin, a.number, "false");
  check("a manager can undo a hand-over", await text(admin, "#progress"), "נמסרו 0 מתוך 2 · טרם התחיל");
  await go(driver, work, "#route-state");
  await tap(driver, a.number, "true");
  await tap(driver, b.number, "true");
  check("everything handed over", await text(driver, "#progress"), "נמסרו 2 מתוך 2 · הושלם");
  await go(admin, a.url, '[data-delivery="0"]');
  check("the order shows that it was delivered", await text(admin, '[data-delivery="0"] [data-delivery-status]'), "סופקה");
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  if (made) {
    try {
      // Alerts that belong to test routes (from this run or from earlier ones) are marked handled, so the real screen stays clean.
      await go(admin, "/shipping/alerts", "#alerts-summary");
      const mine = '[data-alerts] li:has-text("קו בדיקה") button';
      for (let n = await count(admin, mine); n > 0; n = await count(admin, mine)) {
        await admin.locator(mine).first().click();
        await admin.waitForFunction(([sel, before]) => document.querySelectorAll(sel).length < before, ['[data-alerts] li button', await count(admin, '[data-alerts] li button')]);
      }
      await go(admin, "/shipping/routes", "#new-route");
      if ((await count(admin, `${routeCard}[data-active="true"]`)) > 0) {
        await admin.locator(`${routeCard} button:has-text("הפסק להשתמש בקו")`).click();
        await admin.waitForSelector(`${routeCard}[data-active="false"]`);
      }
      await go(admin, "/shipping/drivers", "#new-driver");
      if ((await count(admin, `${driverCard}[data-active="true"]`)) > 0) {
        await admin.locator(`${driverCard} button:has-text("סמן כלא פעיל")`).click();
        await admin.waitForSelector(`${driverCard}[data-active="false"]`);
      }
    } catch {
      console.log("WARNING: the test route or driver may still be active. Switch them off at /shipping/routes and /shipping/drivers.");
    }
  }
  await browser.close();
}
console.log(failed ? `E2E LOADING FAILED (${failed})` : "E2E LOADING PASSED");
process.exit(failed ? 1 : 0);
