// End-to-end check in headless Edge of letterheads ("logo pages"), the quote PDF and emailing a quote.
// No real email is sent: the dev server has no mail server configured, so the message lands in web/.data/outbox.
// The test keeps one letterhead named "בדיקה אוטומטית" and switches it off at the end.
// Run from the web folder:  node scripts/e2e-letterheads.mjs
import { chromium } from "playwright-core";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const NAME = "בדיקה אוטומטית";
const tag = Date.now() % 1000000;
const TITLE = `A&O מגשי אירוח ${tag}`;
const rnd = () => "05" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const card = `[data-letterhead="${NAME}"]`;

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
async function openLetterheads(page) {
  await page.goto(BASE + "/letterheads");
  await page.waitForSelector("#new-letterhead");
}
// The PDF as the browser session downloads it: status, type and the raw bytes as latin-1 text.
const pdfOf = (page, url) =>
  page.evaluate(async (u) => {
    const r = await fetch(u);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let body = "";
    for (let i = 0; i < bytes.length; i += 8192) body += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { status: r.status, type: r.headers.get("content-type"), head: body.slice(0, 5), image: body.includes("/Subtype /Image") || body.includes("/Subtype/Image"), size: bytes.length };
  }, url);

const admin = await signIn(ADMIN);
let active = false;
try {
  // ---------- the letterheads screen
  await admin.goto(BASE + "/quotes");
  await admin.waitForSelector("#letterheads-link");
  await admin.click("#letterheads-link");
  await admin.waitForSelector("#new-letterhead");
  check("there is a default letterhead", await count(admin, '[data-default="true"]'), 1);
  if ((await count(admin, card)) === 0) {
    await admin.fill("#new-letterhead [name=name]", NAME);
    await admin.fill("#new-letterhead [name=title]", TITLE);
    await admin.click("#new-letterhead button");
    await admin.waitForSelector(card);
  } else if ((await admin.locator(card).getAttribute("data-active")) === "false") {
    await admin.locator(`${card} button:has-text("החזר לשימוש")`).click();
    await admin.waitForSelector(`${card}[data-active="true"]`);
  }
  active = true;
  await admin.locator(`${card} form:has([name=title]) [name=title]`).fill(TITLE);
  await admin.locator(`${card} form:has([name=title]) [name=footer]`).fill(`תודה שבחרתם בנו ${tag}`);
  await admin.locator(`${card} form:has([name=title]) button`).click();
  await admin.waitForSelector(`${card} form:has([name=title]) [role=status]`);
  check("letterhead details are saved", true, true);

  // A file that only claims to be an image is refused; a real PNG is accepted.
  await admin.locator(`${card} input[type=file]`).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") });
  await admin.locator(`${card} form:has(input[type=file]) button`).click();
  await admin.waitForSelector(`${card} form:has(input[type=file]) [role=alert]`);
  check("a file that is not really an image is refused", (await text(admin, `${card} form:has(input[type=file]) [role=alert]`)).includes("אינו תמונה"), true);
  const png = await admin.screenshot({ clip: { x: 0, y: 0, width: 240, height: 60 } });
  await openLetterheads(admin);
  await admin.locator(`${card} input[type=file]`).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  await admin.locator(`${card} form:has(input[type=file]) button`).click();
  await admin.waitForSelector(`${card} form:has(input[type=file]) [role=status]`);
  await openLetterheads(admin);
  const logoSrc = await admin.locator(`${card} img[data-logo]`).getAttribute("src");
  check("the uploaded logo is shown on its letterhead", [/^\/letterheads\/\d+\/logo\?v=\d+$/.test(logoSrc), await admin.locator(`${card} img[data-logo]`).evaluate((i) => i.complete && i.naturalWidth)], [true, 240]);
  const anon = await (await browser.newContext({ locale: "he-IL" })).newPage();
  const logoResponse = await anon.goto(BASE + logoSrc);
  check("the logo itself is public, since customers see it", [logoResponse.status(), logoResponse.headers()["content-type"]], [200, "image/png"]);

  // ---------- a quote chooses its letterhead
  await admin.goto(BASE + "/quotes");
  await admin.waitForSelector("#new-quote-customer");
  await admin.selectOption("#new-quote-customer", { index: 1 });
  await admin.click("text=פתח הצעה");
  await admin.waitForURL(/\/quotes\/[0-9a-f-]{36}$/);
  await admin.waitForSelector("#q-add-line");
  const quoteUrl = admin.url();
  await admin.click("#q-add-line");
  await admin.selectOption('[data-line-sku="0"]', "50088");
  await admin.fill('[data-line-qty="0"]', "12");
  await admin.fill('[data-line-price="0"]', "5");
  await admin.fill("#q-delivery-date", "2031-03-04");
  await admin.click("button[value=send]");
  await admin.waitForSelector("input[aria-label='קישור לאישור ההצעה']");
  await admin.waitForFunction(() => document.querySelector("input[aria-label='קישור לאישור ההצעה']").value.startsWith("http"));
  const publicUrl = await admin.inputValue("input[aria-label='קישור לאישור ההצעה']");
  const pdfUrl = new URL(quoteUrl).pathname + "/pdf";

  const plain = await pdfOf(admin, pdfUrl);
  check("PDF downloads as a real PDF file", [plain.status, plain.type, plain.head, plain.size > 5000], [200, "application/pdf", "%PDF-", true]);
  const defaultHasLogo = (await count(admin, "article.quote-doc [data-letterhead] img")) > 0;

  await admin.selectOption("#letterhead-select", { label: NAME });
  await admin.click("#quote-letterhead button");
  await admin.waitForSelector("#quote-letterhead [role=status]");
  await admin.goto(quoteUrl);
  await admin.waitForSelector("article.quote-doc");
  check("the quote is shown under the chosen letterhead, with its logo and footer", [await admin.locator("article.quote-doc [data-letterhead]").getAttribute("data-letterhead"), await count(admin, "article.quote-doc [data-letterhead] img"), (await text(admin, "article.quote-doc footer")).includes(String(tag))], [NAME, 1, true]);
  const branded = await pdfOf(admin, pdfUrl);
  check("the PDF of that quote carries the logo image", [branded.head, branded.image], ["%PDF-", true]);
  if (!defaultHasLogo) check("and the PDF under a letterhead without a logo had no image", plain.image, false);

  await anon.goto(publicUrl);
  await anon.waitForSelector("article.quote-doc");
  check("the customer sees the same letterhead on the approval link", [await anon.locator("article.quote-doc [data-letterhead]").getAttribute("data-letterhead"), await anon.locator("article.quote-doc [data-letterhead] img").evaluate((i) => i.complete && i.naturalWidth > 0)], [NAME, true]);
  check("PDF needs a login", (await anon.goto(BASE + pdfUrl)).status(), 401);
  await anon.goto(`${BASE}/quotes/render/${"x".repeat(43)}`);
  await anon.waitForSelector("main p");
  check("the internal render address is useless without a live key", [await text(anon, "main p"), await count(anon, "article.quote-doc")], ["הקישור אינו בתוקף.", 0]);

  // ---------- email (nothing leaves the machine: no mail server is configured in development)
  const outbox = path.join(process.cwd(), ".data", "outbox");
  const before = new Set(await readdir(outbox).catch(() => []));
  await admin.goto(quoteUrl);
  await admin.waitForSelector("#email-to");
  await admin.fill("#email-to", "customer@example.com");
  await admin.fill("#email-message", `בהמשך לשיחתנו ${tag}`);
  await admin.click("#quote-email button");
  await admin.waitForSelector("#quote-email [role=status], #quote-email [role=alert]", { timeout: 60_000 });
  check("without a mail server the screen says the email was not sent", (await text(admin, "#quote-email [role=status], #quote-email [role=alert]")).includes("לא הוגדר שרת דואר"), true);
  await admin.goto(quoteUrl);
  await admin.waitForSelector("[data-emails]");
  check("the attempt is listed on the quote", [await count(admin, '[data-emails] li[data-email-status="not_sent_dev"]'), (await text(admin, "[data-emails] li")).includes("customer@example.com")], [1, true]);
  const fresh = (await readdir(outbox)).filter((f) => !before.has(f));
  const txt = fresh.find((f) => f.endsWith(".txt"));
  const pdf = fresh.find((f) => f.endsWith(".pdf"));
  const message = txt ? await readFile(path.join(outbox, txt), "utf8") : "";
  check("the saved message has the recipient, the personal note and the letterhead's business name", [message.includes("To: customer@example.com"), message.includes(`בהמשך לשיחתנו ${tag}`), message.includes(TITLE)], [true, true, true]);
  check("no approval link is promised while the system has no public address", message.includes("/q/"), false);
  check("the PDF was attached", [pdf ? (await readFile(path.join(outbox, pdf))).subarray(0, 5).toString("latin1") : null, pdf ? (await stat(path.join(outbox, pdf))).size > 5000 : false], ["%PDF-", true]);

  // ---------- back to the default; a letterhead in use cannot vanish
  await admin.selectOption("#letterhead-select", "");
  await admin.click("#quote-letterhead button");
  await admin.waitForSelector("#quote-letterhead [role=status]");
  await admin.goto(quoteUrl);
  await admin.waitForSelector("article.quote-doc");
  check("the quote returns to the default letterhead", (await admin.locator("article.quote-doc [data-letterhead]").getAttribute("data-letterhead")) !== NAME, true);

  // ---------- roles
  const salesMobile = rnd();
  await admin.goto(BASE + "/users");
  await admin.waitForSelector("#new-user-name");
  await admin.fill("#new-user-name", `מכירות ${tag}`);
  await admin.fill("#new-user-mobile", salesMobile);
  await admin.selectOption("#new-user-role", "sales");
  await admin.click("text=הוסף משתמש");
  await admin.waitForSelector(`text=מכירות ${tag}`);
  const sales = await signIn(salesMobile);
  await sales.goto(BASE + "/letterheads");
  await sales.waitForSelector("main h1");
  check("sales cannot manage letterheads", await text(sales, "main h1"), "אין הרשאה למסך הזה");
  await sales.goto(quoteUrl);
  await sales.waitForSelector("#letterhead-select");
  check("but sales can choose a letterhead for a quote", (await sales.locator("#letterhead-select option").allTextContents()).includes(NAME), true);
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  if (active) {
    try {
      await openLetterheads(admin);
      if ((await admin.locator(card).getAttribute("data-default")) === "false") {
        await admin.locator(`${card} button:has-text("הפסק להציע")`).click();
        await admin.waitForSelector(`${card}[data-active="false"]`);
      }
    } catch {
      console.log(`WARNING: the test letterhead "${NAME}" may still be active. Switch it off at /letterheads.`);
    }
  }
  await browser.close();
}
console.log(failed ? `E2E LETTERHEADS FAILED (${failed})` : "E2E LETTERHEADS PASSED");
process.exit(failed ? 1 : 0);
