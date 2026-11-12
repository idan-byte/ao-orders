// End-to-end check of variants (fillings) in headless Edge: the product screen, mandatory variant choice in an
// order and in a standing order, the production plan split by variant, switching a variant off, and roles.
// It adds two variants to product 50021 and switches them off again at the end, so other tests are not affected.
// Needs the dev server on http://localhost:3000 with customers synced. Run from the web folder:  node scripts/e2e-variants.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const SKU = "50021";
const tag = Date.now() % 1000000;
const A = `טונה ${tag}`;
const B = `חביתה ${tag}`;
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
// A random far-future Tuesday that no other run is likely to share.
const first = new Date(Date.UTC(2040 + Math.floor(Math.random() * 50), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 20)));
first.setUTCDate(first.getUTCDate() + ((9 - first.getUTCDay()) % 7));
const DAY = first.toISOString().slice(0, 10);

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
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").trim();
const alertHas = (page, fragment) => page.waitForFunction((f) => [...document.querySelectorAll("main form [role=alert]")].some((a) => a.offsetParent && a.textContent.includes(f)), fragment);
const variantRow = (name) => `[data-variant="${name}"]`;
async function openProduct(page) {
  await page.goto(`${BASE}/catalog/${SKU}`);
  await page.waitForSelector("#variant-name");
}
async function addVariant(page, name) {
  await page.fill("#variant-name", name);
  await page.click("text=הוסף סוג");
  await page.waitForSelector(variantRow(name));
}
async function toggle(page, name, wanted) {
  await page.locator(`${variantRow(name)} button`).click();
  await page.waitForSelector(`${variantRow(name)}[data-active="${wanted}"]`);
}
async function startOrder(page) {
  await page.goto(BASE + "/orders/new");
  await page.waitForSelector("#order-customer");
  await page.selectOption("#order-customer", { index: 1 });
  await page.click("text=המשך");
  await page.waitForSelector("#q-add-line");
}

