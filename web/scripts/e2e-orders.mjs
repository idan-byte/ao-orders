// End-to-end check of orders in headless Edge: manual entry, list and filters, order card, change with history,
// status path, exception, cancellation, an order born from a quote, and roles (including server-side pricing).
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-orders.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const tag = Date.now() % 1000000;
// A far-future date nobody else uses, so the list filter can be checked exactly.
const pick = (n) => Math.floor(Math.random() * n);
const DAY1 = `${2040 + pick(50)}-${String(pick(12) + 1).padStart(2, "0")}-${String(pick(27) + 1).padStart(2, "0")}`;
const DAY2 = `${Number(DAY1.slice(0, 4)) + 1}-${DAY1.slice(5)}`;

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
  await page.waitForURL(BASE + "/");
  return page;
}
const count = (page, sel) => page.locator(sel).count();
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").trim();
const digits = (s) => s.replace(/[^\d.]/g, "");
const waitStatus = (page, i, label) => page.waitForFunction(([i, l]) => document.querySelector(`[data-delivery="${i}"] [data-delivery-status]`)?.textContent.trim() === l, [i, label]);
async function addLine(page, i, sku, qty, price, date) {
  await page.click("#q-add-line");
  await page.selectOption(`[data-line-sku="${i}"]`, sku);
  await page.fill(`[data-line-qty="${i}"]`, String(qty));
  if (price !== undefined) await page.fill(`[data-line-price="${i}"]`, String(price));
  if (date) await page.fill(`[data-line-date="${i}"]`, date);
}
async function startOrder(page) {
  await page.goto(BASE + "/orders/new");
  await page.waitForSelector("#order-customer");
  await page.selectOption("#order-customer", { index: 1 });
  await page.click("text=המשך");
  await page.waitForSelector("#q-add-line");
}

