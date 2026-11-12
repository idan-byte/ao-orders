// End-to-end check in headless Edge of hot food deliveries: an institution that is not ready and why, linking it
// to a customer and an address, mapping meal types, making the day's deliveries from Milgam's daily order, the
// labels with a hot box and a cold box for every class, and loading box by box on the driver's screen.
// The test keeps one institution ("מוסד בדיקה ג"), two meal types ("מנת בדיקה חמה ...") and one route
// ("קו בדיקה אוכל חם"); its days are in 1950-1999, so they stay at the bottom of the real lists.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-hotfood.mjs
import { chromium } from "playwright-core";
import { workbook } from "./xlsx-write.mjs";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const ROUTE = "קו בדיקה אוכל חם";
const routeCard = `[data-route="${ROUTE}"]`;
const tag = Date.now() % 1000000;
const DAY = `${1950 + Math.floor(Math.random() * 49)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${20 + Math.floor(Math.random() * 8)}`;
const il = (d) => d.split("-").reverse().join("/");
const SYMBOL = "בדיקה-3";
const [MEAL_A, MEAL_B] = ["מנת בדיקה חמה רגילה", "מנת בדיקה חמה צמחונית"];
const NOTE = `א1- ללא ביצים ${tag}`;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const HEAD = ["רשות", "סמל מוסד", "שם מוסד", "סוג מוסד", "תוכנית הזנה", "כתה", "סוג מנה", "כתובת לאספקה", "הערות", "יש אלרגיות מסכנות חיים", il(DAY)];
const row = (cls, meal, n) => ["עיר בדיקה", SYMBOL, "מוסד בדיקה ג", "בית ספר", "תוכנית בדיקה", cls, meal, "רחוב הבדיקה 3", NOTE, "כן", String(n)];
const file = (name, rows) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(workbook([HEAD, ...rows])) });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ locale: "he-IL" })).newPage();
page.on("dialog", (d) => d.accept());
const text = async (sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const count = (sel) => page.locator(sel).count();
const go = async (path, wait) => {
  await page.goto(BASE + path);
  await page.waitForSelector(wait);
};
async function upload(f) {
  await go("/hotfood/milgam", "#milgam-upload");
  await page.selectOption("#milgam-upload [name=kind]", "daily");
  await page.setInputFiles("#milgam-upload [name=file]", f);
  await page.locator("#milgam-upload [name=add_new]").setChecked(true);
  await page.click("#milgam-upload button");
  await page.waitForSelector("#milgam-upload [role=status], #milgam-upload [role=alert]");
  return text("#milgam-upload [role=status], #milgam-upload [role=alert]");
}
/** Saves one of the forms on the institution's card and waits for its answer. */
async function save(form, fill) {
  const f = page.locator(`#institution-link form:has(select[name="${form}"]):visible`);
  await fill(f);
  await f.locator("button").click();
  await f.locator("[role=status], [role=alert]").waitFor();
}
async function setSku(meal, sku) {
  await go("/hotfood/meal-types", "#meal-types-summary");
  const li = page.locator(`[data-meal-type="${meal}"]:visible`);
  if ((await li.getAttribute("data-sku")) === sku) return;
  await li.locator("select").selectOption(sku);
  await li.locator("button").click();
  await page.waitForSelector(`[data-meal-type="${meal}"][data-sku="${sku}"]`);
}
const dayItem = () => page.locator(`[data-day-institution="${SYMBOL}"]:visible`);
async function make() {
  await go(`/hotfood/milgam?day=${DAY}`, "#milgam-deliveries");
  await page.click("#milgam-deliveries form button");
  await page.waitForSelector("#milgam-deliveries [role=status], #milgam-deliveries [role=alert]");
  return text("#milgam-deliveries [role=status], #milgam-deliveries [role=alert]");
}
async function typeScan(code) {
  const before = Number((await page.locator("#scan-result").getAttribute("data-count").catch(() => null)) ?? 0);
  await page.fill("#scan-input", code);
  await page.click("#scan-submit");
  await page.waitForSelector(`#scan-result[data-count="${before + 1}"]`);
  return [await page.locator("#scan-result").getAttribute("data-kind"), await text("#scan-result")];
}

let madeRoute = false;
try {
  await page.goto(BASE + "/login");
  await page.fill("#mobile", ADMIN);
  await page.click("button[value=request]");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("button[value=verify]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  // ---------- the daily order, and an institution that is not ready
  check("the daily order is taken in", await upload(file("הזמנה אוכל חם.xlsx", [row("א1", MEAL_A, 20), row("א1", MEAL_B, 3), row("ב1", MEAL_A, 18)])), "נקלטו 41 מנות ב-1 ימים.");
  await go("/hotfood/institutions", "#institutions-summary");
  await page.locator(`[data-institution="${SYMBOL}"]:visible a`).click();
  await page.waitForSelector("#institution-link");
  const cardUrl = new URL(page.url()).pathname;
  // Earlier runs leave the institution linked and the meal types mapped; start from nothing each time.
  if ((await page.locator("#link-status").getAttribute("data-linked")) === "true" || (await text("#link-status")).startsWith("לקוח:")) {
    await save("customer_id", (f) => f.locator("select").selectOption(""));
    await go(cardUrl, "#institution-link");
  }
  await setSku(MEAL_A, "");
  await setSku(MEAL_B, "");
  await go(`/hotfood/milgam?day=${DAY}`, "#milgam-deliveries");
  check("the institution is listed for the day as not ready, with every reason", [await dayItem().getAttribute("data-state"), (await dayItem().locator("[data-blocked]").textContent()).replace(/\s+/g, " ").trim(), (await dayItem().textContent()).includes("2 מסגרות · 4 ארגזים")], ["blocked", `אי אפשר ליצור אספקה: המוסד לא שויך ללקוח לחיוב · סוגי מנה בלי מק״ט: ${MEAL_B}, ${MEAL_A}`, true]);
  const refused = await make();
  check("making deliveries skips it and says so", [refused.includes("נוצרו 0 אספקות"), refused.includes("עוד לא מוכנים"), await dayItem().getAttribute("data-state")], [true, true, "blocked"]);

  // ---------- linking: a customer, then one of its addresses
  await go(cardUrl, "#institution-link");
  check("the card shows the allergy warning and the remark", [(await text("#institution-details")).includes("אלרגיות מסכנות חיים"), (await text("#institution-details [data-notes]"))], [true, NOTE]);
  const customers = await page.locator('#institution-link [name="customer_id"] option').count();
  let linked = false;
  for (let i = 1; i < Math.min(customers, 60) && !linked; i++) {
    await save("customer_id", (f) => f.locator("select").selectOption({ index: i }));
    await go(cardUrl, "#institution-link");
    if ((await count('#institution-link [name="address_id"]')) === 0) continue;
    check("a customer alone is not enough: an address is still needed", [await page.locator("#link-status").getAttribute("data-linked"), (await text("#link-status")).includes("עוד לא נבחרה כתובת")], ["false", true]);
    await save("address_id", (f) => f.locator("select").selectOption({ index: 1 }));
    await go(cardUrl, "#institution-link");
    linked = (await page.locator("#link-status").getAttribute("data-linked")) === "true";
  }
  check("the institution is linked to a customer and one of its addresses", linked, true);

  // ---------- meal types to catalogue items
  await go("/hotfood/meal-types", "#meal-types-summary");
  const skus = await page.locator(`[data-meal-type="${MEAL_A}"]:visible select option`).evaluateAll((l) => l.map((o) => o.value).filter(Boolean));
  let done = false;
  for (const sku of skus.slice(0, 12)) {
    await setSku(MEAL_A, sku);
    await setSku(MEAL_B, sku);
    await go(`/hotfood/milgam?day=${DAY}`, "#milgam-deliveries");
    if ((await dayItem().getAttribute("data-state")) === "ready") {
      done = true;
      break;
    }
  }
  if (!done) throw new Error("no hot food item in the catalogue could be used (sort group 600, open for orders, without variants)");
  check("with a customer, an address and mapped meal types the institution is ready", await dayItem().getAttribute("data-state"), "ready");

  // ---------- making the delivery
  const created = await make();
  check("the delivery is made", [created.startsWith("נוצרו 1 אספקות"), await dayItem().getAttribute("data-state"), /הזמנה \d+ · מאושרת/.test(await text(`[data-day-institution="${SYMBOL}"] [data-made]`))], [true, "made", true]);
  const orderNumber = (await text(`[data-day-institution="${SYMBOL}"] [data-made]`)).match(/הזמנה (\d+)/)[1];
  const again = await make();
  check("making again changes nothing", [again.startsWith("נוצרו 0 אספקות"), again.includes("1 ללא שינוי")], [true, true]);

  // ---------- onto a route
  await go("/shipping/routes", "#new-route");
  if ((await count(routeCard)) === 0) {
    await page.fill("#new-route [name=name]", ROUTE);
    await page.click("#new-route button");
    await page.waitForSelector(routeCard);
  } else if ((await page.locator(routeCard).getAttribute("data-active")) === "false") {
    await page.locator(`${routeCard} button:has-text("החזר לשימוש")`).click();
    await page.waitForSelector(`${routeCard}[data-active="true"]`);
  }
  madeRoute = true;
  await go(`/shipping?date=${DAY}`, "#unassigned");
  const waiting = page.locator(`[data-unassigned="${orderNumber}"]:visible`);
  if ((await waiting.count()) > 0) {
    await waiting.locator("select").selectOption({ label: ROUTE });
    await waiting.locator("[name=permanent]").setChecked(false);
    await waiting.locator("button").click();
    await page.waitForFunction((n) => !document.querySelector(`[data-unassigned="${n}"]`), orderNumber);
  } else {
    // The address already belongs to a permanent route: planning the day puts the delivery on it.
    await page.locator('button:has-text("שבץ")').first().click().catch(() => {});
  }
  await go(`/shipping?date=${DAY}`, "[data-route-card]");
  let labelsUrl = null;
  for (const href of await page.locator("[data-route-card]:visible").evaluateAll((l) => l.map((a) => a.getAttribute("href")))) {
    await go(`${href}/labels`, "#labels-summary");
    if ((await count(`[data-label="${orderNumber}"]:visible`)) > 0) {
      labelsUrl = `${href}/labels`;
      break;
    }
  }
  if (!labelsUrl) throw new Error("the delivery was not found on any route of the day");

  // ---------- labels: a hot box and a cold box for every class, each with its own code
  const labels = await page.locator(`[data-label="${orderNumber}"]:visible`).evaluateAll((l) => l.map((x) => ({ code: x.getAttribute("data-code"), kind: x.querySelector("[data-box-kind]")?.getAttribute("data-box-kind"), text: x.textContent.replace(/\s+/g, " ") })));
  check("four labels: hot and cold for class א1, hot and cold for class ב1, with four different codes", [labels.map((l) => [l.kind, l.text.includes("א1 · ארגז") ? "א1" : l.text.includes("ב1 · ארגז") ? "ב1" : "?"]), new Set(labels.map((l) => l.code)).size], [[["hot", "א1"], ["cold", "א1"], ["hot", "ב1"], ["cold", "ב1"]], 4]);
  check("a label names the institution, what the class ordered, and the allergy remark", [labels[0].text.includes("מוסד בדיקה ג"), labels[0].text.includes(`3 ${MEAL_B} + 20 ${MEAL_A}`), labels[2].text.includes(`18 ${MEAL_A}`), labels.every((l) => l.text.includes("אלרגיות מסכנות חיים") && l.text.includes(NOTE)), labels[1].text.includes("נלווים (קר)")], [true, true, true, true, true]);
  check("the number of boxes of a hot food delivery is not edited by hand", await count(`[data-packages="${orderNumber}"]:visible`), 0);
  if (process.env.AO_SCREENSHOT) {
    await page.click('#label-format a:has-text("102×150")');
    await page.waitForSelector(".label-single");
    await page.screenshot({ path: process.env.AO_SCREENSHOT, fullPage: true });
  }

  // ---------- loading box by box
  await go(labelsUrl.replace("/shipping/day/", "/drive/").replace("/labels", ""), "#scan");
  const item = page.locator(`[data-delivery="${orderNumber}"]:visible`);
  const hot = await typeScan(labels[0].code);
  await page.waitForSelector(`[data-delivery="${orderNumber}"][data-boxes="1/4"]`);
  check("the hot box of class א1 is taken; three boxes of the institution are still missing", [hot[0], hot[1].includes("ארגז חם · א1 הועמס. חסרים עוד 3."), hot[1].includes("מוסד בדיקה ג"), await item.getAttribute("data-marked")], ["partial", true, true, "false"]);
  await typeScan(labels[2].code);
  await typeScan(labels[3].code);
  await page.waitForSelector(`[data-delivery="${orderNumber}"][data-boxes="3/4"]`);
  check("with the cold box of א1 still off the vehicle the institution is not loaded, and the screen says one is missing", [await item.getAttribute("data-marked"), (await item.locator("[data-partial]").textContent()).replace(/\s+/g, " ").trim()], ["false", "הועמסו 3 מתוך 4 ארגזים · חסרים 1"]);
  const cold = await typeScan(labels[1].code);
  await page.waitForSelector(`[data-delivery="${orderNumber}"][data-marked="true"]`);
  check("the cold box completes it", [cold[0], cold[1].includes("ארגז נלווים (קר) · א1 הועמס. כל הארגזים של האספקה על הרכב.")], ["done", true]);

  // ---------- a corrected order after loading began
  check("a corrected order is taken in", (await upload(file("הזמנה מתוקנת.xlsx", [row("א1", MEAL_A, 25), row("ב1", MEAL_A, 18)]))).startsWith("נקלטו 43 מנות"), true);
  const late = await make();
  check("but a delivery whose boxes are already loaded is not changed, and that is reported", [late.includes("כבר בתנועה ולא עודכנו"), late.startsWith("נוצרו 0 אספקות")], [true, true]);
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  if (madeRoute) {
    try {
      await go("/shipping/routes", "#new-route");
      if ((await count(`${routeCard}[data-active="true"]`)) > 0) {
        await page.locator(`${routeCard} button:has-text("הפסק להשתמש בקו")`).click();
        await page.waitForSelector(`${routeCard}[data-active="false"]`);
      }
    } catch {
      console.log("WARNING: the test route may still be active. Switch it off at /shipping/routes.");
    }
  }
  await browser.close();
}
console.log(failed ? `E2E HOTFOOD FAILED (${failed})` : "E2E HOTFOOD PASSED");
process.exit(failed ? 1 : 0);
