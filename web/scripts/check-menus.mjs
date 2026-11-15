// Tests hot-food menus: building a cyclic menu from the pages of a menu document, the weeks of the cycle and their
// dates, the cells of a day, the menu an institution follows, the dish table with its weights, the age group and
// diet of a meal type, and the kitchen's day report. All data is made up, except the dish table that the system ships with.
// Run from the web folder:  node scripts/check-menus.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { importMilgam } from "../src/lib/milgam-core.ts";
import { buildMenu, toLines, sundayOf } from "../src/lib/menu-parse-core.ts";
import { createMenu, updateMenu, listMenus, getMenu, setInstitutionMenu, setMenuDay, setWeekStarts, extendCycle, menuWeeks, saveParsedMenu, menuDayReport, guessMealType, setMealTypeGroup } from "../src/lib/menu-core.ts";
import { listDishes, getDish, createDish, updateDish } from "../src/lib/dish-core.ts";
import { cellItems, menuPhrases, setPhraseDish, dayCooking } from "../src/lib/menu-cook-core.ts";

const db = new PGlite();
const dir = path.join(process.cwd(), "..", "db", "migrations");
for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await db.exec(await readFile(path.join(dir, f), "utf8"));
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
async function refuses(label, fn, fragment) {
  try { await fn(); failed++; console.log(`FAIL ${label} -> was accepted`); }
  catch (e) { const ok = e.message.includes(fragment); if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> wrong message: ${e.message}`}`); }
}

const user = (await one("insert into users (mobile, full_name, role) values ('0500000041', 'מנהל', 'admin') returning id::text")).id;

// ---------- reading a menu document
// A text item: x is its left edge. Hebrew pieces are right-to-left, numbers and codes left-to-right.
const t = (x, y, str, ltr = false) => ({ x, y, w: str.length * 5, str, ltr });
check("a line is read right to left, and a date made of pieces reads left to right", toLines([t(300, 100, "בתאריך"), t(290, 100, ":", true), t(240, 100, "2026", true), t(235, 100, "/", true), t(225, 100, "11", true), t(210, 100, "11/", true)])[0].text, "בתאריך: 11/11/2026");
check("mirrored brackets are put right", toLines([t(100, 50, "קוסקוס )פולנטה(, תבשיל")])[0].text, "קוסקוס (פולנטה), תבשיל");
check("the Sunday of a week", [sundayOf("2026-12-09"), sundayOf("2026-12-06")], ["2026-12-06", "2026-12-06"]);

