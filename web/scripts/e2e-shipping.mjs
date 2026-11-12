// End-to-end check in headless Edge of distribution planning: drivers and vehicles, routes, the daily board,
// manual and permanent assignment, stop order, loading order, the driver of the day, and roles.
// The test keeps two routes ("קו בדיקה א", "קו בדיקה ב") and one driver ("נהג בדיקה") and switches them off at the end.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-shipping.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const [RA, RB, DRIVER] = ["קו בדיקה א", "קו בדיקה ב", "נהג בדיקה"];
const tag = Date.now() % 1000000;
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const first = new Date(Date.UTC(3000 + Math.floor(Math.random() * 200), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 20)));
const DAY = first.toISOString().slice(0, 10);
const DAY2 = new Date(first.getTime() + 86400_000).toISOString().slice(0, 10);

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
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const routeCard = (name) => `[data-route="${name}"]`;
const driverCard = `[data-driver="${DRIVER}"]`;
// Customer names can contain quotation marks (בע"מ), which must be escaped inside a selector.
const esc = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const admin = await signIn(ADMIN);
const go = async (path, wait) => {
  await admin.goto(BASE + path);
  await admin.waitForSelector(wait);
};
// Opens a new order for the n-th customer in the list that has a delivery address. Returns the customer's name.
let customerIndex = 0;
async function orderForNextCustomerWithAddress(date, reuseIndex) {
  for (;;) {
    const index = reuseIndex ?? ++customerIndex;
    await go("/orders/new", "#order-customer");
    await admin.selectOption("#order-customer", { index });
    const name = (await admin.locator("#order-customer option:checked").textContent()).trim();
    await admin.click("text=המשך");
    await admin.waitForSelector("#q-add-line");
    if ((await count(admin, "#q-address option")) < 2) {
      if (reuseIndex) throw new Error("customer lost its address");
      continue;
    }
    await admin.selectOption("#q-address", { index: 1 });
    await admin.click("#q-add-line");
    await admin.selectOption('[data-line-sku="0"]', "50088");
    await admin.fill('[data-line-qty="0"]', "10");
    await admin.fill('[data-line-price="0"]', "5");
    await admin.fill("#q-delivery-date", date);
    await admin.click("button[value=save]");
    await admin.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
    await admin.waitForSelector('[data-delivery="0"]');
    const number = (await text(admin, "main h1")).match(/\d{3,}/)[0];
    return { name, index, number };
  }
}
const assign = async (number, route, permanent) => {
  const row = admin.locator(`[data-unassigned="${number}"]`);
  await row.locator("select").selectOption({ label: route });
  await row.locator("[name=permanent]").setChecked(permanent);
  await row.locator("button").click();
  await admin.waitForFunction((n) => !document.querySelector(`[data-unassigned="${n}"]`), number);
};
const stopNames = () => admin.locator("[data-stop]:visible [data-stop-customer]").allTextContents().then((l) => l.map((s) => s.trim()));

