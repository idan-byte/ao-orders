// End-to-end check in headless Edge of the Milgam screens: loading a forecast file and a daily order file,
// rows held for review, forecast against order, the institutions list with the allergy remark, and mapping a
// meal type to a catalogue item. The files are built here with made-up data.
// The test keeps two institutions ("מוסד בדיקה א", "מוסד בדיקה ב") and two meal types ("מנת בדיקה ...");
// its days are in the 1950s to 1990s, so they stay at the bottom of the real list.
// Needs the dev server on http://localhost:3000. Run from the web folder:  node scripts/e2e-milgam.mjs
import { chromium } from "playwright-core";
import { workbook } from "./xlsx-write.mjs";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const tag = Date.now() % 1000000;
const year = 1950 + Math.floor(Math.random() * 49);
const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
const [D1, D2] = [`${year}-${month}-10`, `${year}-${month}-11`];
const il = (d) => d.split("-").reverse().join("/");
const [MEAL_A, MEAL_B] = ["מנת בדיקה רגילה", "מנת בדיקה צמחונית"];
const NOTE = `א1- ללא ביצים ${tag}\r\nב1- ללא שומשום (טחינה, ממרח חומוס)`;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const HEAD = ["רשות", "סמל מוסד", "שם מוסד", "סוג מוסד", "תוכנית הזנה", "כתה", "סוג מנה", "כתובת לאספקה", "סוג כשרות", "כשרות", "הערות", "יש אלרגיות מסכנות חיים"];
const row = (symbol, name, cls, meal, q, notes = "", flag = "לא") => ["עיר בדיקה", symbol, name, "בית ספר", "תוכנית בדיקה", cls, meal, "רחוב הבדיקה 1", "רבנות", "רגילה", notes, flag, ...q];
const file = (name, grid) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(workbook(grid)) });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ locale: "he-IL" })).newPage();
const text = async (sel) => (await page.locator(sel).first().textContent()).replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const go = async (path, wait) => {
  await page.goto(BASE + path);
  await page.waitForSelector(wait);
};
async function upload(kind, f, addNew) {
  await go("/hotfood/milgam", "#milgam-upload");
  await page.selectOption("#milgam-upload [name=kind]", kind);
  await page.setInputFiles("#milgam-upload [name=file]", f);
  await page.locator("#milgam-upload [name=add_new]").setChecked(addNew);
  await page.click("#milgam-upload button");
  await page.waitForSelector("#milgam-upload [role=status], #milgam-upload [role=alert]");
  return text("#milgam-upload [role=status], #milgam-upload [role=alert]");
}
const dayRow = async (d) => {
  await go(`/hotfood/milgam?day=${d}`, "#milgam-days");
  const r = page.locator(`[data-day="${d}"]:visible`);
  return (await r.count()) === 0 ? null : [(await r.locator("[data-forecast]").textContent()).trim(), (await r.locator("[data-ordered]").textContent()).trim(), (await r.locator("[data-diff]").textContent()).trim()];
};
try {
  await page.goto(BASE + "/login");
  await page.fill("#mobile", ADMIN);
  await page.click("button[value=request]");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("button[value=verify]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.waitForSelector('header [data-nav-group="אוכל חם"]');
  check("the menu has the hot food group", await page.locator('header [data-nav-group="אוכל חם"] a').allTextContents(), ["מילגם", "מוסדות", "סוגי מנה", "תפריטים", "מנות ומשקלים"]);

  // ---------- a file that is not a Milgam file
  const notExcel = await upload("forecast", { name: "x.xlsx", mimeType: "text/plain", buffer: Buffer.from("סמל מוסד,כתה") }, false);
  check("a file that is not Excel is refused with a reason", notExcel, "הקובץ אינו קובץ אקסל (xlsx).");
  const noSymbol = await upload("forecast", file("אחר.xlsx", [["שם", "כמות"], ["x", "1"]]), false);
  check("an Excel file without the institution symbol is refused", noSymbol.includes("סמל מוסד"), true);

  // ---------- the forecast
  const stranger = `זר-${tag}`;
  const forecast = [
    [...HEAD, il(D1), il(D2)],
    row("בדיקה-1", "מוסד בדיקה א", "א1", MEAL_A, ["20", "20"], NOTE, "כן"),
    row("בדיקה-1", "מוסד בדיקה א", "א1", MEAL_B, ["3", "3"], NOTE, "כן"),
    row("בדיקה-1", "מוסד בדיקה א", "ב1", MEAL_A, ["18", ""], NOTE, "כן"),
    row("בדיקה-2", "מוסד בדיקה ב", "גן חובה", MEAL_A, ["30", "30"]),
    row(stranger, "מוסד שלא קיים", "א1", MEAL_A, ["7", "7"]),
  ];
  // The two test institutions are added on the first run ever; the stranger is in a file of its own and never added.
  const first = await upload("forecast", file("צפי בדיקה.xlsx", forecast.slice(0, 5)), true);
  check("the forecast is taken in", first, "נקלטו 124 מנות ב-2 ימים.");
  const second = await upload("forecast", file("צפי בדיקה.xlsx", forecast), false);
  check("loading again with an unknown institution: the known rows are taken, the unknown one waits", second, "נקלטו 124 מנות ב-2 ימים. 1 שורות לא נקלטו ומחכות לבדיקה, ראו למטה.");
  check("the held row is shown with its reason and its portions", [await page.locator(`#milgam-held [data-held="${stranger}"]`).count(), (await text("#milgam-held")).includes("מוסד לא מוכר"), (await text(`#milgam-held [data-held="${stranger}"]`)).includes("14 מנות")], [1, true, true]);
  check("the days show the forecast, not doubled by the second load, and no order yet", [await dayRow(D1), await dayRow(D2)], [["71", "טרם נטענה", ""], ["53", "טרם נטענה", ""]]);

  // ---------- the daily order
  const daily = [[...HEAD, il(D1)], row("בדיקה-1", "מוסד בדיקה א", "א1", MEAL_A, ["24"], NOTE, "כן"), row("בדיקה-1", "מוסד בדיקה א", "ב1", MEAL_A, ["18"], NOTE, "כן"), row("בדיקה-2", "מוסד בדיקה ב", "גן חובה", MEAL_A, ["26"])];
  check("the daily order is taken in", await upload("daily", file("הזמנה בדיקה.xlsx", daily), false), "נקלטו 68 מנות ב-1 ימים.");
  check("the held list is gone once a clean file was loaded", await page.locator("#milgam-held:visible").count(), 0);
  check("the day shows forecast, order and the difference; the next day still has only a forecast", [await dayRow(D1), await dayRow(D2)], [["71", "68", "−3"], ["53", "טרם נטענה", ""]]);
  await go(`/hotfood/milgam?day=${D1}`, "#milgam-day");
  const cells = (meal) => page.locator(`#milgam-day [data-meal="${meal}"] td`).allTextContents().then((l) => l.map((x) => x.trim()).slice(2));
  check("by meal type: the vegetarian portions were forecast and not ordered", [await cells(MEAL_A), await cells(MEAL_B), (await page.locator("#milgam-day [data-meal-total] td").allTextContents()).slice(2)], [["68", "68", "0"], ["3", "0", "−3"], ["71", "68", "−3"]]);
  check("the loads are listed, newest first", [await page.locator("#milgam-imports [data-import]").first().getAttribute("data-import"), (await text("#milgam-imports li")).includes("הזמנה בדיקה.xlsx")], ["daily", true]);

  // ---------- institutions
  await go("/hotfood/institutions", "#institutions-summary");
  const card = page.locator('[data-institution="בדיקה-1"]:visible');
  check("the institution shows the allergy warning and the whole remark, on two lines", [await card.getAttribute("data-allergy"), (await card.textContent()).includes("אלרגיות מסכנות חיים"), (await card.locator("[data-notes]").innerText()).split("\n").map((l) => l.trim())], ["true", true, [`א1- ללא ביצים ${tag}`, "ב1- ללא שומשום (טחינה, ממרח חומוס)"]]);
  check("an institution without allergies has no warning, and the unknown one was not created", [await page.locator('[data-institution="בדיקה-2"]:visible').getAttribute("data-allergy"), await page.locator(`[data-institution="${stranger}"]`).count()], ["false", 0]);

  // ---------- meal types
  await go("/hotfood/meal-types", "#meal-types-summary");
  const meal = page.locator(`[data-meal-type="${MEAL_A}"]:visible`);
  const options = await meal.locator("select[name=sku] option").evaluateAll((l) => l.map((o) => o.value).filter(Boolean));
  if (options.length === 0) console.log("note: the catalogue has no hot food items (sort group 600), so the mapping itself was not exercised");
  else {
    await meal.locator("select[name=sku]").selectOption(options[0]);
    await meal.locator("form:has(select[name=sku]) button").click();
    await page.waitForSelector(`[data-meal-type="${MEAL_A}"][data-sku="${options[0]}"]`);
    await go(`/hotfood/milgam?day=${D1}`, "#milgam-day");
    check("a mapped meal type shows its catalogue item on the day", (await page.locator(`#milgam-day [data-meal="${MEAL_A}"] td`).nth(1).textContent()).trim(), options[0]);
    await go("/hotfood/meal-types", "#meal-types-summary");
    await page.locator(`[data-meal-type="${MEAL_A}"]:visible select[name=sku]`).selectOption("");
    await page.locator(`[data-meal-type="${MEAL_A}"]:visible form:has(select[name=sku]) button`).click();
    await page.waitForSelector(`[data-meal-type="${MEAL_A}"][data-sku=""]`);
    check("the mapping is cleared again, so the test leaves it as it found it", await page.locator(`[data-meal-type="${MEAL_A}"]:visible`).getAttribute("data-sku"), "");
  }
} catch (e) {
  failed++;
  console.log("FAIL (exception):", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failed ? `E2E MILGAM FAILED (${failed})` : "E2E MILGAM PASSED");
process.exit(failed ? 1 : 0);
