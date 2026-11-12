// End-to-end check of standing orders in headless Edge: weekly template, generation, idempotency, a skipped
// day, a closed day, a pause, the generated orders reaching the orders list and the production plan, and roles.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-standing.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const tag = Date.now() % 1000000;
// A random far-future week, starting on a Sunday, that no other run is likely to share.
const first = new Date(Date.UTC(2040 + Math.floor(Math.random() * 50), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 20)));
first.setUTCDate(first.getUTCDate() + ((7 - first.getUTCDay()) % 7));
const day = (n) => new Date(first.getTime() + n * 86400_000).toISOString().slice(0, 10);
const [SUN, TUE, WED, THU, SAT, NEXT_SUN, NEXT_MON, NEXT_SAT] = [0, 2, 3, 4, 6, 7, 8, 13].map(day);

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
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").trim();
async function generate(page, from, to) {
  await page.goto(BASE + "/standing");
  await page.waitForSelector("#gen-from");
  await page.fill("#gen-from", from);
  await page.fill("#gen-to", to);
  await page.click("text=צור הזמנות");
  await page.waitForSelector("main [role=status], main [role=alert]");
  return text(page, "main [role=status], main [role=alert]");
}

try {
  const admin = await signIn(ADMIN);

  // ---------- the weekly template
  await admin.goto(BASE + "/standing");
  await admin.waitForSelector("#standing-customer");
  await admin.selectOption("#standing-customer", { index: 1 });
  await admin.click("text=המשך");
  await admin.waitForSelector("#st-add-row");
  await admin.click("#st-save");
  await admin.waitForSelector("form [role=alert]");
  check("empty template is refused", (await text(admin, "form [role=alert]")).includes("לפחות מוצר אחד"), true);

  await admin.click("#st-add-row");
  await admin.selectOption('[data-st-sku="0"]', "50002");
  for (const d of [0, 1, 2, 3, 4]) await admin.fill(`[data-st-qty="0-${d}"]`, "60");
  await admin.click("#st-add-row");
  await admin.selectOption('[data-st-sku="1"]', "50042");
  await admin.fill('[data-st-qty="1-2"]', "30");
  check("day totals in the grid", [await text(admin, '[data-st-total="0"]'), await text(admin, '[data-st-total="2"]'), await text(admin, '[data-st-total="5"]')], ["60", "90", ""]);
  await admin.fill("#st-valid-from", SUN);
  await admin.fill("#st-valid-to", NEXT_SAT);
  await admin.fill("#st-window-from", "06:45");
  await admin.fill("#st-production-notes", "בלי חמוצים " + tag);
  await admin.click("#st-save");
  await admin.waitForURL(/\/standing\/[0-9a-f-]{36}$/);
  const standingUrl = admin.url();
  await admin.waitForSelector("#standing-state");
  check("saved and active", [await text(admin, "#standing-state"), await admin.inputValue('[data-st-qty="1-2"]')], ["פעילה", "30"]);

  // ---------- one skipped day for this customer, one closed day for everyone
  await admin.fill("#skip-day", WED);
  await admin.fill("#skip-reason", "טיול שנתי");
  await admin.click("text=דלג על היום");
  await admin.waitForSelector("[data-skipped] li");
  check("skipped day listed with its reason", (await text(admin, "[data-skipped] li")).includes("טיול שנתי"), true);
  await admin.goto(BASE + "/standing");
  await admin.waitForSelector("#closed-day");
  await admin.fill("#closed-day", THU);
  await admin.fill("#closed-reason", "חג בדיקה " + tag);
  await admin.click("text=הוסף יום סגור");
  await admin.waitForSelector(`[data-closed-days] li:has-text("חג בדיקה ${tag}")`);

  // ---------- generation
  const g1 = await generate(admin, SUN, SAT);
  check("first run: three orders, one closed day, one skipped day", [/נוצרו 3 הזמנות/.test(g1), /1 דולגו בגלל יום סגור/.test(g1), /1 דולגו לפי סימון ללקוח/.test(g1)], [true, true, true]);
  const g2 = await generate(admin, SUN, SAT);
  check("second run creates nothing", [/נוצרו 0 הזמנות/.test(g2), /3 כבר היו קיימות/.test(g2)], [true, true]);
  // The date field itself refuses a past date. Remove that browser-side limit to prove the server refuses it too.
  await admin.goto(BASE + "/standing");
  await admin.waitForSelector("#gen-from");
  await admin.evaluate(() => document.querySelector("#gen-from").removeAttribute("min"));
  await admin.fill("#gen-from", "2020-01-01");
  await admin.fill("#gen-to", "2020-01-07");
  await admin.click("text=צור הזמנות");
  await admin.waitForSelector("main [role=alert]");
  check("generation for past dates is refused by the server", (await text(admin, "main [role=alert]")).includes("תאריך שעבר"), true);

  await admin.goto(standingUrl);
  await admin.waitForSelector("[data-generated] li");
  check("the standing order lists its three generated orders", await count(admin, "[data-generated] li"), 3);
  await admin.locator("[data-generated] li", { hasText: new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(TUE)) }).locator("a").click();
  await admin.waitForSelector("[data-delivery]");
  const card = await admin.locator("main").innerText();
  check("Tuesday's order: source, both products, window and notes", [card.includes("מקור: הזמנה קבועה"), /50002[\s\S]*60/.test(card), /50042[\s\S]*30/.test(card), card.includes("06:45"), card.includes("הערות לייצור: בלי חמוצים " + tag)], [true, true, true, true, true]);

  await admin.goto(`${BASE}/orders?from=${SUN}&to=${SAT}`);
  await admin.waitForSelector("[data-day]");
  check("the orders list shows three deliveries that week", [await count(admin, "[data-day]"), await count(admin, "main table tbody tr")], [3, 3]);
  await admin.goto(`${BASE}/production?date=${TUE}`);
  await admin.waitForSelector("[data-row]");
  check("the production plan for Tuesday has both products", [await text(admin, '[data-row="50002|"] [data-qty]'), await text(admin, '[data-row="50042|"] [data-qty]')], ["60", "30"]);

  // ---------- restoring the skipped day and reopening the closed day
  await admin.goto(standingUrl);
  await admin.waitForSelector("[data-skipped] li");
  await admin.click("text=בטל דילוג");
  await admin.waitForFunction(() => !document.querySelector("[data-skipped] li"));
  await admin.goto(BASE + "/standing");
  await admin.waitForSelector("[data-closed-days]");
  await admin.locator("[data-closed-days] li", { hasText: "חג בדיקה " + tag }).locator("button").click();
  await admin.waitForFunction((t) => ![...document.querySelectorAll("[data-closed-days] li")].some((li) => li.textContent.includes(t)), "חג בדיקה " + tag);
  check("after restoring, the two missing days are created", /נוצרו 2 הזמנות/.test(await generate(admin, SUN, SAT)), true);

  // ---------- pause
  await admin.goto(standingUrl);
  await admin.waitForSelector("#pause-until");
  await admin.fill("#pause-until", NEXT_MON);
  await admin.click("text=השהה");
  await admin.waitForFunction(() => document.querySelector("#standing-state")?.textContent.includes("מושהית"));
  const g3 = await generate(admin, NEXT_SUN, NEXT_SAT);
  check("pause skips Sunday and Monday, the rest are created", [/נוצרו 3 הזמנות/.test(g3), /2 דולגו בגלל השהיה/.test(g3)], [true, true]);
  await admin.goto(standingUrl);
  await admin.waitForSelector("text=בטל השהיה");
  await admin.click("text=בטל השהיה");
  await admin.waitForFunction(() => document.querySelector("#standing-state")?.textContent.trim() === "פעילה");
  check("resumed: the paused days are filled", /נוצרו 2 הזמנות/.test(await generate(admin, NEXT_SUN, NEXT_SAT)), true);

  // ---------- changing the template does not rewrite existing orders
  await admin.goto(standingUrl);
  await admin.waitForSelector('[data-st-qty="0-0"]');
  await admin.fill('[data-st-qty="0-0"]', "80");
  await admin.click("#st-save");
  await admin.waitForSelector("form [role=status]");
  check("template change is saved with a clear note", (await text(admin, "form [role=status]")).includes("לא השתנו"), true);
  await admin.goto(`${BASE}/production?date=${SUN}`);
  await admin.waitForSelector("[data-row]");
  check("the order already created for Sunday keeps 60", await text(admin, '[data-row="50002|"] [data-qty]'), "60");

  // ---------- roles
  await admin.goto(BASE + "/users");
  await admin.waitForSelector("#new-user-name");
  const add = async (name, mobile, role, department) => {
    await admin.fill("#new-user-name", name);
    await admin.fill("#new-user-mobile", mobile);
    await admin.selectOption("#new-user-role", role);
    if (department) await admin.selectOption("#new-user-department", { label: department });
    await admin.click("text=הוסף משתמש");
    await admin.waitForSelector(`td:has-text("${name}")`);
  };
  const manager = rnd(), worker = rnd();
  await add("מנהל כריכים ח " + tag, manager, "dept_manager", "כריכים");
  await add("עובד כריכים ח " + tag, worker, "production_worker", "כריכים");
  const m = await signIn(manager);
  await m.goto(BASE + "/standing");
  await m.waitForSelector("main table");
  check("department manager sees standing orders but cannot generate or add", [await count(m, "#gen-from"), await count(m, "#standing-customer"), await count(m, "#closed-day")], [0, 0, 0]);
  await m.goto(standingUrl);
  await m.waitForSelector("#standing-state");
  check("department manager cannot edit, skip or pause", [await count(m, "#st-save"), await count(m, "#skip-day"), await count(m, "#pause-until")], [0, 0, 0]);
  const w = await signIn(worker);
  await w.goto(BASE + "/standing");
  await w.waitForSelector("main h1");
  check("production worker: standing orders refused", await text(w, "main h1"), "אין הרשאה למסך הזה");
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E STANDING FAILED (${failed})` : "E2E STANDING PASSED");
process.exit(failed ? 1 : 0);