// One week's page: a label column on the right and two day columns; rows: heading, main, its SKU, grain, vegetarian, allergen-free, fruit.
const lines = { h: [520, 490, 460, 445, 420, 395, 370, 345].map((y) => ({ y, len: 300 })), v: [600, 500, 400, 300].map((x) => ({ x, len: 175 })) };
const weekPage = (weekNo, dates, main) => ({
  ...lines,
  texts: [
    t(420, 570, "קייטרינג הדוגמה"), t(430, 555, "חורף"), t(400, 555, "2026", true),
    t(450, 540, "שבוע"), t(440, 540, String(weekNo), true),
    t(480, 530, "דצמבר"), t(475, 530, ":", true), ...dates.map((d, i) => t(350 - i * 120, 530, d, true)),
    t(530, 500, `שבוע ${weekNo}`), t(440, 505, "ראשון"), t(345, 510, "שני"), t(320, 498, "שוברת שגרה לכולם"),
    t(530, 472, "מנה עיקרית"), t(430, 478, main), t(425, 466, "גנים: קציצות"), t(340, 472, "שניצל"),
    t(540, 450, 'מק"ט'), t(440, 450, "45021", true),
    t(540, 430, "דגנים"), t(440, 430, "אורז"), t(420, 430, "30%", true), t(402, 430, "מלא"), t(340, 430, "פתיתים"),
    t(520, 405, "מנה לצמחונים"), t(430, 405, "תבשיל עדשים"), t(350, 405, "-", true),
    t(525, 380, "ללא אלרגנים"), t(410, 380, "בולונז, פסטה ותירס"), t(310, 380, "שווארמה ואורז"),
    t(540, 355, "פרי טרי"), t(440, 355, "תפוח"), t(340, 355, "בננה"),
    t(480, 320, "** הערה לשבוע הזה"),
    t(500, 30, "אושר על ידי התזונאית"), t(495, 30, ":", true), t(450, 30, "דנה כהן"), t(410, 30, "בתאריך"), t(405, 30, ":", true), t(350, 30, "01/12/2026", true),
  ],
});
const notesPage = { h: [], v: [], texts: [t(420, 570, "קייטרינג הדוגמה"), t(430, 555, "חורף"), t(400, 555, "2026", true), t(300, 400, "• אין לבצע שינוי בתפריט ללא אישור")] };
const parsed = buildMenu([weekPage(1, ["06/12/2026-12/12/2026", "20/12/2026-26/12/2026"], "בולונז"), weekPage(2, ["13/12/2026-19/12/2026"], "שוק עוף"), notesPage]);
check("the heading, the period and the approval are read", [parsed.title, parsed.period, parsed.approvedBy, parsed.approvedOn], ["קייטרינג הדוגמה", "חורף 2026", "דנה כהן", "2026-12-01"]);
check("every page is a week of the cycle with its dates", parsed.weeks.map((w) => [w.weekNo, w.starts]), [[1, ["2026-12-06", "2026-12-20"]], [2, ["2026-12-13"]]]);
check("the days and the day's remark", parsed.weeks[0].days.map((d) => [d.weekday, d.note]), [[0, null], [1, "שוברת שגרה לכולם"]]);
const sunday = Object.fromEntries(parsed.weeks[0].days[0].cells.map((c) => [c.category, c]));
check("a cell keeps its lines, and the SKU row goes to the row above it", [sunday.main.text, sunday.main.sku], ["בולונז\nגנים: קציצות", "45021"]);
check("a number inside a Hebrew cell stays in place", sunday.grain.text, "אורז 30% מלא");
check("the categories of a day", parsed.weeks[0].days[0].cells.map((c) => c.category), ["main", "grain", "vegetarian", "allergen_free", "fruit"]);
check("a dash is an empty cell", parsed.weeks[0].days[1].cells.map((c) => c.category), ["main", "grain", "allergen_free", "fruit"]);
check("remarks under a table and on a page without one are kept", parsed.notes, "שבוע 1: ** הערה לשבוע הזה\nשבוע 2: ** הערה לשבוע הזה\n• אין לבצע שינוי בתפריט ללא אישור");
check("a clean document has no warnings", parsed.warnings, []);
await refuses("a document without a table is refused", async () => buildMenu([notesPage]), "לא נמצאה טבלת תפריט");
check("a week that does not start on Sunday is moved to its Sunday, with a warning", (() => { const p = buildMenu([weekPage(1, ["08/12/2026-12/12/2026"], "בולונז")]); return [p.weeks[0].starts, p.warnings.length]; })(), [["2026-12-06"], 1]);

// ---------- menus
const uploaded = await saveParsedMenu(q, parsed, "תפריט חורף", "menu.pdf", user);
const up = await getMenu(q, uploaded);
check("an uploaded document becomes a menu", [up.name, up.weeks, up.period, up.approvedBy, up.approvedOn, up.sourceFile], ["תפריט חורף", 2, "חורף 2026", "דנה כהן", "2026-12-01", "menu.pdf"]);
const cycle = await menuWeeks(q, uploaded);
check("the menu has the document's weeks, dates and cells", [cycle.map((w) => w.starts), cycle[1].days[0].cells.main.text, cycle[0].days[1].note, cycle[0].days[0].cells.main.sku], [[["2026-12-06", "2026-12-20"], ["2026-12-13"]], "שוק עוף\nגנים: קציצות", "שוברת שגרה לכולם", "45021"]);
await refuses("uploading under a name that exists is refused", () => saveParsedMenu(q, parsed, "תפריט חורף", "menu.pdf", user), "כבר קיים");
check("a refused upload leaves nothing behind", (await listMenus(q)).length, 1);

