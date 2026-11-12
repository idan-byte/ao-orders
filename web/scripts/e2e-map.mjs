// End-to-end check in headless Edge of the route map: the stops list, placing an address on the map by hand,
// correcting it, and cancelling the manual location. The address search itself is never pressed here, so no
// address leaves the machine; map tiles are blocked too (set AO_SCREENSHOT=path to load them and save a picture).
// The test keeps one route ("קו בדיקה מפה") and switches it off at the end. Locations it placed are removed.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-map.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const ROUTE = "קו בדיקה מפה";
const SHOT = process.env.AO_SCREENSHOT;
const DAY = new Date(Date.UTC(3600 + Math.floor(Math.random() * 200), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 20))).toISOString().slice(0, 10);
const routeCard = `[data-route="${ROUTE}"]`;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ locale: "he-IL", viewport: { width: 1280, height: 900 } });
if (!SHOT) await context.route(/tile\.openstreetmap\.org/, (r) => r.abort());
const admin = await context.newPage();
admin.on("dialog", (d) => d.accept());
await admin.goto(BASE + "/login");
await admin.fill("#mobile", ADMIN);
await admin.click("button[value=request]");
await admin.waitForSelector("form b");
await admin.fill("#code", (await admin.locator("form b").textContent()).trim());
await admin.click("button[value=verify]");
await admin.waitForURL((u) => !u.pathname.startsWith("/login"));