let made = false;
let permanentCustomer = null;
try {
  check("the menu has a shipping screen", (await admin.locator("header nav a").allTextContents()).includes("שילוח"), true);

  // ---------- driver and vehicle
  await go("/shipping/drivers", "#new-driver");
  if ((await count(admin, driverCard)) === 0) {
    await admin.fill("#new-driver [name=name]", DRIVER);
    await admin.fill("#new-driver [name=registration]", "אבג");
    await admin.click("#new-driver button");
    await admin.waitForSelector("#new-driver [role=alert]");
    check("a vehicle number with letters is refused", (await text(admin, "#new-driver [role=alert]")).includes("מספר הרכב"), true);
    // The form is cleared after it is submitted, so everything is typed again.
    await admin.fill("#new-driver [name=name]", DRIVER);
    await admin.fill("#new-driver [name=phone]", "050-1112233");
    await admin.fill("#new-driver [name=registration]", "99-999-01");
    await admin.click("#new-driver button");
    await admin.waitForSelector(driverCard);
  } else if ((await admin.locator(driverCard).getAttribute("data-active")) === "false") {
    await admin.locator(`${driverCard} button:has-text("החזר לפעילות")`).click();
    await admin.waitForSelector(`${driverCard}[data-active="true"]`);
  }
  made = true;
  check("the driver is listed with phone and vehicle", [await admin.locator(`${driverCard} [name=phone]`).inputValue(), await admin.locator(`${driverCard} [name=registration]`).inputValue()], ["0501112233", "99-999-01"]);

  // ---------- routes
  await go("/shipping/routes", "#new-route");
  for (const name of [RA, RB]) {
    if ((await count(admin, routeCard(name))) === 0) {
      await admin.fill("#new-route [name=name]", name);
      await admin.click("#new-route button");
      await admin.waitForSelector(routeCard(name));
    } else if ((await admin.locator(routeCard(name)).getAttribute("data-active")) === "false") {
      await admin.locator(`${routeCard(name)} button:has-text("החזר לשימוש")`).click();
      await admin.waitForSelector(`${routeCard(name)}[data-active="true"]`);
    }
    await go("/shipping/routes", "#new-route");
    // Leftovers of an earlier run that did not finish: the test routes start with no permanent addresses.
    while ((await count(admin, `${routeCard(name)} button[value=remove]`)) > 0) {
      const before = await count(admin, `${routeCard(name)} button[value=remove]`);
      await admin.locator(`${routeCard(name)} button[value=remove]`).first().click();
      await admin.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length < n, [`${routeCard(name)} button[value=remove]`, before]);
    }
  }
  await admin.locator(`${routeCard(RA)} [name=driver_id]`).selectOption({ label: DRIVER });
  await admin.locator(`${routeCard(RA)} form:has([name=name]) button`).click();
  await admin.waitForSelector(`${routeCard(RA)} form:has([name=name]) [role=status]`);
  await admin.fill("#new-route [name=name]", RA);
  await admin.click("#new-route button");
  await admin.waitForSelector("#new-route [role=alert]");
  check("two routes cannot share a name", (await text(admin, "#new-route [role=alert]")).includes("כבר קיים"), true);

  // ---------- the daily board
  const a = await orderForNextCustomerWithAddress(DAY);
  const b = await orderForNextCustomerWithAddress(DAY);
  const c = await orderForNextCustomerWithAddress(DAY);
  await go(`/shipping?date=${DAY}`, "#unassigned");
  check("new deliveries wait on the board, and no route is open yet", [await count(admin, "[data-unassigned]"), await count(admin, "[data-route-card]")], [3, 0]);
  await admin.click("#plan-day button");
  await admin.waitForSelector("#plan-day [role=status]");
  check("planning reports what it could not place", (await text(admin, "#plan-day [role=status]")).includes("3 אספקות ממתינות לשיבוץ ידני"), true);
  await assign(a.number, RA, true);
  permanentCustomer = a.name;
  await assign(b.number, RA, false);
  await assign(c.number, RB, false);
  await go(`/shipping?date=${DAY}`, "[data-route-card]");
  check("route cards show the driver and the counts", [await text(admin, `[data-route-card="${RA}"] [data-driver]`), await text(admin, `[data-route-card="${RA}"] [data-counts]`), await text(admin, `[data-route-card="${RB}"] [data-driver]`), await count(admin, "[data-unassigned]")], [DRIVER, "2 עצירות · 2 אספקות · 10 יח׳ · 10 יח׳".replace(" · 10 יח׳ · 10 יח׳", " · 20 יח׳"), "לא נבחר נהג", 0]);

  // ---------- route detail: order of stops, loading order, driver of the day, transfer
  await admin.click(`[data-route-card="${RA}"]`);
  await admin.waitForSelector("[data-stop]");
  const routeUrl = admin.url();
  check("stops are listed in the order they were placed", await stopNames(), [a.name, b.name]);
  await admin.locator('[data-stop="1"] button[value=down]').click();
  await admin.waitForFunction((n) => document.querySelector('[data-stop="1"] [data-stop-customer]')?.textContent.trim() === n, b.name);
  check("a stop can be moved later for the day", await stopNames(), [b.name, a.name]);
  await admin.click("text=סדר טעינה");
  await admin.waitForSelector('[data-order="loading"]');
  check("loading order is the delivery order reversed", await stopNames(), [a.name, b.name]);
  await admin.goto(routeUrl);
  await admin.waitForSelector("#daily-driver");
  check("the header shows the driver and the vehicle", [(await text(admin, "#route-summary")).includes(DRIVER), (await text(admin, "#route-summary")).includes("99-999-01")], [true, true]);
  await admin.locator("#daily-driver select").selectOption("");
  await admin.click("#daily-driver button");
  await admin.waitForSelector("#daily-driver [role=status]");
  await admin.goto(routeUrl);
  await admin.waitForSelector("#route-summary");
  check("the driver of the day can be cleared without touching the permanent route", (await text(admin, "#route-summary")).includes("לא נבחר נהג"), true);
  await admin.locator(`[data-delivery="${b.number}"] select`).selectOption({ label: `לקו ${RB}` });
  await admin.locator(`[data-delivery="${b.number}"] button`).click();
  await admin.waitForFunction((n) => !document.querySelector(`[data-delivery="${n}"]`), b.number);
  check("a delivery can be moved to another route for the day", await stopNames(), [a.name]);
  await go(`/shipping?date=${DAY}`, "[data-route-card]");
  check("the other route received it", (await text(admin, `[data-route-card="${RB}"] [data-counts]`)).startsWith("2 עצירות · 2 אספקות"), true);

  // ---------- a permanent assignment plans itself the next day
  await go("/shipping/routes", "#new-route");
  check("the address marked as permanent is on the route; the others are not", [await count(admin, `${routeCard(RA)} [data-address="${esc(a.name)}"]`), await count(admin, `${routeCard(RA)} [data-address="${esc(b.name)}"]`), (await text(admin, `${routeCard(RA)} form:has([name=name])`)).length > 0], [1, 0, true]);
  check("and the route kept its permanent driver", await admin.locator(`${routeCard(RA)} [name=driver_id] option:checked`).textContent(), DRIVER);
  await orderForNextCustomerWithAddress(DAY2, a.index);
  await orderForNextCustomerWithAddress(DAY2, b.index);
  await go(`/shipping?date=${DAY2}`, "#unassigned");
  await admin.click("#plan-day button");
  await admin.waitForSelector("#plan-day [role=status]");
  check("the next day, planning places the permanent address by itself", [(await text(admin, "#plan-day [role=status]")).startsWith("שובצו 1 אספקות"), await count(admin, `[data-route-card="${RA}"]`), await count(admin, "[data-unassigned]")], [true, 1, 1]);
  await admin.click("#plan-day button");
  await admin.waitForFunction(() => document.querySelector("#plan-day [role=status]")?.textContent.includes("לא היו אספקות חדשות"));
  check("planning twice places nothing twice", (await text(admin, `[data-route-card="${RA}"] [data-counts]`)).startsWith("1 עצירות · 1 אספקות"), true);

  // ---------- take the address off the permanent route again
  await go("/shipping/routes", "#new-route");
  await admin.locator(`${routeCard(RA)} [data-address="${esc(a.name)}"] button[value=remove]`).click();
  await admin.waitForFunction(([r, n]) => !document.querySelector(`[data-route="${r}"] [data-address="${n}"]`), [RA, esc(a.name)]);
  permanentCustomer = null;
  check("an address can be taken off its permanent route", await count(admin, `${routeCard(RA)} [data-address="${esc(a.name)}"]`), 0);

  // ---------- roles
  const add = async (name, role) => {
    const mobile = rnd();
    await go("/users", "#new-user-name");
    await admin.fill("#new-user-name", name);
    await admin.fill("#new-user-mobile", mobile);
    await admin.selectOption("#new-user-role", role);
    await admin.click("text=הוסף משתמש");
    await admin.waitForSelector(`text=${name}`);
    return signIn(mobile);
  };
  const manager = await add(`שילוח ${tag}`, "shipping_manager");
  await manager.goto(`${BASE}/shipping?date=${DAY}`);
  await manager.waitForSelector("[data-route-card]");
  check("shipping manager: sees the board and has it in the menu", [await count(manager, "[data-route-card]"), (await manager.locator("header nav a").allTextContents()).includes("שילוח")], [2, true]);
  const clerk = await add(`פקיד ${tag}`, "order_clerk");
  await clerk.goto(BASE + "/shipping");
  await clerk.waitForSelector("main h1");
  check("order clerk: no shipping board and no menu item", [await text(clerk, "main h1"), (await clerk.locator("header nav a").allTextContents()).includes("שילוח")], ["אין הרשאה למסך הזה", false]);
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  if (made) {
    try {
      await go("/shipping/routes", "#new-route");
      if (permanentCustomer && (await count(admin, `${routeCard(RA)} [data-address="${esc(permanentCustomer)}"]`)) > 0) {
        await admin.locator(`${routeCard(RA)} [data-address="${esc(permanentCustomer)}"] button[value=remove]`).click();
        await admin.waitForFunction(([r, n]) => !document.querySelector(`[data-route="${r}"] [data-address="${n}"]`), [RA, esc(permanentCustomer)]);
      }
      for (const name of [RA, RB]) {
        if ((await count(admin, `${routeCard(name)}[data-active="true"]`)) > 0) {
          await admin.locator(`${routeCard(name)} button:has-text("הפסק להשתמש בקו")`).click();
          await admin.waitForSelector(`${routeCard(name)}[data-active="false"]`);
        }
      }
      await go("/shipping/drivers", "#new-driver");
      if ((await count(admin, `${driverCard}[data-active="true"]`)) > 0) {
        await admin.locator(`${driverCard} button:has-text("סמן כלא פעיל")`).click();
        await admin.waitForSelector(`${driverCard}[data-active="false"]`);
      }
    } catch {
      console.log("WARNING: the test routes or driver may still be active. Switch them off at /shipping/routes and /shipping/drivers.");
    }
  }
  await browser.close();
}
console.log(failed ? `E2E SHIPPING FAILED (${failed})` : "E2E SHIPPING PASSED");
process.exit(failed ? 1 : 0);
