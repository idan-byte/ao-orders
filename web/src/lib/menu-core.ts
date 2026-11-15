// Hot food menus. A menu is closed in advance and cyclic: a few weeks that repeat, each calendar week named by
// its Sunday. Every institution follows one menu. For each week of the cycle and each weekday the menu holds what
// is served per category, as written in the approved document. The kitchen's day report puts the day's cells
// next to the portions, split by diet and age group.
// No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { CELL_CATEGORIES, WEEKDAYS, sundayOf, type CellCategory, type ParsedMenu } from "./menu-parse-core.ts";

export class MenuError extends Error {}

export const AGE_GROUPS = [
  { key: "gan", label: "גן" },
  { key: "ab", label: "א-ב" },
  { key: "gv", label: "ג-ו" },
  { key: "high", label: "על יסודי" },
] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number]["key"];
export const DIETS = [
  { key: "regular", label: "רגיל" },
  { key: "vegetarian", label: "צמחוני" },
  { key: "allergen_free", label: "ללא אלרגנים" },
] as const;
export type Diet = (typeof DIETS)[number]["key"];

const CATEGORY_KEYS: string[] = CELL_CATEGORIES.map((c) => c.key);
const SKU_CATEGORIES: string[] = CELL_CATEGORIES.filter((c) => c.sku).map((c) => c.key);
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
const tidy = (s: string) => s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();

/** The age group and diet a Milgam meal type name points at: "חמגשית צמחוני ג-ו". A guess a person can correct. */
export function guessMealType(name: string): { ageGroup: AgeGroup | null; diet: Diet } {
  const ageGroup: AgeGroup | null = name.includes("על יסודי") ? "high" : name.includes("ג-ו") ? "gv" : name.includes("א-ב") ? "ab" : /(^|\s)(גן|גנים|חובה)(\s|$)/.test(name) ? "gan" : null;
  const diet: Diet = name.includes("אלרג") ? "allergen_free" : name.includes("צמחונ") || name.includes("טבעונ") ? "vegetarian" : "regular";
  return { ageGroup, diet };
}

export async function setMealTypeGroup(q: Q, mealTypeId: number, ageGroup: string | null, diet: string, userId: string): Promise<void> {
  if (ageGroup !== null && !AGE_GROUPS.some((g) => g.key === ageGroup)) throw new MenuError("קבוצת הגיל אינה מוכרת.");
  if (!DIETS.some((d) => d.key === diet)) throw new MenuError("סוג התזונה אינו מוכר.");
  const [before] = await q<{ age_group: string | null; diet: string }>("select age_group, diet from meal_types where id = $1 for update", [mealTypeId]);
  if (!before) throw new MenuError("סוג המנה לא נמצא.");
  if (before.age_group === ageGroup && before.diet === diet) return;
  await q("update meal_types set age_group = $2, diet = $3 where id = $1", [mealTypeId, ageGroup, diet]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'meal_type_group', 'meal_type', $2, $3, $4)", [userId, String(mealTypeId), JSON.stringify(before), JSON.stringify({ age_group: ageGroup, diet })]);
}

// ---------- menus

export type MenuSummary = { id: number; name: string; active: boolean; weeks: number; period: string | null; institutions: number; lastWeek: string | null };

export async function listMenus(q: Q): Promise<MenuSummary[]> {
  return q<MenuSummary>(
    `select m.id, m.name, m.active, m.weeks, m.period,
            (select count(*)::int from institutions i where i.menu_id = m.id) as institutions,
            (select max(s.week_start)::text from menu_week_starts s where s.menu_id = m.id) as "lastWeek"
     from menus m order by m.active desc, m.name`,
  );
}

export type MenuDetails = { id: number; name: string; active: boolean; weeks: number; period: string | null; approvedBy: string | null; approvedOn: string | null; notes: string | null; sourceFile: string | null; uploadWarnings: string | null };

export async function getMenu(q: Q, id: number): Promise<MenuDetails | null> {
  const [m] = await q<MenuDetails>(`select id, name, active, weeks, period, approved_by as "approvedBy", approved_on::text as "approvedOn", notes, source_file as "sourceFile", upload_warnings as "uploadWarnings" from menus where id = $1`, [id]);
  return m ?? null;
}

function cleanName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (n.length < 2) throw new MenuError("יש לתת לתפריט שם.");
  if (n.length > 120) throw new MenuError("שם התפריט ארוך מדי (עד 120 תווים).");
  return n;
}

