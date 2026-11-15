// End-to-end check in headless Edge of hot food menus: a menu document (PDF) is uploaded and becomes a cyclic menu,
// a day of the cycle is edited, the weeks get their dates and the cycle is continued, a dish of the dish table is
// added and its weight changed, meal types get an age group and a diet, an institution follows the menu, and the
// kitchen's day report shows the day's plates with the portions by age group, and the kilograms to cook once the
// menu's phrases are tied to dishes of the dish table.
// The test keeps one institution ("מוסד בדיקה תפריט"), three meal types ("מנת בדיקה תפריט ...") and one dish
// ("מנת בדיקה תפריט"); every run adds one menu and switches it off at the end. Its days are in 1900-1949.
// Needs the dev server on http://localhost:3000. Run from the web folder:  node scripts/e2e-menus.mjs
import { chromium } from "playwright-core";
import { workbook } from "./xlsx-write.mjs";

const BASE = process.env.AO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "0500000000";
const tag = Date.now() % 1000000;
const MENU = `תפריט בדיקה ${tag}`;
const iso = (d) => d.toISOString().slice(0, 10);
const il = (d) => d.split("-").reverse().join("/");
// A Tuesday in 1900-1949, and the Sunday of its week.
const sundayDate = new Date(Date.UTC(1901 + Math.floor(Math.random() * 48), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28)));
sundayDate.setUTCDate(sundayDate.getUTCDate() - sundayDate.getUTCDay());
const SUNDAY = iso(sundayDate);
const plus = (days) => iso(new Date(sundayDate.getTime() + days * 86400000));
const DAY = plus(2);
const SYMBOL = "בדיקה-4";
const [MEAL, MEAL_VEG, MEAL_ALLERGEN] = ["מנת בדיקה תפריט ג-ו", "מנת בדיקה תפריט צמחוני ג-ו", "מנת בדיקה תפריט ללא אלרגנים"];
const DISH = "מנת בדיקה תפריט";

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ locale: "he-IL" });
const page = await context.newPage();
page.on("dialog", (d) => d.accept());
const clean = (s) => (s ?? "").replace(/[‎‏ ]/g, " ").replace(/\s+/g, " ").trim();
const text = async (sel) => clean(await page.locator(sel).first().innerText());
const go = async (path, wait) => {
  await page.goto(BASE + path);
  await page.waitForSelector(wait);
};
/** Presses the button of a form and waits for its answer. */
async function submit(form) {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), form.locator("button").click()]);
  await form.locator("button:not([disabled])").waitFor();
  await form.locator("[role=status], [role=alert]").waitFor();
  return clean(await form.locator("[role=status], [role=alert]").textContent());
}