const count = (sel) => admin.locator(sel).count();
const text = async (sel) => (await admin.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const go = async (path, wait) => {
  await admin.goto(BASE + path);
  await admin.waitForSelector(wait);
};
let customerIndex = 0;
async function newOrder() {
  for (;;) {
    await go("/orders/new", "#order-customer");
    await admin.selectOption("#order-customer", { index: ++customerIndex });
    await admin.click("text=המשך");
    await admin.waitForSelector("#q-add-line");
    if ((await count("#q-address option")) < 2) continue;
    await admin.selectOption("#q-address", { index: 1 });
    await admin.click("#q-add-line");
    await admin.selectOption('[data-line-sku="0"]', "50088");
    await admin.fill('[data-line-qty="0"]', "10");
    await admin.fill('[data-line-price="0"]', "5");
    await admin.fill("#q-delivery-date", DAY);
    await admin.click("button[value=save]");
    await admin.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
    await admin.waitForSelector('[data-delivery="0"]');
    return (await text("main h1")).match(/\d{3,}/)[0];
  }
}
const stopSel = (n) => `[data-map-stop="${n}"]:visible`;
const location = (n) => admin.locator(stopSel(n)).getAttribute("data-location");
const clickMap = async (x, y) => admin.locator("#route-map:visible").click({ position: { x, y } });

let made = false;
const placed = [];
try {
  // ---------- a route with two stops
  await go("/shipping/routes", "#new-route");
  if ((await count(routeCard)) === 0) {
    await admin.fill("#new-route [name=name]", ROUTE);
    await admin.click("#new-route button");
    await admin.waitForSelector(routeCard);
  } else if ((await admin.locator(routeCard).getAttribute("data-active")) === "false") {
    await admin.locator(`${routeCard} button:has-text("החזר לשימוש")`).click();
    await admin.waitForSelector(`${routeCard}[data-active="true"]`);
  }
  made = true;
  const orders = [await newOrder(), await newOrder()];
  await go(`/shipping?date=${DAY}`, "#unassigned");
  for (const number of orders) {
    const row = admin.locator(`[data-unassigned="${number}"]`);
    await row.locator("select").selectOption({ label: ROUTE });
    await row.locator("[name=permanent]").setChecked(false);
    await row.locator("button").click();
    await admin.waitForFunction((n) => !document.querySelector(`[data-unassigned="${n}"]`), number);
  }
  await go(`/shipping?date=${DAY}`, "[data-route-card]");
  const dayUrl = await admin.locator(`[data-route-card="${ROUTE}"]`).getAttribute("href");

  // ---------- the map screen
  await go(dayUrl, "#map-link");
  await admin.click("#map-link");
  await admin.waitForURL(/\/map$/);
  await admin.waitForSelector('#route-map[data-ready="true"]');
  check("the map screen opens from the route's page", await text("main h1:visible"), `מפת הקו · ${ROUTE}`);
  check("both stops are listed in delivery order", await admin.locator("[data-map-stop]:visible").evaluateAll((l) => l.map((e) => e.getAttribute("data-map-stop"))), ["1", "2"]);
  const before = [await location(1), await location(2)];
  if (before.some((l) => l !== "pending" && l !== "not_found")) {
    console.log("SKIPPED placing checks: the addresses of the test orders already have a location, and the test must not change it.");
  } else {
    check("the summary counts what is on the map", (await text("#map-summary")).endsWith("2 עצירות, 0 מהן על המפה"), true);
    check("the address search is offered, and says what it sends", [(await count("#locate button")) === 1, (await text("#locate")).includes("בלי שם הלקוח")], [true, true]);
    check("no markers before anything is located", await count("#route-map:visible .route-pin"), 0);

    // ---------- placing by hand
    await admin.locator(`${stopSel(1)} [data-place]`).click();
    await admin.waitForSelector("#place-form");
    check("saving is not possible before a point is chosen", await admin.locator("#place-form button:has-text('שמור מיקום')").isDisabled(), true);
    await clickMap(300, 200);
    await admin.waitForSelector("#route-map .route-pin-new");
    placed.push(1);
    await admin.click("#place-form button:has-text('שמור מיקום')");
    await admin.waitForSelector(`${stopSel(1)}[data-location="manual"]`);
    await admin.waitForFunction(() => document.querySelectorAll("#route-map .route-pin:not(.route-pin-new)").length === 1 && !document.querySelector("#place-form"));
    check("the stop is on the map with its number", [await text("#route-map:visible .route-pin"), (await text(stopSel(1))).includes("מוקם ידנית")], ["1", true]);
    check("the summary follows", (await text("#map-summary")).endsWith("2 עצירות, 1 מהן על המפה"), true);

    await admin.locator(`${stopSel(2)} [data-place]`).click();
    await admin.waitForSelector("#place-form");
    await admin.locator("#place-form button:has-text('בטל')").click();
    check("placing can be cancelled without saving", [await count("#place-form"), await location(2)], [0, before[1]]);
    await admin.locator(`${stopSel(2)} [data-place]`).click();
    await admin.waitForSelector("#place-form");
    await clickMap(500, 350);
    await admin.waitForSelector("#route-map .route-pin-new");
    placed.push(2);
    await admin.click("#place-form button:has-text('שמור מיקום')");
    await admin.waitForSelector(`${stopSel(2)}[data-location="manual"]`);
    await admin.waitForFunction(() => document.querySelectorAll("#route-map .route-pin:not(.route-pin-new)").length === 2);
    check("two stops on the map, joined by a line", [await admin.locator("#route-map:visible .route-pin").allTextContents(), await count("#route-map:visible path.leaflet-interactive")], [["1", "2"], 1]);
    check("nothing is left to search once every address is placed", await count("#locate"), 0);

    // ---------- the location survives a reload
    await go(new URL(admin.url()).pathname, '#route-map[data-ready="true"]');
    await admin.waitForFunction(() => document.querySelectorAll("#route-map .route-pin").length === 2);
    check("locations are kept after reloading", [await location(1), await location(2)], ["manual", "manual"]);
    if (SHOT) {
      await admin.waitForLoadState("networkidle");
      await admin.screenshot({ path: SHOT, fullPage: true });
    }

    // ---------- cancelling a manual location
    await admin.locator(`${stopSel(2)} [data-clear]`).click();
    await admin.waitForSelector(`${stopSel(2)}[data-location="pending"]`);
    placed.splice(placed.indexOf(2), 1);
    await admin.waitForFunction(() => document.querySelectorAll("#route-map .route-pin").length === 1);
    check("cancelling takes the stop off the map and offers the search again", [await count("#route-map:visible .route-pin"), await count("#locate button")], [1, 1]);
  }
} finally {
  try {
    for (const n of [...placed]) {
      if ((await count(`${stopSel(n)} [data-clear]`)) > 0) {
        await admin.locator(`${stopSel(n)} [data-clear]`).click();
        await admin.waitForSelector(`${stopSel(n)}[data-location="pending"]`);
      }
    }
  } catch {
    console.log("WARNING: a test location may be left on a customer's address. Open the test route's map and press 'בטל מיקום ידני'.");
  }
  if (made) {
    try {
      await go("/shipping/routes", "#new-route");
      if ((await count(`${routeCard}[data-active="true"]`)) > 0) {
        await admin.locator(`${routeCard} button:has-text("הפסק להשתמש בקו")`).click();
        await admin.waitForSelector(`${routeCard}[data-active="false"]`);
      }
    } catch {
      console.log("WARNING: the test route may still be active. Switch it off at /shipping/routes.");
    }
  }
  await browser.close();
}
console.log(failed ? `E2E MAP FAILED (${failed})` : "E2E MAP PASSED");
process.exit(failed ? 1 : 0);
