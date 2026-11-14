// End-to-end check of the production plan in headless Edge: aggregation across orders, export, lock,
// late-change alert and acknowledgement, the lock guard on order changes, marking done, moving shifts, roles.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-production.mjs
import { chromium } from "playwright-core";
import { inflateRawSync } from "node:zlib";

// The text of one file inside a zip (an .xlsx is one): reads the local header of each entry in turn.
function inflateEntry(zip, wanted) {
  for (let at = 0; at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50; ) {
    const method = zip.readUInt16LE(at + 8), size = zip.readUInt32LE(at + 18), nameLen = zip.readUInt16LE(at + 26), extraLen = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const start = at + 30 + nameLen + extraLen;
    if (name === wanted) return (method === 8 ? inflateRawSync(zip.subarray(start, start + size)) : zip.subarray(start, start + size)).toString("utf8");
    at = start + size;
  }
  return "";
}

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const tag = Date.now() % 1000000;
const pick = (n) => Math.floor(Math.random() * n);
const DAY = `${2040 + pick(50)}-${String(pick(12) + 1).padStart(2, "0")}-${String(pick(27) + 1).padStart(2, "0")}`;

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
const rowQty = (page, shift, sku) => text(page, `[data-shift="${shift}"] [data-row="${sku}|"] [data-qty]`);
async function newOrder(page, customerIndex, lines, note) {
  await page.goto(BASE + "/orders/new");
  await page.waitForSelector("#order-customer");
  await page.selectOption("#order-customer", { index: customerIndex });
  await page.click("text=המשך");
  await page.waitForSelector("#q-add-line");
  for (const [i, [sku, qty]] of lines.entries()) {
    await page.click("#q-add-line");
    await page.selectOption(`[data-line-sku="${i}"]`, sku);
    await page.fill(`[data-line-qty="${i}"]`, String(qty));
  }
  await page.fill("#q-delivery-date", DAY);
  if (note) await page.fill("#q-internal-notes", note);
  await page.click("button[value=save]");
  return page;
}
const plan = async (page, extra = "") => {
  await page.goto(`${BASE}/production?date=${DAY}${extra}`);
  await page.waitForSelector("main h1");
};