let created = false;
const admin = await signIn(ADMIN);
try {
  // ---------- the product screen
  await admin.goto(BASE + "/catalog");
  await admin.waitForSelector(`[data-product="${SKU}"]`);
  await admin.click(`[data-product="${SKU}"]`);
  await admin.waitForSelector("#variant-name");
  check("catalog links to the product screen", [new URL(admin.url()).pathname, (await text(admin, "main h1")).includes(SKU)], [`/catalog/${SKU}`, true]);
  const dept = await admin.locator("#ops-department").inputValue();
  check("the product is made by a department", dept !== "", true);
  const before = [dept, await admin.locator("#ops-shift").inputValue(), await admin.locator("#ops-orderable").isChecked()];
  await admin.click("main form button:has-text('שמור')");
  await admin.waitForSelector("main form [role=status]");
  await openProduct(admin);
  check("saving the production settings keeps them", [await admin.locator("#ops-department").inputValue(), await admin.locator("#ops-shift").inputValue(), await admin.locator("#ops-orderable").isChecked()], before);

  await admin.fill("#variant-name", "א");
  await admin.click("text=הוסף סוג");
  await alertHas(admin, "שם לסוג");
  check("a one-letter variant is refused", true, true);
  await addVariant(admin, A);
  await addVariant(admin, B);
  created = true;
  check("two variants are listed as active", [await admin.locator(variantRow(A)).getAttribute("data-active"), await admin.locator(variantRow(B)).getAttribute("data-active")], ["true", "true"]);

  // ---------- an order must choose a variant
  await startOrder(admin);
  await admin.click("#q-add-line");
  await admin.selectOption('[data-line-sku="0"]', SKU);
  await admin.waitForSelector('[data-line-variant="0"]');
  await admin.fill('[data-line-qty="0"]', "30");
  await admin.fill('[data-line-price="0"]', "6");
  await admin.fill("#q-delivery-date", DAY);
  await admin.click("button[value=save]");
  await alertHas(admin, "יש לבחור אחד מהם");
  check("an order line without a variant is refused", true, true);
  await admin.selectOption('[data-line-variant="0"]', { label: A });
  check("the description follows the variant", (await admin.locator('[aria-label="תיאור, שורה 1"]').inputValue()).endsWith(`· ${A}`), true);
  await admin.click("#q-add-line");
  await admin.selectOption('[data-line-sku="1"]', SKU);
  await admin.selectOption('[data-line-variant="1"]', { label: B });
  await admin.fill('[data-line-qty="1"]', "20");
  await admin.fill('[data-line-price="1"]', "6");
  await admin.click("#q-add-line");
  await admin.selectOption('[data-line-sku="2"]', "50088");
  check("a product without variants shows no variant choice", await count(admin, '[data-line-variant="2"]'), 0);
  await admin.fill('[data-line-qty="2"]', "5");
  await admin.fill('[data-line-price="2"]', "5");
  await admin.click("button[value=save]");
  await admin.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await admin.waitForSelector('[data-delivery="0"]');
  const orderUrl = admin.url();
  const card = await text(admin, '[data-delivery="0"]');
  check("the order card names both variants", [card.includes(A), card.includes(B)], [true, true]);

  // ---------- production plan splits by variant
  await admin.goto(`${BASE}/production?date=${DAY}&dept=${dept}`);
  await admin.waitForSelector(`[data-row^="${SKU}|"]`);
  const rows = await admin.locator(`[data-row^="${SKU}|"]:visible`).evaluateAll((els) => els.map((e) => [e.querySelector("[data-qty]").textContent.trim(), e.textContent]));
  check("production plan: one row per variant with its own quantity", rows.map(([qty, t]) => [qty, t.includes(A) ? "A" : t.includes(B) ? "B" : "?"]).sort(), [["20", "B"], ["30", "A"]]);

  // ---------- a standing order must choose a variant too
  await admin.goto(BASE + "/standing");
  await admin.waitForSelector("#standing-customer");
  await admin.selectOption("#standing-customer", { index: 1 });
  await admin.click("text=המשך");
  await admin.waitForSelector("#st-add-row");
  await admin.click("#st-add-row");
  await admin.selectOption('[data-st-sku="0"]', SKU);
  await admin.fill('[data-st-qty="0-2"]', "12");
  await admin.click("#st-save");
  await alertHas(admin, "יש לבחור אחד מהם");
  check("a standing order line without a variant is refused", true, true);
  await admin.selectOption('[data-st-variant="0"]', { label: B });
  await admin.click("#st-save");
  await admin.waitForURL(/\/standing\/[0-9a-f-]{36}$/);
  await admin.waitForSelector('[data-st-variant="0"]');
  check("the standing order remembers the variant", await admin.locator('[data-st-variant="0"] option:checked').textContent(), B);
  // End the standing order so it never generates orders in other tests.
  await admin.fill("#st-valid-from", "2030-01-01");
  await admin.fill("#st-valid-to", "2030-01-01");
  await admin.click("#st-save");
  await admin.waitForSelector("main form [role=status]");

  // ---------- switching variants off
  await openProduct(admin);
  check("the product screen counts where a variant is used", (await text(admin, variantRow(A))).includes("מופיע ב-"), true);
  await toggle(admin, A, "false");
  await toggle(admin, B, "false");
  created = false;
  await startOrder(admin);
  await admin.click("#q-add-line");
  await admin.selectOption('[data-line-sku="0"]', SKU);
  check("with the variants switched off, a new order offers no variant choice", await count(admin, '[data-line-variant="0"]'), 0);
  await admin.goto(orderUrl);
  await admin.waitForSelector("[data-edit]");
  await admin.click("[data-edit]");
  await admin.waitForSelector('[data-line-variant="0"]');
  check("the existing order still shows its variants", await admin.locator('[data-line-variant="0"] option:checked').textContent(), A);
  await admin.fill('[data-line-qty="0"]', "35");
  await admin.click("button[value=save]");
  await admin.waitForURL(orderUrl);
  await admin.waitForSelector('[data-delivery="0"]');
  check("and can still be changed with the switched-off variant", (await text(admin, '[data-delivery="0"]')).includes(A), true);

  // ---------- roles: an order clerk sees the catalog but cannot manage products
  const clerkMobile = rnd();
  await admin.goto(BASE + "/users");
  await admin.waitForSelector("#new-user-name");
  await admin.fill("#new-user-name", `פקיד ${tag}`);
  await admin.fill("#new-user-mobile", clerkMobile);
  await admin.selectOption("#new-user-role", "order_clerk");
  await admin.click("text=הוסף משתמש");
  await admin.waitForSelector(`text=פקיד ${tag}`);
  const clerk = await signIn(clerkMobile);
  await clerk.goto(BASE + "/catalog");
  await clerk.waitForSelector("main table");
  check("order clerk: catalog has no links to product screens", await count(clerk, "[data-product]"), 0);
  await clerk.goto(`${BASE}/catalog/${SKU}`);
  await clerk.waitForSelector("main h1");
  check("order clerk: the product screen is refused", await text(clerk, "main h1"), "אין הרשאה למסך הזה");
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  if (created) {
    // Never leave active variants behind: other tests order this product without one.
    try {
      await openProduct(admin);
      for (const name of [A, B]) if ((await count(admin, `${variantRow(name)}[data-active="true"]`)) > 0) await toggle(admin, name, "false");
    } catch {
      console.log(`WARNING: variants of ${SKU} from this run may still be active. Switch them off at /catalog/${SKU}.`);
    }
  }
  await browser.close();
}
console.log(failed ? `E2E VARIANTS FAILED (${failed})` : "E2E VARIANTS PASSED");
process.exit(failed ? 1 : 0);