const kinder = await createMenu(q, "  גני   ילדים ", user);
check("a menu's name is tidied, and a new menu has a four-week cycle", (await listMenus(q)).map((m) => [m.name, m.weeks]), [["גני ילדים", 4], ["תפריט חורף", 2]]);
await refuses("a menu needs a name", () => createMenu(q, " ", user), "שם");
const edit = (m, over) => ({ name: m.name, active: m.active, period: m.period, approvedBy: m.approvedBy, approvedOn: m.approvedOn, notes: m.notes, ...over });
await refuses("renaming onto another menu's name is refused", async () => updateMenu(q, kinder, edit(await getMenu(q, kinder), { name: "תפריט חורף" }), user), "כבר קיים");
await updateMenu(q, kinder, edit(await getMenu(q, kinder), { notes: "הערה\r\nשנייה", approvedOn: "2026-12-02" }), user);
check("a menu's details are updated", [(await getMenu(q, kinder)).notes, (await getMenu(q, kinder)).approvedOn], ["הערה\nשנייה", "2026-12-02"]);

// ---------- the weeks of the cycle
check("dates are kept as their weeks' Sundays", await setWeekStarts(q, kinder, 1, ["2026-12-09", "2026-12-06", "2027-01-05"], user), ["2026-12-06", "2027-01-03"]);
await setWeekStarts(q, kinder, 2, ["2026-12-13", "2027-01-03"], user);
check("a calendar week moves to the week of the cycle it was last given to", (await menuWeeks(q, kinder)).slice(0, 2).map((w) => w.starts), [["2026-12-06"], ["2026-12-13", "2027-01-03"]]);
await refuses("a week outside the cycle is refused", () => setWeekStarts(q, kinder, 5, ["2026-12-06"], user), "מחזור");
await refuses("a bad date is refused", () => setWeekStarts(q, kinder, 1, ["6.12.2026"], user), "התאריך");
check("the cycle is continued week after week", [await extendCycle(q, kinder, "2027-02-02", user), (await menuWeeks(q, kinder)).map((w) => w.starts)], [4, [["2026-12-06", "2027-01-24"], ["2026-12-13", "2027-01-03", "2027-01-31"], ["2027-01-10"], ["2027-01-17"]]]);
await refuses("a menu without a dated week cannot be continued", async () => extendCycle(q, await createMenu(q, "ריק", user), "2027-02-02", user), "עוד אין שבוע");

// ---------- the cells of a day
await setMenuDay(q, kinder, 1, 2, " שוברת  שגרה ", [{ category: "main", text: "  פלאפל \r\n\n גנים:  שניצל ", sku: " 501010 " }, { category: "grain", text: "צ'יפס", sku: "לא נשמר" }, { category: "fruit", text: "  " }], user);
const tue = (await menuWeeks(q, kinder))[0].days[2];
check("a day keeps its cells; text is tidied and only the SKU rows keep a SKU", [tue.note, tue.cells.main, tue.cells.grain, tue.cells.fruit], ["שוברת שגרה", { text: "פלאפל\nגנים: שניצל", sku: "501010" }, { text: "צ'יפס", sku: null }, undefined]);
const auditBefore = (await one("select count(*)::int as n from audit_log where action = 'menu_day'")).n;
await setMenuDay(q, kinder, 1, 2, "שוברת שגרה", [{ category: "grain", text: "צ'יפס" }, { category: "main", text: "פלאפל\nגנים: שניצל", sku: "501010" }], user);
check("saving the same day again writes nothing to the history", (await one("select count(*)::int as n from audit_log where action = 'menu_day'")).n, auditBefore);
await refuses("an unknown category is refused", () => setMenuDay(q, kinder, 1, 2, null, [{ category: "dessert", text: "עוגה" }], user), "קטגוריית");
await refuses("a week outside the cycle has no days", () => setMenuDay(q, kinder, 7, 2, null, [], user), "מחזור");
await setMenuDay(q, kinder, 1, 2, null, [], user);
check("an empty day is cleared", (await menuWeeks(q, kinder))[0].days[2], { note: null, cells: {} });

