// End-to-end check of login and role enforcement in a real browser (Microsoft Edge, headless).
// Needs the dev server running on http://localhost:3000 and the bootstrap administrator from .env.local.
// Run from the web folder:  node scripts/e2e-login.mjs
// Note: each run requests one login code for the administrator, and codes are limited to 3 per 15 minutes.
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const worker = { mobile: rnd(), name: "עובד ייצור בדיקה " + Date.now() % 10000, role: "production_worker" };
const manager = { mobile: rnd(), name: "מנהל מחלקה בדיקה " + Date.now() % 10000, role: "dept_manager" };

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });

async function signIn(mobile) {
  const context = await browser.newContext({ locale: "he-IL" });
  const page = await context.newPage();
  await page.goto(BASE + "/login");
  await page.fill("#mobile", mobile);
  await page.click("button[value=request]");
  await page.waitForSelector("#code");
  const code = await page.locator("form b").textContent();
  await page.fill("#code", code.trim());
  await page.click("button[value=verify]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return { context, page };
}
const navLabels = async (page) => {
  await page.waitForSelector("header form button");
  return page.locator("header nav a").allTextContents();
};
const h1 = async (page, path) => {
  await page.goto(BASE + path);
  await page.waitForSelector("main h1");
  return (await page.locator("main h1").first().textContent()).trim();
};

try {
  // --- anonymous
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(BASE + "/catalog");
  await anon.waitForURL(BASE + "/login");
  check("anonymous visitor is sent to login", new URL(anon.url()).pathname, "/login");
  await anon.fill("#mobile", "02-5551234");
  await anon.click("button[value=request]");
  await anon.waitForSelector("[role=alert]");
  check("landline number is rejected", (await anon.locator("#code").count()) === 0, true);
  await anon.fill("#mobile", rnd());
  await anon.click("button[value=request]");
  await anon.waitForSelector("#code");
  check("unknown number gets the same screen and no code", await anon.locator("form b").count(), 0);

  // --- administrator
  const admin = await signIn(ADMIN);
  check("admin navigation", await navLabels(admin.page), ["דשבורד", "מכירות", "הצעות מחיר", "הזמנות", "קבועות", "ייצור", "לקוחות", "קטלוג", "משתמשים"]);
  check("session cookie is not readable by scripts", await admin.page.evaluate(() => document.cookie.includes("ao_session")), false);

  await admin.page.goto(BASE + "/users");
  await admin.page.waitForSelector("#new-user-name");
  const firstDepartment = async () => {
    await admin.page.waitForSelector("#new-user-department");
    return admin.page.locator("#new-user-department option").nth(1).getAttribute("value");
  };
  for (const u of [worker, manager]) {
    await admin.page.fill("#new-user-name", u.name);
    await admin.page.fill("#new-user-mobile", u.mobile);
    await admin.page.selectOption("#new-user-role", u.role);
    await admin.page.selectOption("#new-user-department", await firstDepartment());
    await admin.page.click("text=הוסף משתמש");
    await admin.page.waitForSelector(`td:has-text("${u.name}")`);
  }
  check("new users appear in the list", await admin.page.locator(`td:has-text("${worker.name}")`).count(), 1);

  await admin.page.fill("#new-user-name", "כפול");
  await admin.page.fill("#new-user-mobile", worker.mobile);
  await admin.page.selectOption("#new-user-role", "sales");
  await admin.page.click("text=הוסף משתמש");
  await admin.page.waitForSelector("main [role=alert]");
  check("duplicate mobile is refused", (await admin.page.locator("main [role=alert]").textContent()).includes("כבר קיים"), true);

  // --- production worker: no dashboard, no catalog, no users
  const w = await signIn(worker.mobile);
  check("production worker navigation has only production", await navLabels(w.page), ["ייצור"]);
  await w.page.goto(BASE + "/");
  await w.page.waitForURL(BASE + "/production");
  check("production worker is sent from the dashboard to the production plan", new URL(w.page.url()).pathname, "/production");
  check("production worker: catalog refused", await h1(w.page, "/catalog"), "אין הרשאה למסך הזה");
  check("production worker: users refused", await h1(w.page, "/users"), "אין הרשאה למסך הזה");

  // --- department manager: catalog without prices, no users
  const m = await signIn(manager.mobile);
  check("department manager navigation", await navLabels(m.page), ["דשבורד", "הזמנות", "קבועות", "ייצור", "קטלוג"]);
  check("department manager: catalog opens", await h1(m.page, "/catalog"), "קטלוג");
  await m.page.waitForSelector("main table");
  check("department manager: no price column", (await m.page.content()).includes("מחיר בסיס לפני"), false);
  check("department manager: users refused", await h1(m.page, "/users"), "אין הרשאה למסך הזה");

  await admin.page.goto(BASE + "/catalog");
  await admin.page.waitForSelector("main table");
  check("admin: price column shown", (await admin.page.content()).includes("מחיר בסיס לפני"), true);

  // --- deactivation ends the session at once
  await admin.page.goto(BASE + "/users");
  const row = admin.page.locator("tr", { hasText: manager.name });
  await row.locator("button", { hasText: "השבת" }).click();
  await row.locator("button", { hasText: "הפעל" }).waitFor();
  await m.page.goto(BASE + "/catalog");
  await m.page.waitForURL(BASE + "/login");
  check("deactivated user is signed out everywhere", new URL(m.page.url()).pathname, "/login");
  await m.page.fill("#mobile", manager.mobile);
  await m.page.click("button[value=request]");
  await m.page.waitForSelector("#code");
  check("deactivated user gets no new code", await m.page.locator("form b").count(), 0);

  // --- sign out
  await w.page.goto(BASE + "/");
  await w.page.click("header form button");
  await w.page.waitForURL(BASE + "/login");
  await w.page.goto(BASE + "/");
  await w.page.waitForURL(BASE + "/login");
  check("signed-out user cannot return", new URL(w.page.url()).pathname, "/login");
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E LOGIN FAILED (${failed})` : "E2E LOGIN PASSED");
process.exit(failed ? 1 : 0);
