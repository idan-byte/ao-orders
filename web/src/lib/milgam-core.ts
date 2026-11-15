// Hot food: reading a Milgam file (forecast or daily order) and taking it in as institutions, groups and
// quantities per day. No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { guessMealType } from "./menu-core.ts";

export class MilgamError extends Error {}

export type FileRow = {
  line: number; // the row number in the sheet, as Excel shows it
  symbol: string;
  name: string;
  kind: string | null;
  authority: string | null;
  program: string | null;
  className: string;
  mealType: string;
  address: string | null;
  kosher: string | null;
  notes: string | null;
  lifeThreatening: boolean;
  quantities: Record<string, number>; // ISO day -> portions
};
export type FileProblem = { line: number; reason: string };
export type ParsedFile = { days: string[]; rows: FileRow[]; problems: FileProblem[]; sheetRows: number };

const HEADERS = {
  symbol: "סמל מוסד",
  name: "שם מוסד",
  kind: "סוג מוסד",
  authority: "רשות",
  program: "תוכנית הזנה",
  className: "כתה",
  mealType: "סוג מנה",
  address: "כתובת לאספקה",
  kosherKind: "סוג כשרות",
  kosher: "כשרות",
  notes: "הערות",
  lifeThreatening: "יש אלרגיות מסכנות חיים",
} as const;

const tidy = (s: string | undefined) => (s ?? "").replace(/[ \t ]+/g, " ").trim();
const orNull = (s: string) => (s === "" ? null : s);
const iso = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
};

/** A column header that is a date: 05/11/2026, 5.11.2026, 2026-11-05, or the number Excel stores for a date. */
export function headerDay(header: string): string | null {
  const h = tidy(header);
  let m = h.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = h.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  if (/^\d{5}(\.0+)?$/.test(h)) {
    const serial = Number(h);
    if (serial >= 36526 && serial <= 73050) return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10); // years 2000-2099
  }
  return null;
}

/** Reads the grid of a Milgam sheet: one row per institution, class and meal type, one quantity column per day. */
export function parseMilgam(grid: string[][]): ParsedFile {
  const headerAt = grid.slice(0, 10).findIndex((r) => r.some((c) => tidy(c) === HEADERS.symbol));
  if (headerAt < 0) throw new MilgamError("זה לא נראה כמו קובץ מילגם: לא נמצאה העמודה ״סמל מוסד״.");
  const header = grid[headerAt].map(tidy);
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, h]) => [k, header.indexOf(h)])) as Record<keyof typeof HEADERS, number>;
  for (const k of ["className", "mealType"] as const) if (col[k] < 0) throw new MilgamError(`חסרה בקובץ העמודה ״${HEADERS[k]}״.`);
  const dayCols: { index: number; day: string }[] = [];
  header.forEach((h, index) => {
    const day = headerDay(h);
    if (day && !dayCols.some((d) => d.day === day)) dayCols.push({ index, day });
  });
  if (dayCols.length === 0) throw new MilgamError("לא נמצאה בקובץ עמודת כמות שהכותרת שלה היא תאריך.");

  const rows: FileRow[] = [];
  const problems: FileProblem[] = [];
  const seen = new Set<string>();
  let sheetRows = 0;
  for (let r = headerAt + 1; r < grid.length; r++) {
    const cells = grid[r];
    if (!cells || cells.every((c) => tidy(c) === "")) continue;
    sheetRows++;
    const line = r + 1;
    const get = (k: keyof typeof HEADERS) => (col[k] < 0 ? "" : tidy(cells[col[k]]));
    const [symbol, className, mealType] = [get("symbol"), get("className"), get("mealType")];
    if (!symbol || !className || !mealType) {
      problems.push({ line, reason: "חסר סמל מוסד, כיתה או סוג מנה" });
      continue;
    }
    const key = `${symbol}\n${className}\n${mealType}`;
    if (seen.has(key)) {
      problems.push({ line, reason: `שורה כפולה: מוסד ${symbol}, כיתה ${className}, ${mealType}` });
      continue;
    }
    seen.add(key);
    const quantities: Record<string, number> = {};
    let bad: string | null = null;
    for (const d of dayCols) {
      const raw = tidy(cells[d.index]);
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 100000) {
        bad = `כמות לא תקינה (״${raw.slice(0, 20)}״) בתאריך ${d.day}`;
        break;
      }
      if (n > 0) quantities[d.day] = n;
    }
    if (bad) {
      problems.push({ line, reason: bad });
      continue;
    }
    // The remarks keep their line breaks: they are allergy instructions and are shown whole.
    const notes = col.notes < 0 ? "" : (cells[col.notes] ?? "").replace(/\r\n?/g, "\n").trim();
    rows.push({
      line,
      symbol,
      name: get("name") || symbol,
      kind: orNull(get("kind")),
      authority: orNull(get("authority")),
      program: orNull(get("program")),
      className,
      mealType,
      address: orNull(get("address")),
      kosher: orNull([get("kosherKind"), get("kosher")].filter(Boolean).join(" · ")),
      notes: orNull(notes),
      lifeThreatening: get("lifeThreatening") === "כן",
      quantities,
    });
  }
  return { days: dayCols.map((d) => d.day).sort(), rows, problems, sheetRows };
}