// ---------- meal types: age group and diet
check("the age group and diet are read from Milgam's names", ["חמגשית ג-ו", "חמגשית צמחוני על יסודי", "תפזורת צמחוני חובה", "תפזורת א-ב", "ללא אלרגניים", "משהו אחר"].map((n) => { const g = guessMealType(n); return `${g.ageGroup}/${g.diet}`; }), ["gv/regular", "high/vegetarian", "gan/vegetarian", "ab/regular", "null/allergen_free", "null/regular"]);

// ---------- institutions and quantities
const DAY = "2026-12-08"; // a Tuesday of the week that starts on 2026-12-06: week 1 of both menus
const row = (symbol, name, className, mealType, qty) => ({ line: 0, symbol, name, kind: "בית ספר", authority: "עיר", program: "יוחא", className, mealType, address: "כתובת", kosher: null, notes: null, lifeThreatening: false, quantities: { [DAY]: qty } });
const file = (rows) => ({ days: [DAY], rows, problems: [], sheetRows: rows.length });
const FORECAST = [row("111", "בית ספר אלון", "א1", "חמגשית א-ב", 20), row("111", "בית ספר אלון", "א1", "חמגשית צמחוני א-ב", 3), row("111", "בית ספר אלון", "ד1", "חמגשית ג-ו", 18), row("111", "בית ספר אלון", "ד1", "ללא אלרגניים", 2), row("222", "גן רימון", "גן", "תפזורת חובה", 30), row("333", "מוסד בלי תפריט", "ג1", "חמגשית ג-ו", 7)];
await importMilgam(q, file(FORECAST), { kind: "forecast", fileName: "צפי", userId: user, addNew: true });
check("a meal type first seen in a Milgam file gets its age group and diet", (await q("select name, age_group, diet from meal_types order by name")).map((m) => `${m.name}=${m.age_group}/${m.diet}`), ["חמגשית א-ב=ab/regular", "חמגשית ג-ו=gv/regular", "חמגשית צמחוני א-ב=ab/vegetarian", "ללא אלרגניים=null/allergen_free", "תפזורת חובה=gan/regular"]);
const allergen = (await one("select id from meal_types where name = 'ללא אלרגניים'")).id;
await setMealTypeGroup(q, allergen, "gv", "allergen_free", user);
await refuses("an unknown age group is refused", () => setMealTypeGroup(q, allergen, "baby", "regular", user), "קבוצת הגיל");
const inst = Object.fromEntries((await q("select id, symbol from institutions")).map((r) => [r.symbol, r.id]));

await setInstitutionMenu(q, inst["111"], uploaded, user);
await setInstitutionMenu(q, inst["222"], kinder, user);
check("the list counts the institutions of every menu", (await listMenus(q)).filter((m) => m.institutions > 0).map((m) => [m.name, m.institutions]), [["גני ילדים", 1], ["תפריט חורף", 1]]);
await refuses("a menu that institutions follow cannot be switched off", async () => updateMenu(q, uploaded, edit(await getMenu(q, uploaded), { active: false }), user), "אי אפשר להשבית");
await refuses("an unknown menu cannot be chosen", () => setInstitutionMenu(q, inst["333"], 9999, user), "לא נמצא");
const spare = await createMenu(q, "ישן", user);
await updateMenu(q, spare, edit(await getMenu(q, spare), { active: false }), user);
await refuses("a switched-off menu cannot be chosen", () => setInstitutionMenu(q, inst["333"], spare, user), "מושבת");