export async function createMenu(q: Q, name: string, userId: string, weeks = 4): Promise<number> {
  const n = cleanName(name);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 8) throw new MenuError("מספר השבועות במחזור הוא בין 1 ל-8.");
  const [taken] = await q("select 1 from menus where name = $1", [n]);
  if (taken) throw new MenuError("כבר קיים תפריט בשם הזה.");
  const [m] = await q<{ id: number }>("insert into menus (name, weeks) values ($1, $2) returning id", [n, weeks]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'create', 'menu', $2, $3)", [userId, String(m.id), JSON.stringify({ name: n, weeks })]);
  return m.id;
}

export type MenuEdit = { name: string; active: boolean; period: string | null; approvedBy: string | null; approvedOn: string | null; notes: string | null };

/** Updates a menu's details. A menu that institutions follow cannot be switched off. */
export async function updateMenu(q: Q, id: number, edit: MenuEdit, userId: string): Promise<void> {
  const [before] = await q<MenuEdit>(`select name, active, period, approved_by as "approvedBy", approved_on::text as "approvedOn", notes from menus where id = $1 for update`, [id]);
  if (!before) throw new MenuError("התפריט לא נמצא.");
  const after: MenuEdit = { name: cleanName(edit.name), active: edit.active, period: edit.period?.trim() || null, approvedBy: edit.approvedBy?.trim() || null, approvedOn: edit.approvedOn || null, notes: edit.notes?.replace(/\r/g, "").trim() || null };
  if (after.approvedOn && !isDay(after.approvedOn)) throw new MenuError("תאריך האישור אינו תקין.");
  if ((after.notes?.length ?? 0) > 8000) throw new MenuError("ההערות ארוכות מדי (עד 8,000 תווים).");
  if (after.name !== before.name) {
    const [taken] = await q("select 1 from menus where name = $1 and id <> $2", [after.name, id]);
    if (taken) throw new MenuError("כבר קיים תפריט בשם הזה.");
  }
  if (!after.active && before.active) {
    const [{ n: used }] = await q<{ n: number }>("select count(*)::int as n from institutions where menu_id = $1", [id]);
    if (used > 0) throw new MenuError(`אי אפשר להשבית תפריט ש-${used} מוסדות משויכים אליו. קודם מעבירים אותם לתפריט אחר.`);
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await q("update menus set name = $2, active = $3, period = $4, approved_by = $5, approved_on = $6::date, notes = $7 where id = $1", [id, after.name, after.active, after.period, after.approvedBy, after.approvedOn, after.notes]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'update', 'menu', $2, $3, $4)", [userId, String(id), JSON.stringify(before), JSON.stringify(after)]);
}

/** A person looked at what the upload was unsure about. */
export async function clearUploadWarnings(q: Q, id: number, userId: string): Promise<void> {
  const [m] = await q<{ w: string | null }>("select upload_warnings as w from menus where id = $1 for update", [id]);
  if (!m) throw new MenuError("התפריט לא נמצא.");
  if (m.w === null) return;
  await q("update menus set upload_warnings = null where id = $1", [id]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before) values ($1, 'menu_warnings_checked', 'menu', $2, $3)", [userId, String(id), JSON.stringify({ warnings: m.w })]);
}

/** Says which menu an institution follows; null takes it off any menu. */
export async function setInstitutionMenu(q: Q, institutionId: number, menuId: number | null, userId: string): Promise<void> {
  const [before] = await q<{ menu_id: number | null }>("select menu_id from institutions where id = $1 for update", [institutionId]);
  if (!before) throw new MenuError("המוסד לא נמצא.");
  if (menuId !== null) {
    const [m] = await q<{ active: boolean }>("select active from menus where id = $1", [menuId]);
    if (!m) throw new MenuError("התפריט לא נמצא.");
    if (!m.active && before.menu_id !== menuId) throw new MenuError("התפריט הזה מושבת.");
  }
  if (before.menu_id === menuId) return;
  await q("update institutions set menu_id = $2 where id = $1", [institutionId, menuId]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'institution_menu', 'institution', $2, $3, $4)", [userId, String(institutionId), JSON.stringify(before), JSON.stringify({ menu_id: menuId })]);
}

// ---------- the cells of the cycle

export type CellInput = { category: string; text: string; sku?: string | null };
export type DayCells = { note: string | null; cells: Partial<Record<CellCategory, { text: string; sku: string | null }>> };
export type MenuWeek = { weekNo: number; starts: string[]; days: DayCells[] };

async function writeDay(q: Q, menuId: number, weekNo: number, weekday: number, note: string | null, cells: CellInput[]): Promise<number> {
  const clean = new Map<string, { text: string; sku: string | null }>();
  for (const c of cells) {
    if (!CATEGORY_KEYS.includes(c.category)) throw new MenuError("קטגוריית התפריט אינה מוכרת.");
    const text = tidy(c.text.replace(/\r/g, ""));
    if (!text) continue;
    if (text.length > 600) throw new MenuError("הטקסט בתא ארוך מדי (עד 600 תווים).");
    const sku = SKU_CATEGORIES.includes(c.category) ? c.sku?.replace(/\s+/g, " ").trim() || null : null;
    if ((sku?.length ?? 0) > 80) throw new MenuError("המק״ט בתא ארוך מדי (עד 80 תווים).");
    clean.set(c.category, { text, sku });
  }
  const n = note ? tidy(note.replace(/\s+/g, " ")) : "";
  if (n.length > 200) throw new MenuError("הערת היום ארוכה מדי (עד 200 תווים).");
  if (n) clean.set("day_note", { text: n, sku: null });
  await q("delete from menu_cells where menu_id = $1 and week_no = $2 and weekday = $3", [menuId, weekNo, weekday]);
  for (const [category, c] of clean) await q("insert into menu_cells (menu_id, week_no, weekday, category, text, sku) values ($1, $2, $3, $4, $5, $6)", [menuId, weekNo, weekday, category, c.text, c.sku]);
  return clean.size;
}

/** Replaces what one weekday of one week of the cycle serves. Empty texts clear their cells. */
export async function setMenuDay(q: Q, menuId: number, weekNo: number, weekday: number, note: string | null, cells: CellInput[], userId: string): Promise<void> {
  const [m] = await q<{ weeks: number }>("select weeks from menus where id = $1 for update", [menuId]);
  if (!m) throw new MenuError("התפריט לא נמצא.");
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > m.weeks) throw new MenuError("השבוע אינו חלק ממחזור התפריט.");
  if (!Number.isInteger(weekday) || weekday < 0 || weekday >= WEEKDAYS.length) throw new MenuError("היום אינו תקין.");
  const read = () => q<{ category: string; text: string; sku: string | null }>("select category, text, sku from menu_cells where menu_id = $1 and week_no = $2 and weekday = $3 order by category", [menuId, weekNo, weekday]);
  const before = await read();
  await writeDay(q, menuId, weekNo, weekday, note, cells);
  const after = await read();
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'menu_day', 'menu', $2, $3, $4)", [userId, String(menuId), JSON.stringify({ weekNo, weekday, cells: before }), JSON.stringify({ weekNo, weekday, cells: after })]);
}

