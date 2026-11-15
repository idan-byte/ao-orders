// Tests hot-food menus: creating and renaming, the menu an institution follows, the dishes of a date,
// copying a date, and the kitchen's day report from the forecast and from the daily order. All data is made up.
// Run from the web folder:  node scripts/check-menus.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { importMilgam } from "../src/lib/milgam-core.ts";
import { createMenu, updateMenu, listMenus, setInstitutionMenu, setMenuDay, copyMenuDay, menuDays, menuDayReport, splitDishes } from "../src/lib/menu-core.ts";

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

const DAY = "2026-12-08", NEXT = "2026-12-09";
const user = (await one("insert into users (mobile, full_name, role) values ('0500000041', 'מנהל', 'admin') returning id::text")).id;

// ---------- menus
const school = await createMenu(q, "  בתי   ספר ", user);
const kinder = await createMenu(q, "גנים", user);
check("a menu's name is tidied", (await listMenus(q)).map((m) => m.name), ["בתי ספר", "גנים"]);
await refuses("two menus cannot share a name", () => createMenu(q, "גנים", user), "כבר קיים");
await refuses("a menu needs a name", () => createMenu(q, " ", user), "שם");
await updateMenu(q, kinder, "גני ילדים", true, user);
await refuses("renaming onto another menu's name is refused", () => updateMenu(q, kinder, "בתי ספר", true, user), "כבר קיים");

// ---------- institutions and quantities
const row = (symbol, name, className, mealType, qty) => ({ line: 0, symbol, name, kind: "בית ספר", authority: "עיר", program: "יוחא", className, mealType, address: "כתובת", kosher: null, notes: null, lifeThreatening: false, quantities: { [DAY]: qty } });
const file = (rows) => ({ days: [DAY], rows, problems: [], sheetRows: rows.length });
const FORECAST = [row("111", "בית ספר אלון", "א1", "חמגשית", 20), row("111", "בית ספר אלון", "א1", "צמחוני", 3), row("111", "בית ספר אלון", "ב1", "חמגשית", 18), row("222", "גן רימון", "גן", "תפזורת", 30), row("333", "מוסד בלי תפריט", "ג1", "חמגשית", 7)];
await importMilgam(q, file(FORECAST), { kind: "forecast", fileName: "צפי", userId: user, addNew: true });
const inst = Object.fromEntries((await q("select id, symbol from institutions")).map((r) => [r.symbol, r.id]));

await setInstitutionMenu(q, inst["111"], school, user);
await setInstitutionMenu(q, inst["222"], kinder, user);
check("the list counts the institutions of every menu", (await listMenus(q)).map((m) => [m.name, m.institutions]), [["בתי ספר", 1], ["גני ילדים", 1]]);
await refuses("a menu that institutions follow cannot be switched off", () => updateMenu(q, school, "בתי ספר", false, user), "אי אפשר להשבית");
await refuses("an unknown menu cannot be chosen", () => setInstitutionMenu(q, inst["333"], 9999, user), "לא נמצא");
const spare = await createMenu(q, "ישן", user);
await updateMenu(q, spare, "ישן", false, user);
await refuses("a switched-off menu cannot be chosen", () => setInstitutionMenu(q, inst["333"], spare, user), "מושבת");

// ---------- the dishes of a date
check("typed dishes are split by lines and commas, without repeats", splitDishes("שניצל, אורז\nשניצל ;  סלט  ירקות "), ["שניצל", "אורז", "סלט ירקות"]);
check("a day keeps its dishes", await setMenuDay(q, school, DAY, [{ category: "main", name: "שניצל" }, { category: "side", name: "אורז" }, { category: "side", name: " אורז " }, { category: "vegetarian", name: "קציצות עדשים" }, { category: "other", name: "  " }], user), 3);
await refuses("an unknown category is refused", () => setMenuDay(q, school, DAY, [{ category: "dessert", name: "עוגה" }], user), "קטגוריית");
await refuses("a bad date is refused", () => setMenuDay(q, school, "8.12.2026", [], user), "התאריך");
check("the dishes come back by category", (await menuDays(q, school, DAY, NEXT))[DAY], { main: ["שניצל"], side: ["אורז"], vegetable: [], vegetarian: ["קציצות עדשים"], other: [] });
const auditBefore = (await one("select count(*)::int as n from audit_log where action = 'menu_day'")).n;
await setMenuDay(q, school, DAY, [{ category: "side", name: "אורז" }, { category: "main", name: "שניצל" }, { category: "vegetarian", name: "קציצות עדשים" }], user);
check("saving the same dishes again writes nothing to the history", (await one("select count(*)::int as n from audit_log where action = 'menu_day'")).n, auditBefore);
check("a date is copied to another date", [await copyMenuDay(q, school, DAY, NEXT, user), Object.keys(await menuDays(q, school, DAY, NEXT))], [3, [DAY, NEXT]]);
await refuses("copying an empty date is refused", () => copyMenuDay(q, kinder, DAY, NEXT, user), "אין מנות");
check("an empty list clears the date", [await setMenuDay(q, school, NEXT, [], user), Object.keys(await menuDays(q, school, DAY, NEXT))], [0, [DAY]]);

// ---------- the kitchen's day report
const r1 = await menuDayReport(q, DAY);
check("before the daily order the report shows the forecast", [r1.ordered, r1.total], [false, 78]);
check("portions are split by menu and meal type; an institution without a menu is not left out", r1.menus.map((m) => [m.menu, m.institutions, m.portions, m.meals.map((x) => `${x.quantity} ${x.mealType}`)]), [["בתי ספר", 1, 41, ["38 חמגשית", "3 צמחוני"]], ["גני ילדים", 1, 30, ["30 תפזורת"]], [null, 1, 7, ["7 חמגשית"]]]);
check("a menu shows the day's dishes; a menu without dishes for the day shows none", [r1.menus[0].dishes?.main, r1.menus[1].dishes, r1.menus[2].dishes], [["שניצל"], null, null]);
const ORDER = [row("111", "בית ספר אלון", "א1", "חמגשית", 22), row("111", "בית ספר אלון", "ב1", "חמגשית", 18), row("222", "גן רימון", "גן", "תפזורת", 28)];
await importMilgam(q, file(ORDER), { kind: "daily", fileName: "הזמנה", userId: user, addNew: false });
const r2 = await menuDayReport(q, DAY);
check("after the daily order the report follows the order", [r2.ordered, r2.total, r2.menus.map((m) => [m.menu, m.portions])], [true, 68, [["בתי ספר", 40], ["גני ילדים", 28]]]);
check("a day with nothing is an empty report", [(await menuDayReport(q, "2027-01-01")).menus.length, (await menuDayReport(q, "2027-01-01")).total], [0, 0]);

await setInstitutionMenu(q, inst["111"], null, user);
check("an institution can be taken off its menu", (await one("select menu_id from institutions where id = $1", [inst["111"]])).menu_id, null);

console.log(failed === 0 ? "MENUS CHECK PASSED" : `MENUS CHECK FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