// ---------- the kitchen's day report
await setMenuDay(q, uploaded, 1, 2, "שוברת שגרה לבתי ספר", [{ category: "main", text: "שניצל", sku: "45146" }, { category: "grain", text: "אורז" }, { category: "hot_side", text: "אפונה" }, { category: "vegetarian", text: "שניצל תירס" }, { category: "allergen_free", text: "שניצל, פסטה, תירס", sku: "Kk054" }, { category: "fruit", text: "בננה" }], user);
const r1 = await menuDayReport(q, DAY);
check("before the daily order the report shows the forecast", [r1.ordered, r1.total, r1.weekday], [false, 80, 2]);
check("every menu shows its week of the cycle; an institution without a menu is not left out", r1.menus.map((m) => [m.menu, m.weekNo, m.institutions, m.portions]), [["גני ילדים", 1, 1, 30], ["תפריט חורף", 1, 1, 43], [null, null, 1, 7]]);
const winter = r1.menus[1];
check("a regular plate is the main dish, the grain and the hot side", winter.plates[0].parts.map((p) => p.text), ["שניצל", "אורז", "אפונה"]);
check("a vegetarian plate swaps only the main dish", [winter.plates[1].diet, winter.plates[1].parts.map((p) => p.text)], ["vegetarian", ["שניצל תירס", "אורז", "אפונה"]]);
check("an allergen-free meal is a whole different meal", [winter.plates[2].diet, winter.plates[2].parts.map((p) => `${p.text} ${p.sku}`)], ["allergen_free", ["שניצל, פסטה, תירס Kk054"]]);
check("portions are split by diet and age group", winter.plates.map((p) => [p.portions, p.byAge]), [[38, { gan: 0, ab: 20, gv: 18, high: 0, unknown: 0 }], [3, { gan: 0, ab: 3, gv: 0, high: 0, unknown: 0 }], [2, { gan: 0, ab: 0, gv: 2, high: 0, unknown: 0 }]]);
check("the day's remark and what goes with every plate", [winter.note, winter.extras], ["שוברת שגרה לבתי ספר", [{ category: "fruit", text: "בננה" }]]);
check("a menu with nothing written for the day shows empty plates", r1.menus[0].plates.map((p) => [p.diet, p.parts.length, p.byAge.gan]), [["regular", 0, 30]]);
const ORDER = [row("111", "בית ספר אלון", "א1", "חמגשית א-ב", 22), row("111", "בית ספר אלון", "ד1", "חמגשית ג-ו", 18), row("222", "גן רימון", "גן", "תפזורת חובה", 28)];
await importMilgam(q, file(ORDER), { kind: "daily", fileName: "הזמנה", userId: user, addNew: false });
const r2 = await menuDayReport(q, DAY);
check("after the daily order the report follows the order", [r2.ordered, r2.total, r2.menus.map((m) => [m.menu, m.portions])], [true, 68, [["גני ילדים", 28], ["תפריט חורף", 40]]]);
check("a week the menu has no date for shows no week", (await (async () => { await q("delete from menu_week_starts where menu_id = $1 and week_start = '2026-12-06'", [uploaded]); return menuDayReport(q, DAY); })()).menus[1].weekNo, null);
check("a day with nothing is an empty report", [(await menuDayReport(q, "2027-01-01")).menus.length, (await menuDayReport(q, "2027-01-01")).total], [0, 0]);
await setInstitutionMenu(q, inst["111"], null, user);
check("an institution can be taken off its menu", (await one("select menu_id from institutions where id = $1", [inst["111"]])).menu_id, null);