// ---------- a menu document, made the way the real one is: a table per week, printed to PDF
const week = (no, range, rows) => `
  <section>
    <h1>קייטרינג בדיקה ${tag}</h1><h2>חורף 1900</h2>
    <p class="c">שבוע ${no}</p><p class="c">ינואר: ${range}</p>
    <table><tr><th>שבוע ${no}</th><th>ראשון</th><th>שני<br>שוברת שגרה לבתי ספר בלבד</th><th>שלישי</th></tr>
    ${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`).join("")}</table>
    <p>** הערת שבוע ${no}</p>
    <p class="sign">אושר על ידי התזונאית: דנה בדיקה בתאריך: 05/01/1900 חתימה:</p>
  </section>`;
const rowsOf = (main) => [
  ["מנה עיקרית", "בולונז", "שווארמה", `${main}<br>גנים: קציצות`],
  ['מק"ט', "", "333167", "45021"],
  ["דגנים", "פסטה", "תפוח אדמה", "אורז 30% מלא"],
  ["תוספת חמה", "תירס", "-", "אפונה בדיקה"],
  ["מנה לצמחונים", "כדורי סויה", "שניצל תירס", "תבשיל עדשים"],
  ['מק"ט', "12573078", "", ""],
  ["ללא אלרגנים", "בולונז, פסטה ותירס", "שווארמה, אורז", "שניצל, פסטה, תירס"],
  ['מק"ט', "Kk011", "Kk006", "Kk054"],
  ["ירק טרי", "ירקות ארוזים", "ירקות ארוזים", "גנים: ירקות ארוזים<br>בתי ספר: 20% גזרונים"],
  ["פרי טרי", "תפוח", "בננה", "אגס"],
  ["לחם מלא", "", "פיתה", "לחם עם סמל ירוק"],
];
const html = `<html dir="rtl"><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 12mm } body { font-family: Arial; font-size: 11pt }
  section { page-break-after: always } h1, h2, .c { text-align: center; margin: 4px }
  table { border-collapse: collapse; width: 100% } th, td { border: 1px solid #000; padding: 6px; text-align: center; height: 26px }
  .sign { position: absolute; bottom: 0 } section { position: relative; height: 170mm }
</style></head><body>
  ${week(1, "07/01/1900-13/01/1900, 21/01/1900-27/01/1900", rowsOf("שניצל"))}
  ${week(2, "14/01/1900-20/01/1900", rowsOf("שוק עוף"))}
  <h1>קייטרינג בדיקה ${tag}</h1><h2>חורף 1900</h2><p>• אין לבצע שינוי בתפריט ללא אישור בכתב.</p>
</body></html>`;
const maker = await context.newPage();
await maker.setContent(html);
const pdf = await maker.pdf({ preferCSSPageSize: true, printBackground: true });
await maker.close();

try {
  await page.goto(BASE + "/login");
  await page.fill("#mobile", ADMIN);
  await page.click("form button");
  await page.waitForSelector("form b");
  await page.fill("#code", (await page.locator("form b").textContent()).trim());
  await page.click("form button");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  // ---------- upload
  await go("/hotfood/menus", "#menu-upload");
  await page.setInputFiles("#menu-upload [name=file]", { name: "not-a-menu.pdf", mimeType: "application/pdf", buffer: Buffer.from("this is not a pdf") });
  check("a file that is not a PDF is refused", await submit(page.locator("#menu-upload form")), "הקובץ אינו PDF תקין.");
  await page.setInputFiles("#menu-upload [name=file]", { name: `menu-${tag}.pdf`, mimeType: "application/pdf", buffer: pdf });
  await page.fill("#menu-upload [name=name]", MENU);
  await page.click("#menu-upload form button");
  await page.waitForURL(/\/hotfood\/menus\/\d+$/);
  await page.waitForSelector("#menu-grid");
  const menuPath = new URL(page.url()).pathname;
  check("the upload opens the new menu", await text("h1"), MENU);
  check("the menu's details come from the document", await text("#menu-summary"), `מחזור של 2 שבועות · חורף 1900 · אושר על ידי דנה בדיקה בתאריך 05/01/1900 · מהקובץ menu-${tag}.pdf`);
  check("a clean document leaves nothing to check", await page.locator("#menu-warnings").count(), 0);
  check("the week's dates are read", await text("#week-dates"), "חל בשבועות שמתחילים ב: 07/01/1900 · 21/01/1900");
  check("a cell keeps its lines and its SKU", await text('[data-cell="2-main"]'), "שניצל גנים: קציצות מק״ט 45021");
  check("a number inside a Hebrew cell stays in place", await text('[data-cell="2-grain"]'), "אורז 30% מלא");
  check("a dash and an empty cell are empty", [await text('[data-cell="1-hot_side"]'), await text('[data-cell="0-bread"]')], ["–", "–"]);
  check("the day's remark is in the heading", await text('[data-day-head="1"]'), "שני עריכה שוברת שגרה לבתי ספר בלבד");
  check("the vegetarian and allergen-free rows have their own SKU", [await text('[data-cell="0-vegetarian"]'), await text('[data-cell="1-allergen_free"]')], ["כדורי סויה מק״ט 12573078", "שווארמה, אורז מק״ט Kk006"]);
  check("the document's remarks are kept", (await page.inputValue("#menu-details [name=notes]")).split("\n"), ["שבוע 1: ** הערת שבוע 1", "שבוע 2: ** הערת שבוע 2", "• אין לבצע שינוי בתפריט ללא אישור בכתב."]);
  await page.click('#week-tabs [data-week="2"]');
  await page.waitForSelector('#week-tabs [data-week="2"][aria-current=page]');
  check("the second week has its own dishes and dates", [await text('[data-cell="2-main"]'), await text("#week-dates")], ["שוק עוף גנים: קציצות מק״ט 45021", "חל בשבועות שמתחילים ב: 14/01/1900"]);

  // ---------- editing a day
  await page.goto(BASE + menuPath + "?week=1");
  await page.waitForSelector("#menu-grid");
  await page.click('[data-edit-day="3"]');
  await page.waitForSelector("#day-edit");
  await page.fill("#day-edit [name=note]", "שוברת שגרה לכולם");
  await page.fill("#day-edit [name=text_main]", "פלאפל\nגנים: שניצל");
  await page.fill("#day-edit [name=sku_main]", "501010");
  await page.fill("#day-edit [name=text_bread]", "פיתה, טחינה גולמית");
  await page.click("#day-edit form button");
  await page.waitForSelector("#menu-grid");
  check("a day is edited by hand", [await text('[data-day-head="3"]'), await text('[data-cell="3-main"]'), await text('[data-cell="3-bread"]')], ["רביעי עריכה שוברת שגרה לכולם", "פלאפל גנים: שניצל מק״ט 501010", "פיתה, טחינה גולמית"]);

  // ---------- the weeks of the cycle
  const dates = page.locator("#menu-dates form:has([name=dates])");
  await dates.locator("[name=dates]").fill(`${il(DAY)}\n07/01/1900`);
  check("a week gets its dates", await submit(dates), "נשמרו 2 שבועות. כל תאריך נשמר כיום ראשון של השבוע שלו.");
  await page.waitForFunction((s) => document.querySelector("#week-dates")?.textContent?.includes(s), il(SUNDAY));
  check("a date is kept as its week's Sunday", (await text("#week-dates")).includes(il(SUNDAY)), true);
  await dates.locator("[name=dates]").fill("32/01/1900");
  check("a bad date is refused", (await submit(dates)).startsWith("התאריך אינו תקין"), true);
  const extend = page.locator("#menu-dates form:has([name=until])");
  await extend.locator("[name=until]").fill("1960-01-01");
  check("the cycle continues from its last dated week, and too far is refused", (await submit(extend)).includes("60"), true);
  await extend.locator("[name=until]").fill(plus(21));
  check("the cycle is continued", /^המחזור הומשך ב-\d+ שבועות\.$/.test(await submit(extend)), true);

  // ---------- the dish table
  await go("/hotfood/dishes?q=2466", "#dish-list");
  check("the dish table ships with Milgam's dishes and weights", [await text("#dish-count"), (await text('[data-dish="2466"]')).replace(" עריכה", "")], ["1 מנות", "2466 עיקרי סטייק 0.08 0.1 0.12 0.12 1 120"]);
  await go("/hotfood/dishes", "#dish-list");
  check("the whole table is there, in pages", (await text("#dish-count")).startsWith("40"), true);
  await go(`/hotfood/dishes?q=${encodeURIComponent(DISH)}`, "#dish-list");
  if ((await page.locator("#dish-list tbody tr").count()) === 0) {
    await page.click("#dish-add-link");
    await page.waitForSelector("#dish-edit");
    await page.fill("#dish-edit [name=name]", DISH);
    await page.fill("#dish-edit [name=weight_gan]", "0.08");
    check("a dish is added", await submit(page.locator("#dish-edit form")), "המנה נוספה.");
    await go(`/hotfood/dishes?q=${encodeURIComponent(DISH)}`, "#dish-list tbody tr");
  }
  await page.click("#dish-list [data-edit-dish]");
  await page.waitForSelector("#dish-edit");
  const weight = `0.${100 + (tag % 900)}`;
  await page.fill("#dish-edit [name=weight_gv]", weight.replace(".", ","));
  await page.locator("#dish-edit [name=active]").setChecked(false);
  check("a weight is changed", await submit(page.locator("#dish-edit form")), "נשמר.");
  await page.waitForFunction((w) => document.querySelector('#dish-list [data-w="gv"]')?.textContent === w, String(Number(weight)));
  check("the list shows the new weight, and the dish is marked not active", [await text('#dish-list [data-w="gv"]'), (await text("#dish-list tbody tr")).includes("(לא פעילה)")], [String(Number(weight)), true]);
  await page.fill("#dish-edit [name=weight_ab]", "מאה גרם");
  check("a weight must be a number", await submit(page.locator("#dish-edit form")), "משקל א-ב: יש להקליד מספר.");

  // ---------- quantities, meal types, and the institution's menu
  const HEAD = ["רשות", "סמל מוסד", "שם מוסד", "סוג מוסד", "תוכנית הזנה", "כתה", "סוג מנה", "כתובת לאספקה", "הערות", "יש אלרגיות מסכנות חיים", il(DAY)];
  const row = (cls, meal, n) => ["עיר בדיקה", SYMBOL, "מוסד בדיקה תפריט", "בית ספר", "תוכנית בדיקה", cls, meal, "רחוב הבדיקה 4", "", "לא", String(n)];
  await go("/hotfood/milgam", "#milgam-upload");
  await page.selectOption("#milgam-upload [name=kind]", "forecast");
  await page.setInputFiles("#milgam-upload [name=file]", { name: `צפי תפריט ${tag}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(workbook([HEAD, row("ד1", MEAL, 20), row("ד1", MEAL_VEG, 3), row("ה1", MEAL, 15), row("ה1", MEAL_ALLERGEN, 2)])) });
  await page.locator("#milgam-upload [name=add_new]").setChecked(true);
  check("the forecast is loaded", (await submit(page.locator("#milgam-upload form"))).startsWith("נקלטו 40 מנות"), true);

  await go("/hotfood/meal-types", "#meal-types-summary");
  const meal = (name) => page.locator(`[data-meal-type="${name}"]:visible`);
  check("a meal type gets its diet from its name", [await meal(MEAL).getAttribute("data-diet"), await meal(MEAL_VEG).getAttribute("data-diet"), await meal(MEAL_ALLERGEN).getAttribute("data-diet")], ["regular", "vegetarian", "allergen_free"]);
  check("and its age group, when the name says it", [await meal(MEAL).getAttribute("data-age-group"), await meal(MEAL_VEG).getAttribute("data-age-group")], ["gv", "gv"]);
  const group = meal(MEAL_ALLERGEN).locator("form:has([name=age_group])");
  await group.locator("[name=age_group]").selectOption("");
  await submit(group);
  await page.waitForSelector(`[data-meal-type="${MEAL_ALLERGEN}"][data-age-group=""]`);

  await go("/hotfood/institutions", "h1");
  await page.locator(`a:has-text("מוסד בדיקה תפריט")`).first().click();
  await page.waitForSelector("#institution-menu");
  const instPath = new URL(page.url()).pathname;
  const pick = page.locator("#institution-menu form");
  await pick.locator("[name=menu_id]").selectOption({ label: MENU });
  check("an institution is given a menu", await submit(pick), "נשמר.");
  await page.waitForSelector(`#institution-menu[data-menu="${MENU}"]`);

  // ---------- the kitchen's day report
  await go(`/hotfood/menus/day?day=${DAY}`, "#day-summary");
  const section = `[data-day-menu="${MENU}"]`;
  check("the day's menu shows its week of the cycle", (await text(`${section} [data-day-menu-summary]`)), "שבוע 1 במחזור, יום שלישי · 1 מוסדות · 40 מנות");
  check("a regular plate is the main dish, the grain and the hot side", await text(`${section} [data-plate="regular"] td`), "מנה עיקרית: שניצל גנים: קציצות · מק״ט 45021 דגנים: אורז 30% מלא תוספת חמה: אפונה בדיקה");
  check("a vegetarian plate swaps only the main dish", await text(`${section} [data-plate="vegetarian"] td`), "מנה לצמחונים: תבשיל עדשים דגנים: אורז 30% מלא תוספת חמה: אפונה בדיקה");
  check("an allergen-free meal is a whole different meal", await text(`${section} [data-plate="allergen_free"] td`), "ללא אלרגנים: שניצל, פסטה, תירס · מק״ט Kk054");
  check("portions by age group", [await text(`${section} [data-plate="regular"] [data-age="gv"]`), await text(`${section} [data-plate="vegetarian"] [data-age="gv"]`), await text(`${section} [data-plate="regular"] [data-plate-total]`), await text(`${section} [data-plate="allergen_free"] [data-plate-total]`)], ["35", "3", "35", "2"]);
  check("a meal type without an age group is pointed out", (await text(section)).includes("יש סוגי מנה בלי קבוצת גיל"), true);
  check("what goes with every plate", await text(`${section} [data-extras]`), "ירק טרי: גנים: ירקות ארוזים בתי ספר: 20% גזרונים פרי טרי: אגס לחם: לחם עם סמל ירוק");

  // ---------- from the menu to kilograms
  await go("/hotfood/dishes?q=13589", "#dish-list");
  const perPortion = Number(await text('[data-dish="13589"] [data-w="gv"]'));
  const kgText = (n) => `${new Intl.NumberFormat("he-IL", { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(n)} ק״ג`;
  await go(`/hotfood/menus/day?day=${DAY}`, "#day-summary");
  check("a phrase that is exactly a dish's name is weighed by it: portions times the weight of the age group", [await text(`${section} [data-cook-line="שניצל"] td:nth-child(2)`), await text(`${section} [data-cook-line="שניצל"] td:nth-child(3)`), (await text(`${section} [data-cook-line="שניצל"] [data-kg]`)).startsWith(kgText(35 * perPortion))], ["שניצל (13589)", "35", true]);
  check("the item written for the kindergartens is counted apart", [await text(`${section} [data-cook-line="קציצות"] td:nth-child(1)`), await text(`${section} [data-cook-line="קציצות"] td:nth-child(3)`)], ["מנה עיקרית: גנים: קציצות", "0"]);
  check("a phrase without a dish is pointed out", await text(`${section} [data-cook-line="אפונה בדיקה"] td:nth-child(2)`), "לא קושר");
  check("the day's summary has the dish", (await text('#cook-totals [data-total-dish="שניצל"] [data-kg]')) !== "", true);

  await page.goto(BASE + menuPath);
  await page.waitForSelector("#phrases-link");
  await page.click("#phrases-link");
  await page.waitForSelector("#phrase-list");
  const phrase = page.locator('[data-phrase="אפונה בדיקה"][data-category="hot_side"]:visible');
  check("the menu's phrases are listed, with what was found by name", [await page.locator('[data-phrase="שניצל"][data-category="main"]:visible').getAttribute("data-how"), await phrase.getAttribute("data-how")], ["name", ""]);
  const tiedTo = clean(await phrase.locator("select option").nth(1).textContent()).split(" · ")[0];
  await phrase.locator("select").selectOption({ index: 1 });
  check("a phrase is tied to a dish", await submit(phrase.locator("form")), "נשמר.");
  await page.waitForSelector('[data-phrase="אפונה בדיקה"][data-how="tied"]');
  await go(`/hotfood/menus/day?day=${DAY}`, "#day-summary");
  check("the tied phrase is now weighed by its dish", (await text(`${section} [data-cook-line="אפונה בדיקה"] td:nth-child(2)`)).startsWith(tiedTo), true);
  await page.goto(BASE + menuPath + "/phrases");
  await page.waitForSelector("#phrase-list");
  await phrase.locator("select").selectOption("");
  await submit(phrase.locator("form"));
  await page.waitForSelector('[data-phrase="אפונה בדיקה"][data-how=""]');
  check("the tie is removed again, so the test leaves the table as it found it", await phrase.getAttribute("data-how"), "");


  // ---------- tidy up: the institution leaves the menu and the menu is switched off
  await page.goto(BASE + menuPath);
  await page.waitForSelector("#menu-details");
  const details = page.locator("#menu-details form");
  await details.locator("[name=active]").setChecked(false);
  check("a menu that an institution follows cannot be switched off", (await submit(details)).startsWith("אי אפשר להשבית תפריט ש-1 מוסדות"), true);
  await page.goto(BASE + instPath);
  await page.waitForSelector("#institution-menu");
  await page.locator("#institution-menu [name=menu_id]").selectOption("");
  await submit(page.locator("#institution-menu form"));
  await page.waitForSelector('#institution-menu[data-menu=""]');
  await page.goto(BASE + menuPath);
  await page.waitForSelector("#menu-details");
  await page.locator("#menu-details [name=active]").setChecked(false);
  check("an unused menu is switched off", await submit(page.locator("#menu-details form")), "נשמר.");
  await go("/hotfood/menus", "#menu-list");
  check("the list shows it as switched off", await page.locator(`[data-menu="${MENU}"]`).getAttribute("data-active"), "false");
} catch (e) {
  failed++;
  console.log("FAIL the run stopped:", e.message.split("\n")[0], "at", page.url());
} finally {
  await browser.close();
}
console.log(failed === 0 ? "MENUS E2E PASSED" : `MENUS E2E FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
