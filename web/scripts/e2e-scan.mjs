// End-to-end check in headless Edge of scanning delivery labels: the labels page, scanning by typing the code,
// scanning through the camera (a stand-in camera that shows a picture of one printed label), refused scans,
// and hand-over by scan after the route left.
// The test keeps one route ("קו בדיקה סריקה") and one driver ("נהג בדיקה סריקה") and switches them off at the end.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-scan.mjs
import { chromium } from "playwright-core";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const [ROUTE, DRIVER] = ["קו בדיקה סריקה", "נהג בדיקה סריקה"];
const tag = Date.now() % 1000000;
const DAY = new Date(Date.UTC(3800 + Math.floor(Math.random() * 200), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 20))).toISOString().slice(0, 10);
const routeCard = `[data-route="${ROUTE}"]`;
const driverCard = `[data-driver="${DRIVER}"]`;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
async function signIn(from = browser) {
  const page = await (await from.newContext({ locale: "he-IL" })).newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/login");
  await page.fill("#mobile", ADMIN);
  await page.click("button[value=request]");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("button[value=verify]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return page;
}
const count = (page, sel) => page.locator(sel).count();
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const admin = await signIn();
const go = async (page, path_, wait) => {
  await page.goto(BASE + path_);
  await page.waitForSelector(wait);
};
let customerIndex = 0;
async function newOrder() {
  for (;;) {
    await go(admin, "/orders/new", "#order-customer");
    await admin.selectOption("#order-customer", { index: ++customerIndex });
    await admin.click("text=המשך");
    await admin.waitForSelector("#q-add-line");
    if ((await count(admin, "#q-address option")) < 2) continue;
    await admin.selectOption("#q-address", { index: 1 });
    await admin.click("#q-add-line");
    await admin.selectOption('[data-line-sku="0"]', "50088");
    await admin.fill('[data-line-qty="0"]', "10");
    await admin.fill('[data-line-price="0"]', "5");
    await admin.fill("#q-delivery-date", DAY);
    await admin.click("button[value=save]");
    await admin.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
    await admin.waitForSelector('[data-delivery="0"]');
    return { number: (await text(admin, "main h1")).match(/\d{3,}/)[0] };
  }
}
/** Types a code into the scan panel and waits for the answer to that scan. */
async function typeScan(page, code) {
  const before = Number((await page.locator("#scan-result").getAttribute("data-count").catch(() => null)) ?? 0);
  await page.fill("#scan-input", code);
  await page.click("#scan-submit");
  await page.waitForSelector(`#scan-result[data-count="${before + 1}"]`);
  return [await page.locator("#scan-result").getAttribute("data-kind"), await text(page, "#scan-result")];
}
const marked = (page, number) => page.locator(`[data-delivery="${number}"]`).getAttribute("data-marked");

let made = false;
let tmp = null;
let cameraBrowser = null;
try {
  // ---------- driver, route, three orders on the route
  await go(admin, "/shipping/drivers", "#new-driver");
  if ((await count(admin, driverCard)) === 0) {
    await admin.fill("#new-driver [name=name]", DRIVER);
    await admin.fill("#new-driver [name=registration]", "99-999-03");
    await admin.click("#new-driver button");
    await admin.waitForSelector(driverCard);
  } else if ((await admin.locator(driverCard).getAttribute("data-active")) === "false") {
    await admin.locator(`${driverCard} button:has-text("החזר לפעילות")`).click();
    await admin.waitForSelector(`${driverCard}[data-active="true"]`);
  }
  made = true;
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
  const details = await admin.locator(`[data-route-card="${ROUTE}"]`).getAttribute("href");
  const work = details.replace("/shipping/day/", "/drive/");

  // ---------- the labels
  await go(admin, details, "#labels-link");
  await admin.click("#labels-link");
  await admin.waitForSelector("#labels-summary");
  const codes = {};
  for (const o of [a, b, c]) codes[o.number] = await admin.locator(`[data-label="${o.number}"]`).getAttribute("data-code");
  check("the labels page has one label per box, each with its own code and a QR", [await count(admin, "[data-label]"), Object.values(codes).every((x) => /^[0-9A-F]{10}$/.test(x)), new Set(Object.values(codes)).size, await count(admin, "[data-label] .label-qr svg")], [3, true, 3, 3]);
  check("the code is printed under the QR for typing", (await text(admin, `[data-label="${a.number}"] .label-code`)), `${codes[a.number].slice(0, 5)}-${codes[a.number].slice(5)}`);
  check("labels come in loading order, the last stop first", await admin.locator("[data-label]").evaluateAll((l) => l.map((x) => x.getAttribute("data-label"))), [c.number, b.number, a.number]);
  if (process.env.AO_SCREENSHOT) await admin.screenshot({ path: process.env.AO_SCREENSHOT.replace(/\.png$/, "-labels.png"), fullPage: true });
  // A picture of one printed label, for the stand-in camera.
  // ---------- deliveries in several boxes: every box has its own label and its own code
  const setBoxes = async (o, n) => {
    const row = admin.locator(`[data-packages="${o.number}"]`);
    await row.locator("[name=packages]").fill(String(n));
    await row.locator("button").click();
    await admin.waitForSelector(`[data-label="${o.number}"][data-box="${n}"]`);
    return admin.locator(`[data-label="${o.number}"]:visible`).evaluateAll((l) => l.map((x) => x.getAttribute("data-code")));
  };
  const cBoxes = await setBoxes(c, 3);
  const aBoxes = await setBoxes(a, 2);
  check("three boxes print three numbered labels with three different codes; the first keeps the delivery's code", [await count(admin, "[data-label]"), new Set(cBoxes).size, cBoxes[0] === codes[c.number], aBoxes.length, aBoxes[0] === codes[a.number], aBoxes[1] !== aBoxes[0], await text(admin, `[data-label="${c.number}"][data-box="2"] .label-package`)], [6, 3, true, 2, true, true, "ארגז 2 מתוך 3"]);
  await admin.click('#label-format a:has-text("102×150")');
  await admin.waitForSelector(".label-single");
  const box = await admin.locator(".label-single [data-label]").first().evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width / r.height * 100) / 100, getComputedStyle(el).flexDirection]; });
  check("the label printer's size is one tall label of 102 by 150", [box, await count(admin, ".label-single [data-label]")], [[0.68, "column"], 6]);
  if (process.env.AO_SCREENSHOT) await admin.screenshot({ path: process.env.AO_SCREENSHOT.replace(/.png$/, "-single.png"), fullPage: true });
  // The QR is drawn alone on a page of its own, at an even size, as the stand-in camera needs.
  const sheet = await admin.context().newPage();
  await sheet.setContent(`<body style="margin:0;background:#fff"><div id="q" style="width:480px;height:480px">${await admin.locator(`[data-label="${b.number}"] .label-qr`).innerHTML()}</div></body>`);
  const picture = await sheet.locator("#q").screenshot({ type: "jpeg", quality: 92 });
  await sheet.close();
  tmp = await mkdtemp(path.join(os.tmpdir(), "ao-scan-"));
  const film = path.join(tmp, "label.mjpeg").split(path.sep).join("/");
  await writeFile(film, picture);

  // ---------- scanning by typing the code (also what a handheld scanner does)
  await go(admin, work, "#scan");
  check("the route's screen has the scan panel, in loading mode", [(await text(admin, "#scan h2")), await admin.locator("#scan").getAttribute("data-camera")], ["סריקת מדבקה · העמסה", "off"]);
  const first = await typeScan(admin, `${aBoxes[0].slice(0, 5)}-${aBoxes[0].slice(5)}`.toLowerCase());
  await admin.waitForSelector(`[data-delivery="${a.number}"][data-boxes="1/2"]`);
  check("the first of two boxes is taken, but the delivery is not loaded: one box is still missing", [first[0], first[1].includes("ארגז 1 מתוך 2 הועמס. חסרים עוד 1."), first[1].includes(`הזמנה ${a.number}`), await marked(admin, a.number), await text(admin, `[data-delivery="${a.number}"] [data-partial]`), await text(admin, "#progress")], ["partial", true, true, "false", "הועמסו 1 מתוך 2 ארגזים · חסרים 1", "הועמסו 0 מתוך 3 · טרם התחיל"]);
  check("the list of what is missing before leaving counts the boxes", (await text(admin, "#depart")).includes(`הזמנה ${a.number} · הועמסו 1 מתוך 2 ארגזים`), true);
  const again = await typeScan(admin, aBoxes[0]);
  check("the same box again is answered, not counted twice", [again[0], again[1].includes("ארגז 1 מתוך 2 כבר נסרק. חסרים עוד 1."), await admin.locator(`[data-delivery="${a.number}"]`).getAttribute("data-boxes")], ["already", true, "1/2"]);
  const second = await typeScan(admin, aBoxes[1]);
  await admin.waitForSelector(`[data-delivery="${a.number}"][data-marked="true"]`);
  check("the second box completes the delivery", [second[0], second[1].includes("כל הארגזים של האספקה על הרכב"), await text(admin, "#progress")], ["done", true, "הועמסו 1 מתוך 3 · בתהליך"]);
  const junk = await typeScan(admin, "https://example.com/menu");
  check("something that is not a label is refused", [junk[0], junk[1].includes("אינו מדבקת ארגז")], ["refused", true]);
  if (process.env.AO_SCREENSHOT) {
    await admin.setViewportSize({ width: 390, height: 844 });
    await admin.screenshot({ path: process.env.AO_SCREENSHOT, fullPage: true });
    await admin.setViewportSize({ width: 1280, height: 720 });
  }

  // ---------- scanning through the camera
  cameraBrowser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${film}`] });
  const phone = await signIn(cameraBrowser);
  await go(phone, work, "#scan");
  await phone.click("#scan-camera");
  await phone.waitForSelector('#scan[data-camera="on"]');
  await phone.waitForSelector(`[data-delivery="${b.number}"][data-marked="true"]`, { timeout: 20000 });
  check("the camera reads the printed label and marks that delivery", [await phone.locator("#scan-result").getAttribute("data-kind"), (await text(phone, "#scan-result")).includes(`הזמנה ${b.number}`), await text(phone, "#progress")], ["done", true, "הועמסו 2 מתוך 3 · בתהליך"]);
  await phone.waitForTimeout(1500);
  check("a label that stays in front of the camera is read once", await phone.locator("#scan-result").getAttribute("data-count"), "1");
  await phone.click("#scan-stop");
  check("the camera can be closed", await phone.locator("#scan").getAttribute("data-camera"), "off");
  await cameraBrowser.close();
  cameraBrowser = null;

  // ---------- the route leaves without the third delivery, and scans now mean hand-over
  await go(admin, work, "#depart");
  await admin.fill("#depart [name=reason]", `בדיקת סריקה ${tag}`);
  await admin.click("#depart button");
  await admin.waitForSelector('#route-state[data-mode="unloading"]');
  await admin.waitForSelector("#scan");
  check("after leaving, the panel is in hand-over mode", await text(admin, "#scan h2"), "סריקת מדבקה · מסירה");
  const handed = await typeScan(admin, aBoxes[1]);
  await admin.waitForSelector(`[data-delivery="${a.number}"][data-boxes="1/2"]`);
  check("at the customer one box of two does not deliver the delivery", [handed[0], handed[1].includes("ארגז 2 מתוך 2 נמסר. חסרים עוד 1."), await marked(admin, a.number), await text(admin, "#progress")], ["partial", true, "false", "נמסרו 0 מתוך 2 · טרם התחיל"]);
  const handedAll = await typeScan(admin, aBoxes[0]);
  await admin.waitForSelector(`[data-delivery="${a.number}"][data-marked="true"]`);
  check("the other box delivers it", [handedAll[0], handedAll[1].includes("כל הארגזים של האספקה נמסרו"), await text(admin, "#progress")], ["done", true, "נמסרו 1 מתוך 2 · בתהליך"]);
  const left = await typeScan(admin, codes[c.number]);
  check("the label of a delivery that is not on this route is refused", [left[0], left[1].includes("אינה משובצת לקו הזה")], ["refused", true]);
  await typeScan(admin, codes[b.number]);
  await admin.waitForSelector(`[data-delivery="${b.number}"][data-marked="true"]`);
  check("the last scan completes the route", [await text(admin, "#progress"), await marked(admin, a.number)], ["נמסרו 2 מתוך 2 · הושלם", "true"]);
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  if (cameraBrowser) await cameraBrowser.close().catch(() => {});
  if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (made) {
    try {
      // Alerts that belong to test routes are marked handled, so the real screen stays clean.
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
console.log(failed ? `E2E SCAN FAILED (${failed})` : "E2E SCAN PASSED");
process.exit(failed ? 1 : 0);