// ---------- the dish table
const all = await listDishes(q, { limit: 500 });
check("the system ships with Milgam's dish table", [all.total, all.dishes.length], [400, 400]);
check("every category of the menu has dishes", Object.fromEntries((await q("select category, count(*)::int as n from dishes group by category order by category")).map((r) => [r.category, r.n])), { allergen_free: 14, fruit: 18, grain: 55, hot_side: 59, main: 176, vegetable: 22, vegetarian: 56 });
const steak = (await listDishes(q, { search: "2466" })).dishes[0];
check("a dish is found by its code and carries its weights", [steak.name, steak.weightGan, steak.weightAb, steak.weightGv, steak.weightHigh, steak.kiloBoxWeight, steak.rawRatio, steak.routineBreaker], ["סטייק", "0.08", "0.1", "0.12", "0.12", "1", "120", false]);
check("dishes are filtered by category and by name", [(await listDishes(q, { category: "fruit" })).total, (await listDishes(q, { search: "סטייק" })).total > 0, (await listDishes(q, { search: "אין מנה כזאת" })).total], [18, true, 0]);
const input = (d, over) => ({ code: d.code === null ? "" : String(d.code), category: d.category, name: d.name, weightGan: d.weightGan ?? "", weightAb: d.weightAb ?? "", weightGv: d.weightGv ?? "", weightHigh: d.weightHigh ?? "", kiloBoxWeight: d.kiloBoxWeight ?? "", rawRatio: d.rawRatio ?? "", routineBreaker: d.routineBreaker, active: d.active, ...over });
check("a weight is changed", [await updateDish(q, steak.id, input(steak, { weightGan: "0,09", weightHigh: "" }), user), (await getDish(q, steak.id)).weightGan, (await getDish(q, steak.id)).weightHigh], [true, "0.09", null]);
check("saving a dish unchanged writes nothing", [await updateDish(q, steak.id, input(await getDish(q, steak.id), {}), user), (await one("select count(*)::int as n from audit_log where entity_type = 'dish'")).n], [false, 1]);
await refuses("a weight must be a number", async () => updateDish(q, steak.id, input(steak, { weightAb: "מאה גרם" }), user), "מספר");
await refuses("two dishes cannot share a code", async () => createDish(q, input(steak, { name: "אחרת" }), user), "הקוד");
const added = await createDish(q, { code: "", category: "main", name: "  מנה   חדשה ", weightGan: "0.08", weightAb: "0.1", weightGv: "0.12", weightHigh: "0.14", kiloBoxWeight: "", rawRatio: "100", routineBreaker: true, active: true }, user);
check("a dish is added without a code", [(await getDish(q, added)).name, (await getDish(q, added)).code, (await listDishes(q, { breakerOnly: true, search: "מנה חדשה" })).total], ["מנה חדשה", null, 1]);