export type Held = { line: number; symbol: string; name: string; className: string; mealType: string; portions: number; reason: string };
export type ImportSummary = {
  importId: number;
  kind: "forecast" | "daily";
  cells: number;
  portions: number;
  days: string[]; // the days this import replaced
  added: { institutions: string[]; mealTypes: string[]; groups: number };
  held: Held[];
  problems: FileProblem[];
};

/**
 * Takes a parsed file in. For every day that has quantities in the file, the file replaces what was known
 * for that day (of the same kind), so loading a file again updates and never doubles.
 * A row whose institution or meal type is not known is held back and listed, unless `addNew` says to add them.
 * A new class of a known institution is added by itself: classes open during the year.
 */
export async function importMilgam(q: Q, file: ParsedFile, input: { kind: "forecast" | "daily"; fileName: string; userId: string | null; addNew: boolean }): Promise<ImportSummary> {
  const { kind, addNew } = input;
  const institutions = new Map((await q<{ id: number; symbol: string }>("select id, symbol from institutions")).map((r) => [r.symbol, r.id]));
  const mealTypes = new Map((await q<{ id: number; name: string }>("select id, name from meal_types")).map((r) => [r.name, r.id]));
  const programs = new Map((await q<{ id: number; name: string }>("select id, name from feeding_programs")).map((r) => [r.name, r.id]));
  const groups = new Map((await q<{ id: number; institution_id: number; class_name: string }>("select id, institution_id, class_name from institution_groups")).map((r) => [`${r.institution_id}\n${r.class_name}`, r.id]));
  const added = { institutions: [] as string[], mealTypes: [] as string[], groups: 0 };
  const held: Held[] = [];
  const cells: { group: number; meal: number; day: string; qty: number }[] = [];
  const days = new Set<string>();
  const refreshed = new Set<string>();

  for (const row of file.rows) {
    const portions = Object.values(row.quantities).reduce((a, b) => a + b, 0);
    for (const day of Object.keys(row.quantities)) days.add(day);
    const unknown = [!institutions.has(row.symbol) ? "מוסד לא מוכר" : null, !mealTypes.has(row.mealType) ? "סוג מנה לא מוכר" : null].filter(Boolean);
    if (unknown.length > 0 && !addNew) {
      held.push({ line: row.line, symbol: row.symbol, name: row.name, className: row.className, mealType: row.mealType, portions, reason: unknown.join(", ") });
      continue;
    }
    let institutionId = institutions.get(row.symbol);
    if (institutionId === undefined) {
      [{ id: institutionId }] = await q<{ id: number }>("insert into institutions (symbol, name, kind, authority, address, kosher, notes, life_threatening) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id", [row.symbol, row.name, row.kind, row.authority, row.address, row.kosher, row.notes, row.lifeThreatening]);
      institutions.set(row.symbol, institutionId);
      added.institutions.push(`${row.name} (${row.symbol})`);
      refreshed.add(row.symbol);
    } else if (!refreshed.has(row.symbol)) {
      // Milgam is the source of these details. The remarks matter most: they are the allergy instructions.
      await q("update institutions set name = $2, kind = $3, authority = $4, address = coalesce($5, address), kosher = coalesce($6, kosher), notes = $7, life_threatening = $8 where id = $1", [institutionId, row.name, row.kind, row.authority, row.address, row.kosher, row.notes, row.lifeThreatening]);
      refreshed.add(row.symbol);
    }
    let mealId = mealTypes.get(row.mealType);
    if (mealId === undefined) {
      const guess = guessMealType(row.mealType);
      [{ id: mealId }] = await q<{ id: number }>("insert into meal_types (name, age_group, diet) values ($1, $2, $3) returning id", [row.mealType, guess.ageGroup, guess.diet]);
      mealTypes.set(row.mealType, mealId);
      added.mealTypes.push(row.mealType);
    }
    let programId: number | null = null;
    if (row.program) {
      programId = programs.get(row.program) ?? null;
      if (programId === null) {
        [{ id: programId }] = await q<{ id: number }>("insert into feeding_programs (name) values ($1) returning id", [row.program]);
        programs.set(row.program, programId);
      }
    }
    const groupKey = `${institutionId}\n${row.className}`;
    let groupId = groups.get(groupKey);
    if (groupId === undefined) {
      [{ id: groupId }] = await q<{ id: number }>("insert into institution_groups (institution_id, class_name, program_id) values ($1, $2, $3) returning id", [institutionId, row.className, programId]);
      groups.set(groupKey, groupId);
      added.groups++;
    }
    for (const [day, qty] of Object.entries(row.quantities)) cells.push({ group: groupId, meal: mealId, day, qty });
  }

  const dayList = [...days].sort();
  const portions = cells.reduce((a, c) => a + c.qty, 0);
  const [{ id: importId }] = await q<{ id: number }>(
    "insert into milgam_imports (kind, file_name, uploaded_by, file_rows, cells, portions, day_from, day_to, added, held) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id",
    [kind, input.fileName.slice(0, 200), input.userId, file.sheetRows, cells.length, portions, dayList[0] ?? null, dayList.at(-1) ?? null, JSON.stringify(added), JSON.stringify({ rows: held, problems: file.problems })],
  );
  if (dayList.length > 0) {
    const [qtyCol, importCol] = kind === "forecast" ? ["forecast_qty", "forecast_import_id"] : ["ordered_qty", "ordered_import_id"];
    await q(`update milgam_quantities set ${qtyCol} = null, ${importCol} = null where day = any($1::date[])`, [dayList]);
    if (cells.length > 0) {
      await q(
        `insert into milgam_quantities (group_id, meal_type_id, day, ${qtyCol}, ${importCol})
         select g, m, d::date, n, $5 from unnest($1::int[], $2::int[], $3::text[], $4::int[]) as t(g, m, d, n)
         on conflict (group_id, meal_type_id, day) do update set ${qtyCol} = excluded.${qtyCol}, ${importCol} = excluded.${importCol}`,
        [cells.map((c) => c.group), cells.map((c) => c.meal), cells.map((c) => c.day), cells.map((c) => c.qty), importId],
      );
    }
    await q("delete from milgam_quantities where day = any($1::date[]) and forecast_qty is null and ordered_qty is null", [dayList]);
    if (kind === "daily") {
      await q("insert into milgam_order_days (day, import_id) select d::date, $2 from unnest($1::text[]) as t(d) on conflict (day) do update set import_id = excluded.import_id, loaded_at = now()", [dayList, importId]);
    }
  }
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'milgam_import', 'milgam_import', $2, $3)", [input.userId, String(importId), JSON.stringify({ kind, days: dayList.length, cells: cells.length, portions, held: held.length })]);
  return { importId, kind, cells: cells.length, portions, days: dayList, added, held, problems: file.problems };
}