/**
 * Says which calendar weeks are a given week of the cycle. Every date is taken as its week's Sunday.
 * A calendar week that was another week of the cycle moves to this one.
 */
export async function setWeekStarts(q: Q, menuId: number, weekNo: number, days: string[], userId: string): Promise<string[]> {
  const [m] = await q<{ weeks: number }>("select weeks from menus where id = $1 for update", [menuId]);
  if (!m) throw new MenuError("התפריט לא נמצא.");
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > m.weeks) throw new MenuError("השבוע אינו חלק ממחזור התפריט.");
  for (const d of days) if (!isDay(d)) throw new MenuError(`התאריך אינו תקין: ${d}`);
  const starts = [...new Set(days.map(sundayOf))].sort();
  if (starts.length > 60) throw new MenuError("יותר מדי שבועות (עד 60).");
  const read = async () => (await q<{ s: string; week_no: number }>("select week_start::text as s, week_no from menu_week_starts where menu_id = $1 order by week_start", [menuId])).map((r) => `${r.s}=${r.week_no}`);
  const before = await read();
  await q("delete from menu_week_starts where menu_id = $1 and (week_no = $2 or week_start = any($3::date[]))", [menuId, weekNo, starts]);
  for (const s of starts) await q("insert into menu_week_starts (menu_id, week_start, week_no) values ($1, $2::date, $3)", [menuId, s, weekNo]);
  const after = await read();
  if (JSON.stringify(before) !== JSON.stringify(after)) await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'menu_weeks', 'menu', $2, $3, $4)", [userId, String(menuId), JSON.stringify(before), JSON.stringify(after)]);
  return starts;
}

