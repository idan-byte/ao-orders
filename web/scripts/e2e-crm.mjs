// End-to-end check of the CRM in headless Edge: leads, derived stages, tasks, activity log, customer history,
// dashboard and roles. Needs the dev server on http://localhost:3000 with customers already synced.
// Run from the web folder:  node scripts/e2e-crm.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const tag = Date.now() % 1000000;
const LEAD_NAME = "פונה בדיקה " + tag;

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
const text = async (page, sel) => (await page.locator(sel).first().textContent()).trim();
const stageIs = (page, label) => page.waitForFunction((l) => document.querySelector("#lead-stage")?.textContent.trim() === l, label);
const tile = async (page, id) => Number((await text(page, `#${id} b`)).replace(/\D/g, ""));
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

try {
  const admin = await signIn(ADMIN);
  await admin.waitForSelector("[data-tiles]");
  const before = { leads: await tile(admin, "tile-leads"), tasks: await tile(admin, "tile-tasks"), waiting: await tile(admin, "tile-waiting") };

  // ---------- validation, then a lead from someone who is not a customer
  await admin.goto(BASE + "/sales");
  await admin.waitForSelector("#lead-summary");
  await admin.fill("#lead-summary", "מבקשים הצעה");
  await admin.click("text=פתח פנייה");
  await admin.waitForSelector("main [role=alert]");
  check("lead needs a customer or a name", (await text(admin, "main [role=alert]")).includes("שם הפונה"), true);

  await admin.fill("#lead-name", LEAD_NAME);
  await admin.fill("#lead-phone", "050-0000009");
  await admin.selectOption("#lead-source", "וואטסאפ");
  await admin.fill("#lead-summary", "חמגשיות ל-35 ילדים, חמישה ימים בשבוע");
  await admin.fill("#lead-follow-up", today);
  await admin.click("text=פתח פנייה");
  await admin.waitForURL(/\/sales\/[0-9a-f-]{36}$/);
  const leadUrl = admin.url();
  await admin.waitForSelector("#lead-stage");
  check("new lead: stage, follow-up task, opening logged", [await text(admin, "#lead-stage"), await count(admin, "[data-tasks] li:visible"), (await text(admin, "[data-timeline]")).includes("פנייה נפתחה (וואטסאפ)")], ["פנייה חדשה", 1, true]);
  check("no quote button before there is a customer", await count(admin, "text=פתח הצעת מחיר"), 0);

  await admin.goto(BASE + "/");
  await admin.waitForSelector("[data-tiles]");
  check("dashboard counts the new lead and its task", [await tile(admin, "tile-leads"), await tile(admin, "tile-tasks")], [before.leads + 1, before.tasks + 1]);
  await admin.goto(BASE + "/sales");
  await admin.waitForSelector("[data-board]");
  check("lead is in the first board column and in today's follow-up", [await count(admin, `[data-stage=new] a:has-text("${LEAD_NAME}")`), await count(admin, `[data-tasks] li:has-text("${LEAD_NAME}")`)], [1, 1]);

  // ---------- activity and tasks
  await admin.goto(leadUrl);
  await admin.waitForSelector("#activity-body");
  await admin.selectOption("#activity-kind", "call");
  await admin.fill("#activity-body", "שוחחנו, מבקשים הצעה עד יום חמישי");
  await admin.click("text=רשום");
  await admin.waitForSelector("[data-timeline] li:has-text('שוחחנו')");
  check("activity is logged with its kind", (await text(admin, "[data-timeline] li:has-text('שוחחנו')")).startsWith("שיחה"), true);
  await admin.fill("#task-title", "לשלוח תפריט לדוגמה");
  await admin.click("text=הוסף משימה");
  await admin.waitForSelector("[data-tasks] li:has-text('לשלוח תפריט לדוגמה')");
  await admin.locator("[data-tasks] li", { hasText: "לחזור לפונה" }).locator("button").click();
  await admin.waitForFunction(() => [...document.querySelectorAll("[data-tasks] li")].filter((li) => li.querySelector("button")).length === 1);
  check("completing a task leaves one open", await count(admin, "[data-tasks] li:visible button"), 1);

  // ---------- customer card from the lead, then a quote: the stage follows the quote
  await admin.click("text=פתח כרטיס לקוח מהפנייה");
  await admin.waitForSelector("text=פתח הצעת מחיר");
  await admin.click("text=פתח הצעת מחיר");
  await admin.waitForURL(/\/quotes\/[0-9a-f-]{36}$/);
  await admin.waitForSelector("#q-add-line");
  const quoteUrl = admin.url();
  await admin.goto(leadUrl);
  await stageIs(admin, "הצעה בהכנה");
  check("quote opened -> lead is 'quote in progress'", await count(admin, "#lead-quote-link"), 1);

  await admin.goto(quoteUrl);
  await admin.waitForSelector("#q-add-line");
  await admin.click("#q-add-line");
  await admin.selectOption('[data-line-sku="0"]', "50002");
  await admin.fill('[data-line-qty="0"]', "10");
  await admin.fill('[data-line-price="0"]', "8");
  await admin.fill("#q-delivery-date", "2026-12-10");
  await admin.click("button[value=send]");
  await admin.waitForSelector("input[aria-label='קישור לאישור ההצעה']");
  await admin.goto(leadUrl);
  await stageIs(admin, "נשלחה");
  await admin.click("text=סמן במעקב");
  await stageIs(admin, "במעקב");
  await admin.click("text=הסר סימון מעקב");
  await stageIs(admin, "נשלחה");
  check("quote sent -> 'sent', follow-up toggles", (await text(admin, "[data-timeline]")).includes("הצעת מחיר נשלחה (גרסה 1, 94.40"), true);
  await admin.goto(BASE + "/");
  await admin.waitForSelector("[data-tiles]");
  check("dashboard counts the waiting quote", await tile(admin, "tile-waiting"), before.waiting + 1);

  await admin.goto(quoteUrl);
  await admin.fill("#manual-approver", "דנה, בטלפון");
  await admin.click("text=אשר ופתח הזמנה");
  await admin.waitForSelector("#quote-approved");
  await admin.goto(leadUrl);
  await stageIs(admin, "אושרה");
  check("approved -> won, and the lead can no longer be closed", [await count(admin, "#lead-close-reason"), await count(admin, "text=סמן במעקב")], [0, 0]);

  // ---------- customer history
  await admin.click("text=כרטיס הלקוח");
  await admin.waitForSelector("#customer-history");
  const history = await text(admin, "#customer-history [data-timeline]");
  check("customer history holds the whole story", ["פנייה נפתחה", "שוחחנו", "נפתח כרטיס לקוח מהפנייה", "נפתחה הצעת מחיר", "הצעת מחיר נשלחה", "אושרה ידנית (דנה, בטלפון)"].map((s) => history.includes(s)), [true, true, true, true, true, true]);
  check("customer summary counts quotes and orders", (await text(admin, "#customer-summary")).startsWith("1 הצעות מחיר (0 פתוחות) · 1 הזמנות"), true);
  check("new customer from a lead is not linked to Hashavshevet", (await admin.content()).includes("לא הוזן"), true);
  await admin.fill("#activity-body", "ביקשו לקבל תפריט חורף");
  await admin.selectOption("#activity-kind", "note");
  await admin.click("#customer-history >> text=רשום");
  await admin.waitForSelector("#customer-history [data-timeline] li:has-text('תפריט חורף')");
  check("note added from the customer card", await count(admin, "#customer-history [data-timeline] li:has-text('תפריט חורף')"), 1);

  // ---------- a lead for an existing customer, closed as lost
  await admin.goto(BASE + "/sales");
  await admin.waitForSelector("#lead-customer");
  await admin.selectOption("#lead-customer", { index: 1 });
  await admin.fill("#lead-summary", "פנייה לסגירה " + tag);
  await admin.click("text=פתח פנייה");
  await admin.waitForURL(/\/sales\/[0-9a-f-]{36}$/);
  await admin.waitForSelector("#lead-close-reason");
  await admin.selectOption("#lead-close-reason", "לא חזרו אלינו");
  await admin.click("text=סגור פנייה");
  await stageIs(admin, "נדחתה");
  check("closed lead shows the reason and no more actions", [(await admin.content()).includes("סיבת הסגירה: לא חזרו אלינו"), await count(admin, "#task-title"), await count(admin, "text=פתח הצעת מחיר")], [true, 0, 0]);
  await admin.goto(BASE + "/sales");
  await admin.waitForSelector("[data-board]");
  check("board: won and lost columns", [await count(admin, `[data-stage=won] a:has-text("${LEAD_NAME}")`), await count(admin, `[data-stage=lost] a:has-text("פנייה לסגירה ${tag}")`)], [1, 1]);
  await admin.goto(BASE + "/");
  await admin.waitForSelector("[data-tiles]");
  check("dashboard: both leads are closed again", await tile(admin, "tile-leads"), before.leads);

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
  const clerk = rnd(), manager = rnd();
  await add("עובד הזמנות ק " + tag, clerk, "order_clerk");
  await add("מנהל מחלקה ק " + tag, manager, "dept_manager");
  const c = await signIn(clerk);
  await c.goto(leadUrl);
  await c.waitForSelector("#lead-stage");
  check("order clerk can read a lead but not act on it", [await count(c, "#activity-body"), await count(c, "#task-title"), await count(c, "[data-tasks] li:visible button")], [0, 0, 0]);
  await c.goto(BASE + "/sales");
  await c.waitForSelector("[data-board]");
  check("order clerk has no new-lead form", await count(c, "#lead-summary"), 0);
  const m = await signIn(manager);
  await m.goto(BASE + "/sales");
  await m.waitForSelector("main h1");
  check("department manager: sales refused", await text(m, "main h1"), "אין הרשאה למסך הזה");
  await m.goto(leadUrl);
  await m.waitForSelector("main h1");
  check("department manager: lead refused", await text(m, "main h1"), "אין הרשאה למסך הזה");
  await m.goto(BASE + "/");
  await m.waitForSelector("[data-tiles]");
  check("department manager dashboard shows no sales or price tiles", [await count(m, "#tile-leads"), await count(m, "#tile-waiting"), await count(m, "#tile-prices"), await count(m, "#tile-deliveries")], [0, 0, 0, 1]);
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E CRM FAILED (${failed})` : "E2E CRM PASSED");
process.exit(failed ? 1 : 0);