// ---------- reading what was taken in

export type DayTotal = { day: string; forecast: number; ordered: number | null; groups: number; institutions: number };

/** Totals per day, newest first. `ordered` is null until a daily order was loaded for that day. */
export async function milgamDays(q: Q, limit = 30): Promise<DayTotal[]> {
  return q<DayTotal>(
    `select mq.day::text, coalesce(sum(mq.forecast_qty), 0)::int as forecast,
            case when od.day is null then null else coalesce(sum(mq.ordered_qty), 0)::int end as ordered,
            count(distinct mq.group_id)::int as groups, count(distinct g.institution_id)::int as institutions
     from milgam_quantities mq join institution_groups g on g.id = mq.group_id left join milgam_order_days od on od.day = mq.day
     group by mq.day, od.day order by mq.day desc limit $1`,
    [limit],
  );
}

export type MealTotal = { mealType: string; sku: string | null; forecast: number; ordered: number | null; rows: number };

/** One day by meal type: what was forecast and what was ordered. */
export async function dayByMealType(q: Q, day: string): Promise<MealTotal[]> {
  return q<MealTotal>(
    `select mt.name as "mealType", mt.sku, coalesce(sum(mq.forecast_qty), 0)::int as forecast,
            case when exists (select 1 from milgam_order_days od where od.day = $1::date) then coalesce(sum(mq.ordered_qty), 0)::int end as ordered, count(*)::int as rows
     from milgam_quantities mq join meal_types mt on mt.id = mq.meal_type_id where mq.day = $1::date group by mt.id order by mt.name`,
    [day],
  );
}

