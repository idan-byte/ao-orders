// End-to-end check in headless Edge of the communication settings: adding and removing incoming sources,
// choosing the source when an inquiry is opened, and the sender of documents. No email is sent.
// Everything the test adds uses the reserved example.co.il domain and a random number, and is removed at the end;
// the sender of documents is put back to what it was.
// Needs the dev server on http://localhost:3000. Run from the web folder:  node scripts/e2e-comm.mjs
import { chromium } from "playwright-core";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const SHOT = process.env.AO_SCREENSHOT;
const tag = Date.now() % 1000000;
const EMAIL = `test-${tag}@example.co.il`;
const PHONE = "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const PHONE_SHOWN = `${PHONE.slice(0, 3)}-${PHONE.slice(3)}`;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
async function signIn(mobile) {
  const page = await (await browser.newContext({ locale: "he-IL", viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(BASE + "/login");
  await page.fill("#mobile", mobile);
  await page.click("button[value=request]");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("button[value=verify]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return page;
}
const admin = await signIn(ADMIN);
const count = (sel) => admin.locator(sel).count();
const text = async (sel) => (await admin.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const go = async (path, wait) => {
  await admin.goto(BASE + path);
  await admin.waitForSelector(wait);
};
const row = (address) => `[data-channel="${address}"]`;
async function add(kind, address, label) {
  await admin.selectOption("#new-channel [name=kind]", kind);
  await admin.fill("#new-channel [name=address]", address);
  await admin.fill("#new-channel [name=label]", label);
  await admin.click("#new-channel button");
}
const press = async (address, name, wait) => {
  await admin.locator(`${row(address)} button:has-text("${name}")`).click();
  await wait();
};

let before = null;
try {
  // ---------- the screen is under the settings cog
  await go("/", "header [data-nav-group]");
  await admin.click('header button[aria-label="הגדרות"]');
  await admin.click('header nav[aria-label="הגדרות"] a:has-text("ניהול תקשורת")');
  await admin.waitForURL(BASE + "/communication");
  await admin.waitForSelector("#new-channel");
  check("the screen opens from the settings cog", await text("main h1:visible"), "ניהול תקשורת");
  check("the screen says plainly what is not connected yet", [(await text("#incoming-status")).includes("עוד לא מחוברת"), (await text('[data-status="whatsapp"]')).includes("עוד לא מחוברת")], [true, true]);
  before = { email: await admin.inputValue("#outgoing [name=email]"), name: await admin.inputValue("#outgoing [name=email_name]"), whatsapp: await admin.inputValue("#outgoing [name=whatsapp]") };

  // ---------- incoming sources
  await add("email", "not-an-address", "");
  await admin.waitForSelector("#new-channel [role=alert]");
  check("a bad email address is refused", await text("#new-channel [role=alert]"), "כתובת המייל אינה תקינה.");
  await add("email", EMAIL.toUpperCase(), `בדיקה ${tag}`);
  await admin.waitForSelector(row(EMAIL));
  check("an email source is added, in lower case, with its purpose", [(await text(row(EMAIL))).startsWith(`${EMAIL} · בדיקה ${tag} · פעיל`), await admin.locator(row(EMAIL)).getAttribute("data-kind")], [true, "email"]);
  await add("whatsapp", PHONE_SHOWN, "");
  await admin.waitForSelector(row(PHONE));
  check("a WhatsApp number is added under its own heading", [(await text(row(PHONE))).startsWith(`${PHONE_SHOWN} · פעיל`), await count(`[data-kind-list="whatsapp"] ${row(PHONE)}`)], [true, 1]);
  await add("whatsapp", "+972" + PHONE.slice(1), "");
  await admin.waitForSelector("#new-channel [role=alert]");
  check("the same number in another form is refused", await text("#new-channel [role=alert]"), "המספר הזה כבר ברשימה.");
  if (SHOT) await admin.screenshot({ path: SHOT, fullPage: true });

  // ---------- an inquiry that arrived at a source
  await go("/sales", "#lead-channel");
  const options = (await admin.locator("#lead-channel option").allTextContents()).map((s) => s.trim());
  check("the new inquiry form offers the sources", [options[0], options.includes(`מייל · ${EMAIL} · בדיקה ${tag}`), options.includes(`וואטסאפ · ${PHONE_SHOWN}`)], ["לא צוין", true, true]);
  await admin.fill("#lead-name", `פונה בדיקה ${tag}`);
  await admin.selectOption("#lead-source", "מייל");
  await admin.selectOption("#lead-channel", { label: `מייל · ${EMAIL} · בדיקה ${tag}` });
  await admin.fill("#lead-summary", "בדיקת מקור קליטה");
  await admin.click("text=פתח פנייה");
  await admin.waitForURL(/\/sales\/[0-9a-f-]{36}$/);
  await admin.waitForSelector("#lead-channel-text");
  check("the inquiry shows where it arrived", await text("#lead-channel-text"), `· התקבל ב: מייל · ${EMAIL} · בדיקה ${tag}`);

  await go("/communication", "#new-channel");
  check("the source counts its inquiries and can no longer be deleted", [(await text(row(EMAIL))).includes("1 פניות"), await count(`${row(EMAIL)} button:has-text("מחק")`)], [true, 0]);
  await press(EMAIL, "הפסק להשתמש", () => admin.waitForSelector(`${row(EMAIL)}[data-active="false"]`));
  await go("/sales", "#lead-channel");
  check("a source that is switched off is not offered for new inquiries", (await admin.locator("#lead-channel option").allTextContents()).some((s) => s.includes(EMAIL)), false);

  // ---------- the sender of documents
  await go("/communication", "#new-channel");
  await admin.fill("#outgoing [name=email]", "wrong");
  await admin.locator("#outgoing [name=email]").evaluate((el) => (el.type = "text"));
  await admin.click("#outgoing form button");
  await admin.waitForSelector("#outgoing [role=alert]");
  check("a bad sender address is refused", await text("#outgoing [role=alert]"), "כתובת המייל אינה תקינה.");
  await admin.fill("#outgoing [name=email]", `Sender-${tag}@Example.co.il`);
  await admin.fill("#outgoing [name=email_name]", `שולח בדיקה ${tag}`);
  await admin.fill("#outgoing [name=whatsapp]", PHONE_SHOWN);
  await admin.click("#outgoing form button");
  await admin.waitForSelector("#outgoing [role=status]");
  await go("/communication", "#new-channel");
  check("the sender is kept", [await admin.inputValue("#outgoing [name=email]"), await admin.inputValue("#outgoing [name=email_name]"), await admin.inputValue("#outgoing [name=whatsapp]")], [`sender-${tag}@example.co.il`, `שולח בדיקה ${tag}`, PHONE_SHOWN]);
  check("and the screen says in whose name documents go out", [(await text('[data-status="email"]')).includes(`מסמכים יוצאים בשם sender-${tag}@example.co.il`), (await text('[data-status="whatsapp"]')).includes(`החשבון שנבחר הוא ${PHONE_SHOWN}`)], [true, true]);

  // ---------- who may open the screen
  const mobile = "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await go("/users", "#new-user-name");
  await admin.fill("#new-user-name", `פקיד תקשורת ${tag}`);
  await admin.fill("#new-user-mobile", mobile);
  await admin.selectOption("#new-user-role", "order_clerk");
  await admin.click("text=הוסף משתמש");
  await admin.waitForSelector(`text=פקיד תקשורת ${tag}`);
  const clerk = await signIn(mobile);
  await clerk.goto(BASE + "/communication");
  await clerk.waitForSelector("main h1");
  check("an order clerk has no access and no settings cog", [(await clerk.locator("main h1").first().textContent()).trim(), await clerk.locator('header button[aria-label="הגדרות"]').count()], ["אין הרשאה למסך הזה", 0]);
} finally {
  try {
    await go("/communication", "#new-channel");
    if (before) {
      await admin.fill("#outgoing [name=email]", before.email);
      await admin.fill("#outgoing [name=email_name]", before.name);
      await admin.fill("#outgoing [name=whatsapp]", before.whatsapp);
      await admin.click("#outgoing form button");
      await admin.waitForSelector("#outgoing [role=status]");
    }
    if ((await count(`${row(PHONE)} button:has-text("מחק")`)) > 0) {
      await admin.locator(`${row(PHONE)} button:has-text("מחק")`).click();
      await admin.waitForFunction((sel) => !document.querySelector(sel), row(PHONE));
    }
    if ((await count(`${row(EMAIL)}[data-active="true"]`)) > 0) await press(EMAIL, "הפסק להשתמש", () => admin.waitForSelector(`${row(EMAIL)}[data-active="false"]`));
    if ((await count(`${row(EMAIL)} button:has-text("מחק")`)) > 0) {
      await admin.locator(`${row(EMAIL)} button:has-text("מחק")`).click();
      await admin.waitForFunction((sel) => !document.querySelector(sel), row(EMAIL));
    }
  } catch {
    console.log("WARNING: test sources or a test sender may be left at /communication. Remove them there.");
  }
  await browser.close();
}
console.log(failed ? `E2E COMM FAILED (${failed})` : "E2E COMM PASSED");
process.exit(failed ? 1 : 0);