// ---------- from the menu to kilograms
check("a cell is read as items: a heading starts an item for a population, a plain line continues the one above", cellItems("שניצלון הודו\nגוננים: המבורגר /קבב\nגנים בלבד: מרק ירקות עם 50%\nגרגרי חומוס\nבתי ספר: פיתה."), [{ scope: "all", label: null, phrase: "שניצלון הודו" }, { scope: "other", label: "גוננים", phrase: "המבורגר /קבב" }, { scope: "gan", label: "גנים בלבד", phrase: "מרק ירקות עם 50% גרגרי חומוס" }, { scope: "school", label: "בתי ספר", phrase: "פיתה" }]);
const D2 = "2027-03-09"; // a Tuesday; its week starts on 2027-03-07
const dish = (category, name, w, rawRatio = "") => createDish(q, { code: "", category, name, weightGan: w[0], weightAb: w[1], weightGv: w[2], weightHigh: w[3], kiloBoxWeight: "", rawRatio, routineBreaker: false, active: true }, user);
await dish("main", "שניצל בדיקה", ["0.08", "0.1", "0.12", "0.14"], "120");
await dish("main", "קציצות בדיקה", ["0.09", "", "", ""]);
await dish("grain", "אורז בדיקה", ["0.1", "0.12", "0.15", "0.18"], "40");
const bulgur = await dish("grain", "בורגול בדיקה", ["0.05", "0.05", "0.05", "0.05"]);
await dish("vegetarian", "טופו בדיקה", ["0.08", "0.1", "0.12", "0.12"]);
await dish("fruit", "תפוח בדיקה", ["", "", "", ""]);
const scale = await createMenu(q, "שקילה", user);
await setWeekStarts(q, scale, 1, ["2027-03-07"], user);
await setMenuDay(q, scale, 1, 2, null, [{ category: "main", text: "שניצל בדיקה\nגנים: קציצות בדיקה" }, { category: "grain", text: "אורז בדיקה" }, { category: "hot_side", text: "גוננים: אפונה בדיקה" }, { category: "vegetarian", text: "טופו בדיקה" }, { category: "vegetable", text: "ירק לא מוכר" }, { category: "fruit", text: "תפוח בדיקה" }], user);
const row2 = (className, mealType, qty) => ({ ...row("444", "בית ספר שקילה", className, mealType, qty), quantities: { [D2]: qty } });
await importMilgam(q, { days: [D2], rows: [row2("גן", "תפזורת חובה", 10), row2("א1", "חמגשית א-ב", 20), row2("א1", "חמגשית צמחוני א-ב", 4), row2("ד1", "חמגשית ג-ו", 30), row2("ד1", "ללא אלרגניים", 2), row2("ד1", "משהו אחר", 5)], problems: [], sheetRows: 6 }, { kind: "forecast", fileName: "צפי שקילה", userId: user, addNew: true });
await setInstitutionMenu(q, (await one("select id from institutions where symbol = '444'")).id, scale, user);
const cook = await dayCooking(q, D2);
const line = (phrase) => { const l = cook.menus[0].lines.find((x) => x.phrase === phrase); return [l.scope, l.dish, l.portions, l.kg, l.rawKg, l.unweighed]; };
check("the main dish is weighed by age group; the item written for the kindergartens takes them out of it", [line("שניצל בדיקה"), line("קציצות בדיקה")], [["all", "שניצל בדיקה", 55, 5.6, 6.72, 5], ["gan", "קציצות בדיקה", 10, 0.9, null, 0]]);
check("the grain feeds the regular and the vegetarian plates", line("אורז בדיקה"), ["all", "אורז בדיקה", 69, 8.38, 3.352, 5]);
check("the vegetarian dish feeds only the vegetarian portions", line("טופו בדיקה"), ["all", "טופו בדיקה", 4, 0.4, null, 0]);
check("an item for a population the system cannot count is shown and not weighed", line("אפונה בדיקה"), ["other", null, 0, null, null, 0]);
check("a dish without weights is counted in portions only", line("תפוח בדיקה"), ["all", "תפוח בדיקה", 71, null, null, 71]);
check("a phrase with no dish is counted as not tied", [line("ירק לא מוכר"), cook.untied], [["all", null, 71, null, null, 0], 1]);
check("the day's totals per dish, over all menus", cook.totals.map((t) => [t.dish, t.portions, t.kg, t.rawKg]), [["קציצות בדיקה", 10, 0.9, null], ["שניצל בדיקה", 50, 5.6, 6.72], ["אורז בדיקה", 64, 8.38, 3.352], ["טופו בדיקה", 4, 0.4, null]]);
const phrases = await menuPhrases(q, scale);
check("a menu's phrases, each with the dish found by its name", phrases.map((p) => [p.category, p.phrase, p.dish, p.how, p.hasWeights]), [["main", "קציצות בדיקה", "קציצות בדיקה", "name", true], ["main", "שניצל בדיקה", "שניצל בדיקה", "name", true], ["grain", "אורז בדיקה", "אורז בדיקה", "name", true], ["hot_side", "אפונה בדיקה", null, null, false], ["vegetarian", "טופו בדיקה", "טופו בדיקה", "name", true], ["vegetable", "ירק לא מוכר", null, null, false], ["fruit", "תפוח בדיקה", "תפוח בדיקה", "name", false]]);
await setPhraseDish(q, "grain", "אורז בדיקה", bulgur, user);
check("a phrase tied by a person is weighed by the dish they chose", [(await menuPhrases(q, scale)).find((p) => p.phrase === "אורז בדיקה").how, (await dayCooking(q, D2)).menus[0].lines.find((x) => x.phrase === "אורז בדיקה").kg], ["tied", 3.2]);
await refuses("a phrase cannot be tied to a dish of another category", () => setPhraseDish(q, "main", "שניצל בדיקה", bulgur, user), "קטגוריה אחרת");
await refuses("bread is not weighed", () => setPhraseDish(q, "bread", "פיתה", bulgur, user), "אינה נשקלת");
await setPhraseDish(q, "grain", "אורז בדיקה", null, user);
check("removing the tie goes back to the dish found by name", (await dayCooking(q, D2)).menus[0].lines.find((x) => x.phrase === "אורז בדיקה").kg, 8.38);

console.log(failed === 0 ? "MENUS CHECK PASSED" : `MENUS CHECK FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