/** Continues the cycle: gives the weeks after the last dated one their turn, up to a date (inclusive). Returns how many weeks were added. */
export async function extendCycle(q: Q, menuId: number, until: string, userId: string): Promise<number> {
  if (!isDay(until)) throw new MenuError("התאריך אינו תקין.");
  const [m] = await q<{ weeks: number }>("select weeks from menus where id = $1 for update", [menuId]);
  if (!m) throw new MenuError("התפריט לא נמצא.");
  const [last] = await q<{ s: string; week_no: number }>("select week_start::text as s, week_no from menu_week_starts where menu_id = $1 order by week_start desc limit 1", [menuId]);
  if (!last) throw new MenuError("לתפריט עוד אין שבוע עם תאריך. קודם קובעים תאריך לשבוע אחד לפחות.");
  const end = sundayOf(until);
  let added = 0, weekNo = last.week_no;
  const d = new Date(`${last.s}T00:00:00Z`);
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 7);
    const s = d.toISOString().slice(0, 10);
    if (s > end) break;
    if (++added > 60) throw new MenuError("אפשר להמשיך את המחזור עד 60 שבועות בכל פעם.");
    weekNo = (weekNo % m.weeks) + 1;
    await q("insert into menu_week_starts (menu_id, week_start, week_no) values ($1, $2::date, $3)", [menuId, s, weekNo]);
  }
  if (added > 0) await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'menu_extend', 'menu', $2, $3)", [userId, String(menuId), JSON.stringify({ from: last.s, until: end, added })]);
  return added;
}

/** The whole cycle of a menu: every week with its dates and its days. */
export async function menuWeeks(q: Q, menuId: number): Promise<MenuWeek[]> {
  const [m] = await q<{ weeks: number }>("select weeks from menus where id = $1", [menuId]);
  if (!m) return [];
  const weeks: MenuWeek[] = Array.from({ length: m.weeks }, (_, i) => ({ weekNo: i + 1, starts: [], days: WEEKDAYS.map(() => ({ note: null, cells: {} })) }));
  for (const s of await q<{ s: string; week_no: number }>("select week_start::text as s, week_no from menu_week_starts where menu_id = $1 order by week_start", [menuId])) weeks[s.week_no - 1]?.starts.push(s.s);
  for (const c of await q<{ week_no: number; weekday: number; category: string; text: string; sku: string | null }>("select week_no, weekday, category, text, sku from menu_cells where menu_id = $1", [menuId])) {
    const day = weeks[c.week_no - 1]?.days[c.weekday];
    if (!day) continue;
    if (c.category === "day_note") day.note = c.text;
    else day.cells[c.category as CellCategory] = { text: c.text, sku: c.sku };
  }
  return weeks;
}

/** Builds a menu from an uploaded document. The name must be free; nothing is written if anything fails. */
export async function saveParsedMenu(q: Q, parsed: ParsedMenu, name: string, fileName: string, userId: string): Promise<number> {
  const weeks = Math.max(...parsed.weeks.map((w) => w.weekNo));
  if (weeks > 8) throw new MenuError("בקובץ יותר מ-8 שבועות.");
  const id = await createMenu(q, name, userId, weeks);
  await q("update menus set period = $2, approved_by = $3, approved_on = $4::date, notes = $5, source_file = $6, upload_warnings = $7 where id = $1", [id, parsed.period, parsed.approvedBy, parsed.approvedOn, parsed.notes?.slice(0, 8000) ?? null, fileName.slice(0, 200), parsed.warnings.length > 0 ? parsed.warnings.join("\n").slice(0, 4000) : null]);
  const taken = new Set<string>();
  for (const w of parsed.weeks) {
    for (const s of w.starts) {
      if (taken.has(s)) continue; // the same calendar week under two weeks of the cycle: the first one keeps it, and the upload warns
      taken.add(s);
      await q("insert into menu_week_starts (menu_id, week_start, week_no) values ($1, $2::date, $3)", [id, s, w.weekNo]);
    }
    for (const d of w.days) await writeDay(q, id, w.weekNo, d.weekday, d.note, d.cells);
  }
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'menu_upload', 'menu', $2, $3)", [userId, String(id), JSON.stringify({ file: fileName, weeks, warnings: parsed.warnings })]);
  return id;
}

// ---------- the kitchen's day report

export type Plate = { diet: Diet; label: string; parts: { category: CellCategory; text: string; sku: string | null }[]; portions: number; byAge: Record<AgeGroup | "unknown", number> };
export type MenuDayReport = {
  day: string;
  weekday: number;
  /** true when Milgam's daily order was loaded for the day; otherwise the numbers are the forecast. */
  ordered: boolean;
  menus: {
    menuId: number | null;
    menu: string | null;
    /** The week of the cycle the day falls in; null when the menu has no week for this date. */
    weekNo: number | null;
    note: string | null;
    institutions: number;
    portions: number;
    meals: { mealType: string; quantity: number }[];
    plates: Plate[];
    /** What goes with every plate: fresh vegetable, fruit, bread, other. */
    extras: { category: CellCategory; text: string }[];
  }[];
  total: number;
};