try {
  const admin = await signIn(ADMIN);

  // ---------- manual entry
  await startOrder(admin);
  check("order form has no quote-only fields", [await admin.locator("#q-valid-until").isVisible(), await admin.locator("#q-payment-terms").isVisible(), await count(admin, "button[value=send]")], [false, false, 0]);
  await admin.click("button[value=save]");
  await admin.waitForSelector("form [role=alert]");
  check("empty order is refused", (await text(admin, "form [role=alert]")).includes("בלי פריטים"), true);
  await addLine(admin, 0, "50002", 60, 8);
  await addLine(admin, 1, "50088", 40, 5);
  await addLine(admin, 2, "50002", 100, 8, DAY2);
  await admin.click("button[value=save]");
  // The earlier alert is still on screen, so wait for its text to change rather than for it to exist.
  await admin.waitForFunction(() => document.querySelector("form [role=alert]")?.textContent.includes("תאריך אספקה"));
  check("order without a delivery date is refused", (await text(admin, "form [role=alert]")).includes("תאריך אספקה"), true);
  await admin.fill("#q-delivery-date", DAY1);
  await admin.fill("#q-window-from", "07:00");
  await admin.fill("#q-window-to", "09:00");
  await admin.fill("#q-internal-notes", "בלי חמוצים " + tag);
  await admin.fill("#q-customer-notes", "למסור בשער 3");
  // 480 + 200 + 800 = 1480; VAT 18% = 266.40; total 1746.40
  check("live total", digits(await text(admin, "#q-total")), "1746.40");
  await admin.click("button[value=save]");
  await admin.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = admin.url();
  await admin.waitForSelector("[data-delivery]");
  check("order card: status, two deliveries, total", [await text(admin, "#order-status"), await count(admin, "[data-delivery]"), digits(await text(admin, "#order-total"))], ["מאושרת", 2, "1746.40"]);
  check("notes reach production and shipping", [(await admin.content()).includes("הערות לייצור: בלי חמוצים " + tag), (await admin.content()).includes("הערות לשילוח: למסור בשער 3")], [true, true]);

  // ---------- list and filters
  await admin.goto(`${BASE}/orders?from=${DAY1}&to=${DAY1}`);
  await admin.waitForSelector("[data-day]");
  check("list filtered to one day shows exactly that delivery", [await count(admin, "[data-day]"), await count(admin, "main table tbody tr"), (await text(admin, "main table tbody tr")).includes("07:00–09:00")], [1, 1, true]);
  await admin.goto(`${BASE}/orders?from=${DAY1}&to=${DAY2}&q=${encodeURIComponent("קוקטיל")}`);
  await admin.waitForSelector("[data-day]");
  check("search by product finds only the delivery that has it", await count(admin, "main table tbody tr"), 1);
  await admin.goto(`${BASE}/orders?from=${DAY1}&to=${DAY2}&status=cancelled`);
  await admin.waitForSelector("main section p");
  check("status filter with no match", await count(admin, "main table tbody tr"), 0);

  // ---------- change with history
  await admin.goto(orderUrl);
  await admin.locator('[data-delivery="0"] [data-edit]').click();
  await admin.waitForSelector('[data-line-qty="1"]');
  check("edit form hides order-level fields", [await admin.locator("#q-discount").isVisible(), await admin.locator('[data-line-date="0"]').isVisible()], [false, false]);
  await admin.fill('[data-line-qty="0"]', "80");
  await admin.fill("#q-window-to", "08:30");
  await admin.click("button[value=save]");
  await admin.waitForURL(orderUrl);
  await admin.waitForSelector('[data-delivery="0"] [data-history]');
  const hist = await text(admin, '[data-delivery="0"] [data-history]');
  check("history says what changed", [hist.includes("כמות 50002: 60 ← 80"), hist.includes("עד שעה: 09:00 ← 08:30")], [true, true]);
  check("total follows the change", digits(await text(admin, "#order-total")), "1935.20"); // +20 x 8 = 160, +18%

  // ---------- status path
  await admin.locator('[data-delivery="0"] [data-advance]').click();
  await waitStatus(admin, 0, "בייצור");
  check("order status is the earliest stage among deliveries", await text(admin, "#order-status"), "מאושרת");
  await admin.locator('[data-delivery="0"] [data-advance]').click();
  await waitStatus(admin, 0, "מוכנה לשילוח");
  check("ready to ship: no further button, no edit", [await count(admin, '[data-delivery="0"] [data-advance]'), await count(admin, '[data-delivery="0"] [data-edit]')], [0, 0]);

  // ---------- exception and release
  await admin.locator('[data-delivery="1"] [data-hold-note]').fill("הלקוח ביקש להקדים " + tag);
  await admin.locator('[data-delivery="1"] >> text=סמן').last().click();
  await waitStatus(admin, 1, "חריגה לטיפול");
  check("exception flags the whole order", [await text(admin, "#order-status"), (await admin.content()).includes("חריגה: הלקוח ביקש להקדים " + tag)], ["חריגה לטיפול", true]);
  await admin.locator('[data-delivery="1"] [data-release]').click();
  await waitStatus(admin, 1, "מאושרת");

  // ---------- cancellation
  await admin.locator('[data-delivery="1"] [data-cancel-reason]').fill("הלקוח ביטל את היום השני");
  await admin.locator('[data-delivery="1"] >> text=בטל אספקה').click();
  await waitStatus(admin, 1, "מבוטלת");
  check("cancelled delivery: reason shown, no actions, out of the total", [(await admin.content()).includes("סיבת הביטול: הלקוח ביטל את היום השני"), await count(admin, '[data-delivery="1"] [data-advance]'), await count(admin, '[data-delivery="1"] [data-edit]'), digits(await text(admin, "#order-total"))], [true, 0, 0, "991.20"]);
  check("order status ignores the cancelled delivery", await text(admin, "#order-status"), "מוכנה לשילוח");
  check("every status change is in the history", (await text(admin, '[data-delivery="1"] [data-history]')).split("←").length - 1, 3);

  // ---------- an order born from an approved quote shows up as an order
  await admin.goto(BASE + "/quotes");
  await admin.waitForSelector("#new-quote-customer");
  await admin.selectOption("#new-quote-customer", { index: 1 });
  await admin.click("text=פתח הצעה");
  await admin.waitForSelector("#q-add-line");
  await addLine(admin, 0, "50002", 10, 8);
  await admin.fill("#q-delivery-date", DAY1);
  await admin.click("button[value=send]");
  await admin.waitForSelector("#manual-approver");
  await admin.fill("#manual-approver", "דנה, בטלפון");
  await admin.click("text=אשר ופתח הזמנה");
  await admin.waitForSelector("#quote-approved");
  const orderNumber = (await text(admin, "#quote-approved")).match(/הזמנה\s*(\d{4,})/)[1];
  await admin.goto(`${BASE}/orders?from=${DAY1}&to=${DAY1}&q=${orderNumber}`);
  await admin.waitForSelector("main table tbody tr a");
  await admin.click("main table tbody tr a");
  await admin.waitForSelector("#order-status");
  check("order from a quote: source and link back", [(await admin.content()).includes("מקור: הצעת מחיר"), await count(admin, "a:has-text('הצעה ')") > 0], [true, true]);

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
  const clerk = rnd(), manager = rnd(), worker = rnd();
  await add("עובד הזמנות ז " + tag, clerk, "order_clerk");
  await add("מנהל מחלקה ז " + tag, manager, "dept_manager");
  await add("עובד ייצור ז " + tag, worker, "production_worker");

  // An order clerk may enter orders but not set prices: whatever price the browser sends, the server prices the line itself.
  const c = await signIn(clerk);
  await startOrder(c);
  await addLine(c, 0, "50002", 10, undefined);
  const serverPrice = Number(await c.inputValue('[data-line-price="0"]'));
  await c.fill('[data-line-price="0"]', "0.01");
  await c.fill("#q-discount", "90");
  await c.fill("#q-delivery-date", DAY1);
  await c.click("button[value=save]");
  await c.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await c.waitForSelector("#order-total");
  const expected = (Math.round(serverPrice * 10 * 100) / 100 * 1.18).toFixed(2);
  check("order clerk cannot underprice: server uses the customer's price and drops the discount", [serverPrice > 0, Number(digits(await text(c, "#order-total"))).toFixed(2)], [true, Number(expected).toFixed(2)]);
  check("order clerk cannot cancel", await count(c, "[data-cancel-reason]"), 0);

  const m = await signIn(manager);
  await m.goto(orderUrl);
  await m.waitForSelector("[data-delivery]");
  check("department manager sees the order without prices and without actions", [await count(m, "#order-totals"), /₪|מחיר/.test(await m.locator("main").innerText()), await count(m, "[data-advance]"), await count(m, "[data-edit]")], [0, false, 0, 0]);
  await m.goto(BASE + "/orders/new");
  await m.waitForSelector("main h1");
  check("department manager cannot open an order", await text(m, "main h1"), "אין הרשאה למסך הזה");
  const w = await signIn(worker);
  await w.goto(BASE + "/orders");
  await w.waitForSelector("main h1");
  check("production worker: orders refused", await text(w, "main h1"), "אין הרשאה למסך הזה");
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E ORDERS FAILED (${failed})` : "E2E ORDERS PASSED");
process.exit(failed ? 1 : 0);
