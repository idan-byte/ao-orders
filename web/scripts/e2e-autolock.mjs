// End-to-end check in headless Edge of automatic locking of the production plan: setting lock times on the
// production screen, the background scheduler locking a plan by itself, and unlocking it by hand.
// The dev server needs AO_SCHEDULER_INTERVAL_SECONDS=10 in .env.local. The lock time is removed again at the end.
// A plan locks automatically once only, so on a repeated run the same day the test moves on to another shift or department.
// Run from the web folder:  node scripts/e2e-autolock.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ locale: "he-IL" })).newPage();
const count = (sel) => page.locator(sel).count();
const text = async (sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").trim();
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
async function open(date, dept) {
  await page.goto(`${BASE}/production?date=${date}&dept=${dept}`);
  await page.waitForSelector("[data-lock-times] button");
}
async function saveTimes(expect) {
  await page.locator("[data-lock-times] button").click();
  await page.waitForSelector(`[data-lock-times] [role=${expect}]`);
  return text(`[data-lock-times] [role=${expect}]`);
}

let used = null; // { dept, shift, today } while a lock time set by this run is in place
try {
  await page.goto(BASE + "/login");
  await page.fill("#mobile", ADMIN);
  await page.click("button[value=request]");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("button[value=verify]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  await page.goto(BASE + "/production");
  await page.waitForSelector("[data-departments] a");
  const today = await page.locator("#production-date").inputValue();
  const depts = await page.locator("[data-departments] a").evaluateAll((els) => els.map((a) => ({ name: a.textContent.trim(), id: new URL(a.href).searchParams.get("dept") })));
  // The packing department has no products, so it is tried first; the others follow only on repeated runs.
  depts.sort((a, b) => (b.name === "אריזה") - (a.name === "אריזה"));
  const target = addDays(today, 3);

  // ---------- the form
  await open(target, depts[0].id);
  check("lock times start empty or as saved", await count("#lock-offset-0"), 1);
  const before = await page.locator("#lock-offset-2").inputValue();
  if (before === "") {
    await page.selectOption("#lock-offset-2", "1");
    await page.fill("#lock-time-2", "");
    check("a lock day without an hour is refused", (await saveTimes("alert")).includes("שעת נעילה"), true);
    await open(target, depts[0].id);
    check("and nothing was saved", await page.locator("#lock-offset-2").inputValue(), "");
  }

  // ---------- the scheduler locks by itself
  let lockedBy = null;
  search: for (const dept of depts) {
    for (const shift of [0, 1, 2]) {
      await open(target, dept.id);
      if ((await page.locator(`#lock-offset-${shift}`).inputValue()) !== "" || (await count(`[data-shift="${shift}"] [data-locked]`)) > 0) continue;
      // Three days before the delivery at 00:00 has already passed for every date up to three days from now.
      await page.selectOption(`#lock-offset-${shift}`, "3");
      await page.fill(`#lock-time-${shift}`, "00:00");
      await saveTimes("status");
      used = { dept: dept.id, shift, today };
      for (let i = 0; i < 7 && lockedBy === null; i++) {
        await page.waitForTimeout(4000);
        await open(target, dept.id);
        if ((await count(`[data-shift="${shift}"] [data-locked]`)) > 0) lockedBy = await text(`[data-shift="${shift}"] [data-locked]`);
      }
      if (lockedBy !== null) break search;
      // This plan was locked automatically on an earlier run today; put the setting back and try the next one.
      await page.selectOption(`#lock-offset-${shift}`, "");
      await saveTimes("status");
      used = null;
    }
  }
  check("the scheduler locked the plan with nobody pressing anything", lockedBy?.includes("אוטומטית") ?? false, true);
  if (used) {
    await open(target, used.dept);
    check("the saved lock time is shown", [await page.locator(`#lock-offset-${used.shift}`).inputValue(), await page.locator(`#lock-time-${used.shift}`).inputValue()], ["3", "00:00"]);
    check("today is locked as well", await (async () => { await open(today, used.dept); return count(`[data-shift="${used.shift}"] [data-locked]`); })(), 1);

    // ---------- a manager unlocks; it stays open
    await open(target, used.dept);
    await page.locator(`[data-shift="${used.shift}"] button:has-text("בטל נעילה")`).click();
    await page.waitForFunction((s) => !document.querySelector(`[data-shift="${s}"] [data-locked]`), used.shift);
    await page.waitForTimeout(25_000);
    await open(target, used.dept);
    check("a plan unlocked by hand is not locked again by the scheduler", await count(`[data-shift="${used.shift}"] [data-locked]`), 0);
  }
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  if (used) {
    try {
      await open(used.today, used.dept);
      await page.selectOption(`#lock-offset-${used.shift}`, "");
      await saveTimes("status");
      for (let n = 0; n <= 3; n++) {
        await open(addDays(used.today, n), used.dept);
        const unlock = page.locator(`[data-shift="${used.shift}"] button:has-text("בטל נעילה")`);
        if ((await unlock.count()) > 0) {
          await unlock.click();
          await page.waitForFunction((s) => !document.querySelector(`[data-shift="${s}"] [data-locked]`), used.shift);
        }
      }
    } catch {
      console.log("WARNING: a lock time set by this test may still be in place. Remove it on the production screen.");
    }
  }
  await browser.close();
}
console.log(failed ? `E2E AUTOLOCK FAILED (${failed})` : "E2E AUTOLOCK PASSED");
process.exit(failed ? 1 : 0);