try {
  const admin = await signIn(ADMIN);
  await newOrder(admin, 1, [["50002", 60], ["50042", 20]], "בלי חמוצים " + tag);
  await admin.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  const order1 = admin.url();
  await newOrder(admin, 2, [["50002", 40]]);
  await admin.waitForURL(/\/orders\/[0-9a-f-]{36}$/);

  // ---------- aggregation
  await plan(admin);
  check("the plan opens on the sandwich department", (await text(admin, "main h1")).includes("כריכים"), true);
  check("two orders become one line of 100; both sandwich products are in the night shift", [await rowQty(admin, 1, "50002"), await rowQty(admin, 1, "50042"), await count(admin, "[data-shift]")], ["100", "20", 1]);
  check("sources: two orders, and production notes are flagged", [await text(admin, '[data-shift="1"] [data-row="50002|"] summary'), (await text(admin, '[data-shift="1"] [data-row="50002|"]')).includes("יש הערות לייצור"), (await admin.locator('[data-shift="1"] [data-row="50002|"] details').innerHTML()).includes("בלי חמוצים " + tag)], ["2 הזמנות", true, true]);
  check("production screen shows no prices", /₪/.test(await admin.locator("main").innerText()), false);

  // ---------- export
  const deptId = new URL(await admin.locator("#production-csv").getAttribute("href"), BASE).searchParams.get("dept");
  const csv = await admin.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, type: r.headers.get("content-type"), body: await r.text() }; }, `/production/export?date=${DAY}&dept=${deptId}`);
  const csvLines = csv.body.replace(/^﻿/, "").trim().split("\r\n");
  check("CSV export: header and one row per product", [csv.status, csv.type.startsWith("text/csv"), csvLines[0].startsWith("תאריך אספקה,מחלקה,משמרת"), csvLines.length, csvLines.some((l) => l.includes(",50002,") && l.includes(",100,"))], [200, true, true, 3, true]);
  const anon = await (await browser.newContext()).newPage();
  check("CSV export needs a login", (await anon.goto(`${BASE}/production/export?date=${DAY}&dept=${deptId}`)).status(), 401);

  // Excel: a real .xlsx (zip) whose sheet holds the same plan; PDF: a real PDF file.
  const sent = admin.context().request;
  const xlsx = await sent.get(`${BASE}/production/export?date=${DAY}&dept=${deptId}&format=xlsx`);
  const xlsxBytes = await xlsx.body();
  const sheet = inflateEntry(xlsxBytes, "xl/worksheets/sheet1.xml");
  check("Excel export: a workbook whose sheet has the plan's rows", [xlsx.status(), (xlsx.headers()["content-type"] ?? "").includes("spreadsheetml"), xlsxBytes.subarray(0, 2).toString(), sheet.includes("50002"), sheet.includes("<v>100</v>"), sheet.includes('rightToLeft="1"')], [200, true, "PK", true, true, true]);
  const pdf = await sent.get(`${BASE}/production/export?date=${DAY}&dept=${deptId}&format=pdf`);
  const pdfBytes = await pdf.body();
  check("PDF export: a PDF file", [pdf.status(), (pdf.headers()["content-type"] ?? "").includes("application/pdf"), pdfBytes.subarray(0, 4).toString()], [200, true, "%PDF"]);
  check("export formats other than these are refused", (await sent.get(`${BASE}/production/export?date=${DAY}&dept=${deptId}&format=doc`)).status(), 400);

  // ---------- lock, late change, acknowledge
  await admin.locator('[data-shift="1"] [data-lock]').click();
  await admin.waitForSelector('[data-shift="1"] [data-locked]');
  check("night shift locked, nothing pending", [await count(admin, '[data-shift="1"] [data-locked]'), await count(admin, "[data-late-changes]")], [1, 0]);

  await admin.goto(order1);
  await admin.locator('[data-delivery="0"] [data-edit]').click();
  await admin.waitForSelector('[data-line-qty="1"]');
  await admin.fill('[data-line-qty="0"]', "80");
  await admin.click("button[value=save]");
  await admin.waitForURL(order1);
  await plan(admin);
  await admin.waitForSelector("[data-late-changes]");
  const banner = await text(admin, "[data-late-changes]");
  check("late change is announced with old and new totals", [banner.includes("משמרת לילה"), /100\s*←\s*120/.test(banner), banner.includes("להוסיף 20"), await rowQty(admin, 1, "50002")], [true, true, true, "120"]);
  await admin.click("text=ראיתי, התוכנית מעודכנת");
  await admin.waitForFunction(() => !document.querySelector("[data-late-changes]"));
  check("acknowledged: alert gone, shift still locked", await count(admin, '[data-shift="1"] [data-locked]'), 1);

  // ---------- users for the role checks
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
  const clerk = rnd(), manager = rnd(), worker = rnd(), hotWorker = rnd();
  await add("עובד הזמנות י " + tag, clerk, "order_clerk");
  await add("מנהל כריכים י " + tag, manager, "dept_manager", "כריכים");
  await add("עובד כריכים י " + tag, worker, "production_worker", "כריכים");
  await add("עובד מטבח י " + tag, hotWorker, "production_worker", "מטבח חם");

  // ---------- after the lock, an ordinary employee cannot change that day
  const c = await signIn(clerk);
  await c.goto(order1);
  await c.locator('[data-delivery="0"] [data-edit]').click();
  await c.waitForSelector('[data-line-qty="1"]');
  await c.fill('[data-line-qty="0"]', "500");
  await c.click("button[value=save]");
  await c.waitForSelector("form [role=alert]");
  check("order clerk cannot change a locked day", (await text(c, "form [role=alert]")).includes("נעולה"), true);
  await newOrder(c, 1, [["50002", 10]]);
  await c.waitForSelector("form [role=alert]");
  check("order clerk cannot add an order to a locked day", (await text(c, "form [role=alert]")).includes("נעולה"), true);
  await plan(admin);
  check("the plan is untouched", await rowQty(admin, 1, "50002"), "120");

  // ---------- department manager: own department only, marking done, moving a shift
  const m = await signIn(manager);
  await plan(m, "&dept=999");
  check("department manager is held to their own department", [(await text(m, "main h1")).includes("כריכים"), await count(m, "[data-departments]")], [true, 0]);
  await m.locator('[data-shift="1"] [data-row="50002|"] [data-mark]').click();
  await m.waitForFunction(() => document.querySelector('[data-shift="1"] [data-row="50002|"] [data-mark]')?.textContent.trim() === "בטל סימון");
  await admin.goto(order1);
  await admin.waitForSelector("[data-delivery-status]");
  check("first product made: the order moves to in production", await text(admin, "[data-delivery-status]"), "בייצור");
  await m.locator('[data-shift="1"] [data-row="50042|"] [data-mark]').click();
  await m.waitForFunction(() => document.querySelector('[data-shift="1"] [data-row="50042|"] [data-mark]')?.textContent.trim() === "בטל סימון");
  await admin.reload();
  await admin.waitForSelector("[data-delivery-status]");
  check("everything made: the order is ready to ship", await text(admin, "[data-delivery-status]"), "מוכנה לשילוח");

  await m.locator('[data-shift="1"] [data-row="50042|"] select[name=to_shift]').selectOption("2");
  await m.locator('[data-shift="1"] [data-row="50042|"] [data-move]').click();
  await m.waitForSelector('[data-shift="2"] [data-row="50042|"]');
  check("toast moved to the morning shift, and the locked night shift reports it leaving", [await count(m, '[data-shift="1"] [data-row="50042|"]'), /טוסט:\s*20\s*←\s*0/.test(await text(m, "[data-late-changes]"))], [0, true]);

  // ---------- production workers
  const w = await signIn(worker);
  // The home page redirects production staff to their plan; the redirect arrives a moment after the login completes.
  await w.waitForURL(BASE + "/production", { timeout: 15_000 }).catch(() => {});
  check("production worker lands on the plan", new URL(w.url()).pathname, "/production");
  await plan(w);
  check("worker can mark and acknowledge, but not lock or move", [await count(w, "[data-mark]") > 0, await count(w, "text=ראיתי, התוכנית מעודכנת"), await count(w, "[data-move]"), await count(w, "text=בטל נעילה")], [true, 1, 0, 0]);
  await w.goto(BASE + "/orders");
  await w.waitForSelector("main h1");
  check("worker has no access to orders", await text(w, "main h1"), "אין הרשאה למסך הזה");
  const hw = await signIn(hotWorker);
  await plan(hw, `&dept=${deptId}`);
  check("a worker of another department cannot see this department's plan", [(await text(hw, "main h1")).includes("מטבח חם"), await count(hw, '[data-row="50002|"]')], [true, 0]);

  // ---------- unlock
  await m.reload();
  await m.waitForSelector("text=בטל נעילה");
  await m.click("text=בטל נעילה");
  await m.waitForFunction(() => !document.querySelector("[data-locked]"));
  check("unlocked: no lock, no alert", [await count(m, "[data-locked]"), await count(m, "[data-late-changes]")], [0, 0]);
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E PRODUCTION FAILED (${failed})` : "E2E PRODUCTION PASSED");
process.exit(failed ? 1 : 0);