// What each diet's plate is made of. A vegetarian plate swaps only the main dish; an allergen-free meal is a whole different meal.
const PLATE_PARTS: Record<Diet, CellCategory[]> = { regular: ["main", "grain", "hot_side"], vegetarian: ["vegetarian", "grain", "hot_side"], allergen_free: ["allergen_free"] };

/**
 * For one day: what every menu serves (by its week of the cycle) and how many portions, split by diet and age group.
 * Institutions that follow no menu are gathered under a row with no menu, so nothing is left out of the total.
 */
export async function menuDayReport(q: Q, day: string): Promise<MenuDayReport> {
  if (!isDay(day)) throw new MenuError("התאריך אינו תקין.");
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const [o] = await q("select 1 from milgam_order_days where day = $1::date", [day]);
  const ordered = !!o;
  const col = ordered ? "mq.ordered_qty" : "mq.forecast_qty";
  const rows = await q<{ menu_id: number | null; menu: string | null; institution_id: number; meal_type: string; age_group: AgeGroup | null; diet: Diet; qty: number }>(
    `select i.menu_id, m.name as menu, i.id as institution_id, mt.name as meal_type, mt.age_group, mt.diet, sum(${col})::int as qty
     from milgam_quantities mq join institution_groups g on g.id = mq.group_id join institutions i on i.id = g.institution_id
          join meal_types mt on mt.id = mq.meal_type_id left join menus m on m.id = i.menu_id
     where mq.day = $1::date and ${col} is not null
     group by i.menu_id, m.name, i.id, mt.name, mt.age_group, mt.diet order by m.name nulls last, mt.name`,
    [day],
  );
  const cells = await q<{ menu_id: number; week_no: number; category: string; text: string; sku: string | null }>(
    `select c.menu_id, c.week_no, c.category, c.text, c.sku from menu_week_starts s join menu_cells c on c.menu_id = s.menu_id and c.week_no = s.week_no
     where s.week_start = $1::date and c.weekday = $2`,
    [sundayOf(day), weekday],
  );
  const weekOf = new Map((await q<{ menu_id: number; week_no: number }>("select menu_id, week_no from menu_week_starts where week_start = $1::date", [sundayOf(day)])).map((r) => [r.menu_id, r.week_no]));

  type Bucket = { menu: string | null; institutions: Set<number>; meals: Map<string, number>; byDiet: Map<Diet, Record<AgeGroup | "unknown", number>> };
  const byMenu = new Map<number | null, Bucket>();
  for (const r of rows) {
    if (!byMenu.has(r.menu_id)) byMenu.set(r.menu_id, { menu: r.menu, institutions: new Set(), meals: new Map(), byDiet: new Map() });
    const b = byMenu.get(r.menu_id)!;
    b.institutions.add(r.institution_id);
    b.meals.set(r.meal_type, (b.meals.get(r.meal_type) ?? 0) + r.qty);
    if (!b.byDiet.has(r.diet)) b.byDiet.set(r.diet, { gan: 0, ab: 0, gv: 0, high: 0, unknown: 0 });
    b.byDiet.get(r.diet)![r.age_group ?? "unknown"] += r.qty;
  }
  const menus = [...byMenu.entries()].map(([menuId, b]) => {
    const mine = menuId === null ? [] : cells.filter((c) => c.menu_id === menuId);
    const cell = (category: string) => mine.find((c) => c.category === category);
    const plates: Plate[] = DIETS.filter((d) => b.byDiet.has(d.key)).map((d) => {
      const byAge = b.byDiet.get(d.key)!;
      const parts = PLATE_PARTS[d.key].flatMap((category) => {
        const c = cell(category);
        return c ? [{ category, text: c.text, sku: c.sku }] : [];
      });
      return { diet: d.key, label: d.label, parts, portions: Object.values(byAge).reduce((a, n) => a + n, 0), byAge };
    });
    const extras = (["vegetable", "fruit", "bread", "other"] as CellCategory[]).flatMap((category) => {
      const c = cell(category);
      return c ? [{ category, text: c.text }] : [];
    });
    const meals = [...b.meals.entries()].map(([mealType, quantity]) => ({ mealType, quantity }));
    return { menuId, menu: b.menu, weekNo: menuId === null ? null : (weekOf.get(menuId) ?? null), note: cell("day_note")?.text ?? null, institutions: b.institutions.size, portions: meals.reduce((a, m) => a + m.quantity, 0), meals, plates, extras };
  });
  return { day, weekday, ordered, menus, total: menus.reduce((a, m) => a + m.portions, 0) };
}