export type ImportRow = { id: number; kind: "forecast" | "daily"; fileName: string; uploadedAt: string; by: string | null; fileRows: number; cells: number; portions: number; dayFrom: string | null; dayTo: string | null; held: number; problems: number };

export async function recentImports(q: Q, limit = 10): Promise<ImportRow[]> {
  return q<ImportRow>(
    `select i.id, i.kind, i.file_name as "fileName", i.uploaded_at::text as "uploadedAt", u.full_name as by, i.file_rows as "fileRows", i.cells, i.portions,
            i.day_from::text as "dayFrom", i.day_to::text as "dayTo", jsonb_array_length(coalesce(i.held->'rows', '[]'::jsonb)) as held, jsonb_array_length(coalesce(i.held->'problems', '[]'::jsonb)) as problems
     from milgam_imports i left join users u on u.id = i.uploaded_by order by i.id desc limit $1`,
    [limit],
  );
}

export type InstitutionRow = { id: number; symbol: string; name: string; kind: string | null; authority: string | null; address: string | null; kosher: string | null; notes: string | null; lifeThreatening: boolean; groups: number; customer: string | null; active: boolean };

export async function listInstitutions(q: Q): Promise<InstitutionRow[]> {
  return q<InstitutionRow>(
    `select i.id, i.symbol, i.name, i.kind, i.authority, i.address, i.kosher, i.notes, i.life_threatening as "lifeThreatening", i.active,
            (select count(*)::int from institution_groups g where g.institution_id = i.id) as groups, c.name as customer
     from institutions i left join customers c on c.id = i.customer_id order by i.authority nulls last, i.name, i.symbol`,
  );
}

export type MealTypeRow = { id: number; name: string; sku: string | null; product: string | null; active: boolean; ageGroup: string | null; diet: string };

export async function listMealTypes(q: Q): Promise<MealTypeRow[]> {
  return q<MealTypeRow>(`select mt.id, mt.name, mt.sku, p.name as product, mt.active, mt.age_group as "ageGroup", mt.diet from meal_types mt left join products p on p.sku = mt.sku order by mt.name`);
}

/** Maps a meal type to the Hashavshevet item it is billed as. Only an existing item can be chosen. */
export async function setMealTypeSku(q: Q, mealTypeId: number, sku: string | null, userId: string): Promise<void> {
  const [mt] = await q<{ sku: string | null }>("select sku from meal_types where id = $1 for update", [mealTypeId]);
  if (!mt) throw new MilgamError("סוג המנה לא נמצא.");
  if (sku !== null) {
    const [p] = await q("select 1 from products where sku = $1", [sku]);
    if (!p) throw new MilgamError("המק״ט לא קיים בקטלוג.");
  }
  if (mt.sku === sku) return;
  await q("update meal_types set sku = $2 where id = $1", [mealTypeId, sku]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'meal_type_sku', 'meal_type', $2, $3, $4)", [userId, String(mealTypeId), JSON.stringify({ sku: mt.sku }), JSON.stringify({ sku })]);
}
