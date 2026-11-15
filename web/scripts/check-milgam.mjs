// Tests reading Milgam Excel files and taking them in: the xlsx reader, the sheet layout, the forecast and the
// daily order side by side, loading a file again, and rows held back for review. All data here is made up.
// Run from the web folder:  node scripts/check-milgam.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { zip, workbook } from "./xlsx-write.mjs";
import { readXlsx, XlsxError } from "../src/lib/xlsx-read.ts";
import { parseMilgam, headerDay, importMilgam, milgamDays, dayByMealType, recentImports, listInstitutions, listMealTypes, setMealTypeSku, MilgamError } from "../src/lib/milgam-core.ts";

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
function refuses(label, fn, fragment, type) {
  try { fn(); failed++; console.log(`FAIL ${label} -> was accepted`); }
  catch (e) { const ok = e.message.includes(fragment) && (!type || e instanceof type); if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> wrong error: ${e.message}`}`); }
}

// ---------- the xlsx reader
const small = [["א", "ב & ג", "", "ד"], ["1", "", "שורה\r\nשנייה", ""], [], ["<x>", 46331, "", ""]];
check("a compressed workbook is read back cell by cell, empty cells and rows included", readXlsx(workbook(small)), [["א", "ב & ג", "", "ד"], ["1", "", "שורה\r\nשנייה", ""], ["", "", "", ""], ["<x>", "46331", "", ""]]);
check("an uncompressed workbook is read the same", readXlsx(workbook(small, false))[0], ["א", "ב & ג", "", "ד"]);
check("inline strings and rich text are read", readXlsx(zip({ "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>סמל</t></is></c><c r="C1" t="inlineStr"><is><r><t>חלק </t></r><r><t>שני</t></r></is></c></row></sheetData></worksheet>' })), [["סמל", "", "חלק שני"]]);
refuses("a file that is not a workbook is refused", () => readXlsx(new TextEncoder().encode("סמל מוסד,כתה\n1,2\n".repeat(5))), "אינו קובץ אקסל", XlsxError);
refuses("a broken archive is refused, not crashed on", () => readXlsx(workbook(small).slice(0, 200)), "אקסל", XlsxError);
refuses("a workbook without a sheet is refused", () => readXlsx(zip({ "xl/workbook.xml": "<workbook/>" })), "לא נמצא גיליון", XlsxError);

// ---------- column headers that are days
check("day headers in the forms Excel gives", [headerDay("05/11/2026"), headerDay("5.11.2026"), headerDay("2026-11-05"), headerDay("46331"), headerDay(" 01/09/2026 ")], ["2026-11-05", "2026-11-05", "2026-11-05", "2026-11-05", "2026-09-01"]);
check("what is not a day", [headerDay("כתה"), headerDay("31/02/2026"), headerDay("7600000"), headerDay("05/11"), headerDay("")], [null, null, null, null, null]);

// ---------- the sheet layout (made-up institutions)
const HEAD = ["מחוז", "רשות", "סמל מוסד", "שם מוסד", "סוג מוסד", "תוכנית הזנה", "כתה", "סוג מנה", "כתובת לאספקה", "סוג כשרות", "כשרות", "הערות", "יש אלרגיות מסכנות חיים"];
const row = (symbol, name, cls, meal, q, extra = {}) => ["ירושלים", extra.authority ?? "עיר א", symbol, name, extra.kind ?? "בית ספר", extra.program ?? "יוחא", cls, meal, extra.address ?? "רחוב הדוגמה 1", "רבנות", "רגילה", extra.notes ?? "", extra.flag ?? "לא", ...q];
const NOTE = "א1- ללא ביצים\r\nב1- ללא שומשום (טחינה, ממרח חומוס)";
const forecastGrid = [
  [...HEAD, "02/11/2026", "03/11/2026", "06/11/2026", "05/11/2026"],
  row("111111", "בית ספר אלון", "א1", "חמגשית א-ב", ["20", "20", "", "22"], { notes: NOTE, flag: "כן" }),
  row("111111", "בית ספר אלון", "א1", "חמגשית צמחוני א-ב", ["3", "3", "", "3"], { notes: NOTE, flag: "כן" }),
  row("111111", "בית ספר אלון", "ב1", "חמגשית א-ב", ["18", "", "", "18"], { notes: NOTE, flag: "כן" }),
  [],
  row("615955-1", "גן רימון", "גן חובה", "תפזורת חובה", ["30", "30", "", "0"], { kind: "גן", program: "ניצנים מילגם" }),
  row("210", "בית ספר ברוש", "ז", "חמגשית על יסודי", ["80", "80", "", "80"], { program: "משקם" }),
];
const parsed = parseMilgam(readXlsx(workbook(forecastGrid)));
check("days come from the headers, in order, whatever the column order", parsed.days, ["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"]);
check("one row per institution, class and meal type; blank rows are skipped", [parsed.rows.length, parsed.sheetRows, parsed.problems], [5, 5, []]);
check("a row keeps its symbol as text, its class, meal type and quantities; empty and zero cells are no quantity", [parsed.rows[3].symbol, parsed.rows[3].className, parsed.rows[3].mealType, parsed.rows[3].quantities, parsed.rows[0].quantities], ["615955-1", "גן חובה", "תפזורת חובה", { "2026-11-02": 30, "2026-11-03": 30 }, { "2026-11-02": 20, "2026-11-03": 20, "2026-11-05": 22 }]);
check("the remarks are kept whole, with their line break, and the allergy flag is read", [parsed.rows[0].notes, parsed.rows[0].lifeThreatening, parsed.rows[3].notes, parsed.rows[3].lifeThreatening, parsed.rows[0].line], ["א1- ללא ביצים\nב1- ללא שומשום (טחינה, ממרח חומוס)", true, null, false, 2]);
refuses("a sheet without the institution symbol is not a Milgam file", () => parseMilgam([["שם", "כמות"], ["x", "1"]]), "סמל מוסד", MilgamError);
refuses("a sheet without a day column is refused", () => parseMilgam([HEAD, row("1", "x", "א1", "חמגשית א-ב", [])]), "תאריך", MilgamError);
refuses("a sheet without the meal type column is refused", () => parseMilgam([["סמל מוסד", "כתה", "05/11/2026"]]), "סוג מנה", MilgamError);
const messy = parseMilgam([[...HEAD, "05/11/2026"], row("111111", "x", "א1", "חמגשית א-ב", ["20"]), row("111111", "x", "א1", "חמגשית א-ב", ["5"]), row("111111", "x", "א2", "חמגשית א-ב", ["עשרים"]), row("", "x", "א3", "חמגשית א-ב", ["4"]), row("111111", "x", "א4", "חמגשית א-ב", ["2.5"])]);
check("a doubled row, a quantity that is not a whole number and a row without a symbol are reported with their line, not taken", [messy.rows.length, messy.problems.map((p) => p.line), messy.problems[1].reason], [1, [3, 4, 5, 6], "כמות לא תקינה (״עשרים״) בתאריך 2026-11-05"]);

// ---------- taking a forecast in
const user = (await one("insert into users (mobile, full_name, role) values ('0500000030', 'מנהל', 'admin') returning id::text")).id;
const totals = async () => (await milgamDays(q)).map((d) => [d.day, d.forecast, d.ordered, d.groups, d.institutions]);
const heldFirst = await importMilgam(q, parsed, { kind: "forecast", fileName: "צפי.xlsx", userId: user, addNew: false });
check("on an empty system every row is held for review and nothing is created", [heldFirst.cells, heldFirst.held.length, heldFirst.held[0].reason, heldFirst.held[0].portions, (await one("select count(*)::int as n from institutions")).n, await totals()], [0, 5, "מוסד לא מוכר, סוג מנה לא מוכר", 62, 0, []]);
const first = await importMilgam(q, parsed, { kind: "forecast", fileName: "צפי.xlsx", userId: user, addNew: true });
check("with approval the institutions, meal types and groups are created and the quantities are taken", [first.cells, first.portions, first.held, first.added.institutions, first.added.mealTypes.length, first.added.groups, first.days], [13, 407, [], ["בית ספר אלון (111111)", "גן רימון (615955-1)", "בית ספר ברוש (210)"], 4, 4, ["2026-11-02", "2026-11-03", "2026-11-05"]]);
check("totals per day; no order was loaded yet", await totals(), [["2026-11-05", 123, null, 3, 2], ["2026-11-03", 133, null, 3, 3], ["2026-11-02", 151, null, 4, 3]]);
check("two rows of one class are one group", (await one("select count(*)::int as n from institution_groups g join institutions i on i.id = g.institution_id where i.symbol = '111111'")).n, 2);
const list = await listInstitutions(q);
check("institutions carry Milgam's details, the allergy flag and the whole remark", list.map((i) => [i.symbol, i.kind, i.groups, i.lifeThreatening, i.notes?.includes("\n") ?? false, i.customer]), [["111111", "בית ספר", 2, true, true, null], ["210", "בית ספר", 1, false, false, null], ["615955-1", "גן", 1, false, false, null]]);

// ---------- loading again updates and never doubles
const again = await importMilgam(q, parsed, { kind: "forecast", fileName: "צפי.xlsx", userId: user, addNew: false });
check("the same file again changes no total and creates nothing", [again.cells, again.added, await totals(), (await one("select count(*)::int as n from milgam_quantities")).n], [13, { institutions: [], mealTypes: [], groups: 0 }, [["2026-11-05", 123, null, 3, 2], ["2026-11-03", 133, null, 3, 3], ["2026-11-02", 151, null, 4, 3]], 13]);
const updatedGrid = [
  [...HEAD, "03/11/2026", "04/11/2026"],
  row("111111", "בית ספר אלון", "א1", "חמגשית א-ב", ["25", "25"], { notes: "א1- ללא ביצים וללא חלב", flag: "כן" }),
  row("111111", "בית ספר אלון", "ג1", "חמגשית ג-ו", ["", "12"], { notes: "א1- ללא ביצים וללא חלב", flag: "כן" }),
  row("999999", "בית ספר חדש", "א1", "חמגשית א-ב", ["40", "40"]),
];
const updated = await importMilgam(q, parseMilgam(readXlsx(workbook(updatedGrid))), { kind: "forecast", fileName: "צפי 2.xlsx", userId: user, addNew: false });
check("a newer forecast replaces its own days only; an unknown institution is held; a new class and a new meal type of a known one differ", [updated.days, updated.held.map((h) => [h.symbol, h.reason, h.portions]), updated.added.groups, updated.held.length], [["2026-11-03", "2026-11-04"], [["111111", "סוג מנה לא מוכר", 12], ["999999", "מוסד לא מוכר", 80]], 0, 2]);
check("the day in the new file is replaced as a whole; the other days are untouched", await totals(), [["2026-11-05", 123, null, 3, 2], ["2026-11-04", 25, null, 1, 1], ["2026-11-03", 25, null, 1, 1], ["2026-11-02", 151, null, 4, 3]]);
check("the institution's remark follows the newest file", (await one("select notes from institutions where symbol = '111111'")).notes, "א1- ללא ביצים וללא חלב");

// ---------- the daily order next to the forecast
const dailyGrid = [
  [...HEAD, "05/11/2026"],
  row("111111", "בית ספר אלון", "א1", "חמגשית א-ב", ["24"], { notes: NOTE, flag: "כן" }),
  row("111111", "בית ספר אלון", "ב1", "חמגשית א-ב", ["18"], { notes: NOTE, flag: "כן" }),
  row("111111", "בית ספר אלון", "ב2", "חמגשית א-ב", ["15"], { notes: NOTE, flag: "כן" }),
  row("210", "בית ספר ברוש", "ז", "חמגשית על יסודי", ["80"], { program: "משקם" }),
];
const daily = await importMilgam(q, parseMilgam(readXlsx(workbook(dailyGrid))), { kind: "daily", fileName: "הזמנה.xlsx", userId: user, addNew: false });
check("a new class of a known institution is added by itself", [daily.added.groups, daily.held, daily.portions], [1, [], 137]);
check("the order sits next to the forecast for that day; other days still have no order", await totals(), [["2026-11-05", 123, 137, 4, 2], ["2026-11-04", 25, null, 1, 1], ["2026-11-03", 25, null, 1, 1], ["2026-11-02", 151, null, 4, 3]]);
check("the day by meal type: forecast against order", (await dayByMealType(q, "2026-11-05")).map((m) => [m.mealType, m.forecast, m.ordered, m.sku]), [["חמגשית א-ב", 40, 57, null], ["חמגשית על יסודי", 80, 80, null], ["חמגשית צמחוני א-ב", 3, 0, null]]);
check("a line that was forecast and not ordered keeps its forecast and has no order", await one("select mq.forecast_qty, mq.ordered_qty from milgam_quantities mq join meal_types mt on mt.id = mq.meal_type_id where mq.day = '2026-11-05' and mt.name = 'חמגשית צמחוני א-ב'"), { forecast_qty: 3, ordered_qty: null });
await importMilgam(q, parsed, { kind: "forecast", fileName: "צפי.xlsx", userId: user, addNew: false });
check("a forecast loaded after the order does not touch the order", (await totals())[0], ["2026-11-05", 123, 137, 4, 2]);
const corrected = await importMilgam(q, parseMilgam(readXlsx(workbook([dailyGrid[0], dailyGrid[1], dailyGrid[4]]))), { kind: "daily", fileName: "הזמנה מתוקנת.xlsx", userId: user, addNew: false });
check("a corrected order replaces the day's order", [corrected.portions, (await totals())[0]], [104, ["2026-11-05", 123, 104, 3, 2]]);

// ---------- the record of imports, and meal types to SKUs
const imports = await recentImports(q);
check("every load is recorded with who, what and how much was held", [imports.length, imports[0].kind, imports[0].fileName, imports[0].by, imports[0].portions, imports.at(-1).held, imports[0].dayFrom], [7, "daily", "הזמנה מתוקנת.xlsx", "מנהל", 104, 5, "2026-11-05"]);
await q("insert into products (sku, name, base_price, sort_group) values ('60001', 'חמגשית מילגם', 20, 600)");
const meal = (await listMealTypes(q)).find((m) => m.name === "חמגשית א-ב");
await setMealTypeSku(q, meal.id, "60001", user);
check("a meal type is mapped to a catalogue item", (await listMealTypes(q)).find((m) => m.name === "חמגשית א-ב"), { id: meal.id, name: "חמגשית א-ב", sku: "60001", product: "חמגשית מילגם", active: true, ageGroup: "ab", diet: "regular" });
let threw = "";
try { await setMealTypeSku(q, meal.id, "99999", user); } catch (e) { threw = e.message; }
check("an item that is not in the catalogue cannot be chosen", threw, "המק״ט לא קיים בקטלוג.");
await setMealTypeSku(q, meal.id, null, user);
check("the mapping can be cleared, and both changes are in the history", [(await listMealTypes(q)).find((m) => m.name === "חמגשית א-ב").sku, (await one("select count(*)::int as n from audit_log where action = 'meal_type_sku'")).n], [null, 2]);

console.log(failed ? `MILGAM CHECK FAILED (${failed})` : "MILGAM CHECK PASSED");
process.exit(failed ? 1 : 0);
