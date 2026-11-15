// Hot food menus: named menus, the menu every institution follows, the dishes of every date by category,
// and the kitchen's day report (portions per menu and meal type, next to that day's dishes).
// No dependency on Next.js.
import type { Q } from "./auth-core.ts";

export class MenuError extends Error {}

export const MENU_CATEGORIES = [
  { key: "main", label: "עיקרית" },
  { key: "side", label: "תוספת" },
  { key: "vegetable", label: "ירק" },
  { key: "vegetarian", label: "צמחוני" },
  { key: "other", label: "אחר" },
] as const;
export type MenuCategory = (typeof MENU_CATEGORIES)[number]["key"];
const CATEGORY_KEYS: string[] = MENU_CATEGORIES.map((c) => c.key);
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export type MenuSummary = { id: number; name: string; active: boolean; institutions: number; lastDay: string | null };

export async function listMenus(q: Q): Promise<MenuSummary[]> {
  return q<MenuSummary>(
    `select m.id, m.name, m.active,
            (select count(*)::int from institutions i where i.menu_id = m.id) as institutions,
            (select max(d.day)::text from menu_dishes d where d.menu_id = m.id) as "lastDay"
     from menus m order by m.active desc, m.name`,
  );
}

export async function getMenu(q: Q, id: number): Promise<{ id: number; name: string; active: boolean } | null> {
  const [m] = await q<{ id: number; name: string; active: boolean }>("select id, name, active from menus where id = $1", [id]);
  return m ?? null;
}

function cleanName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (n.length < 2) throw new MenuError("יש לתת לתפריט שם.");
  if (n.length > 60) throw new MenuError("שם התפריט ארוך מדי (עד 60 תווים).");
  return n;
}

export async function createMenu(q: Q, name: string, userId: string): Promise<number> {
  const n = cleanName(name);
  const [taken] = await q("select 1 from menus where name = $1", [n]);
  if (taken) throw new MenuError("כבר קיים תפריט בשם הזה.");
  const [m] = await q<{ id: number }>("insert into menus (name) values ($1) returning id", [n]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'create', 'menu', $2, $3)", [userId, String(m.id), JSON.stringify({ name: n })]);
  return m.id;
}

/** Renames a menu and switches it on or off. A menu that institutions follow cannot be switched off. */
export async function updateMenu(q: Q, id: number, name: string, active: boolean, userId: string): Promise<void> {
  const [before] = await q<{ name: string; active: boolean }>("select name, active from menus where id = $1 for update", [id]);
  if (!before) throw new MenuError("התפריט לא נמצא.");
  const n = cleanName(name);
  if (n !== before.name) {
    const [taken] = await q("select 1 from menus where name = $1 and id <> $2", [n, id]);
    if (taken) throw new MenuError("כבר קיים תפריט בשם הזה.");
  }
  if (!active && before.active) {
    const [{ n: used }] = await q<{ n: number }>("select count(*)::int as n from institutions where menu_id = $1", [id]);
    if (used > 0) throw new MenuError(`אי אפשר להשבית תפריט ש-${used} מוסדות משויכים אליו. קודם מעבירים אותם לתפריט אחר.`);
  }
  if (n === before.name && active === before.active) return;
  await q("update menus set name = $2, active = $3 where id = $1", [id, n, active]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'update', 'menu', $2, $3, $4)", [userId, String(id), JSON.stringify(before), JSON.stringify({ name: n, active })]);
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

// ---------- the dishes of a day

export type DishInput = { category: string; name: string };
export type DayDishes = Record<MenuCategory, string[]>;
const emptyDay = (): DayDishes => ({ main: [], side: [], vegetable: [], vegetarian: [], other: [] });

/** Splits what a person typed into dishes: one per line, or separated by commas. */
export function splitDishes(text: string): string[] {
  return [...new Set(text.split(/[\n,;]/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

/** Replaces the dishes of one menu on one date. An empty list clears the date. Returns how many dishes are kept. */
export async function setMenuDay(q: Q, menuId: number, day: string, dishes: DishInput[], userId: string): Promise<number> {
  if (!isDay(day)) throw new MenuError("התאריך אינו תקין.");
  const [m] = await q("select 1 from menus where id = $1 for update", [menuId]);
  if (!m) throw new MenuError("התפריט לא נמצא.");
  const clean: DishInput[] = [];
  for (const d of dishes) {
    if (!CATEGORY_KEYS.includes(d.category)) throw new MenuError("קטגוריית המנה אינה מוכרת.");
    const name = d.name.replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (name.length > 80) throw new MenuError(`שם המנה ארוך מדי (עד 80 תווים): ${name.slice(0, 30)}…`);
    if (!clean.some((c) => c.category === d.category && c.name === name)) clean.push({ category: d.category, name });
  }
  const before = await q<{ category: string; name: string }>("select category, name from menu_dishes where menu_id = $1 and day = $2::date order by category, position, id", [menuId, day]);
  const same = before.length === clean.length && before.every((b) => clean.some((c) => c.category === b.category && c.name === b.name));
  if (same) return clean.length;
  await q("delete from menu_dishes where menu_id = $1 and day = $2::date", [menuId, day]);
  let position = 0;
  for (const d of clean) await q("insert into menu_dishes (menu_id, day, category, name, position) values ($1, $2::date, $3, $4, $5)", [menuId, day, d.category, d.name, position++]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'menu_day', 'menu', $2, $3, $4)", [userId, String(menuId), JSON.stringify({ day, dishes: before }), JSON.stringify({ day, dishes: clean })]);
  return clean.length;
}

/** Copies one date's dishes to another date of the same menu, replacing what was there. */
export async function copyMenuDay(q: Q, menuId: number, fromDay: string, toDay: string, userId: string): Promise<number> {
  if (!isDay(fromDay) || !isDay(toDay)) throw new MenuError("התאריך אינו תקין.");
  if (fromDay === toDay) throw new MenuError("יש לבחור תאריך אחר להעתקה.");
  const source = await q<DishInput>("select category, name from menu_dishes where menu_id = $1 and day = $2::date order by position, id", [menuId, fromDay]);
  if (source.length === 0) throw new MenuError("בתאריך המקור אין מנות להעתקה.");
  return setMenuDay(q, menuId, toDay, source, userId);
}

/** The dishes of a menu for a run of dates (inclusive), keyed by date. Dates without dishes are left out. */
export async function menuDays(q: Q, menuId: number, from: string, to: string): Promise<Record<string, DayDishes>> {
  const rows = await q<{ day: string; category: MenuCategory; name: string }>(
    "select day::text, category, name from menu_dishes where menu_id = $1 and day between $2::date and $3::date order by day, position, id",
    [menuId, from, to],
  );
  const out: Record<string, DayDishes> = {};
  for (const r of rows) (out[r.day] ??= emptyDay())[r.category].push(r.name);
  return out;
}

// ---------- the kitchen's day report

export type MenuDayReport = {
  day: string;
  /** true when Milgam's daily order was loaded for the day; otherwise the numbers are the forecast. */
  ordered: boolean;
  menus: { menuId: number | null; menu: string | null; institutions: number; portions: number; meals: { mealType: string; quantity: number }[]; dishes: DayDishes | null }[];
  total: number;
};

/**
 * For one day: how many portions every menu has to cook, split by meal type, next to that day's dishes.
 * Institutions that follow no menu are gathered under a row with no menu, so nothing is left out of the total.
 */
export async function menuDayReport(q: Q, day: string): Promise<MenuDayReport> {
  if (!isDay(day)) throw new MenuError("התאריך אינו תקין.");
  const [o] = await q("select 1 from milgam_order_days where day = $1::date", [day]);
  const ordered = !!o;
  const rows = await q<{ menu_id: number | null; menu: string | null; institution_id: number; meal_type: string; qty: number }>(
    `select i.menu_id, m.name as menu, i.id as institution_id, mt.name as meal_type, sum(${ordered ? "mq.ordered_qty" : "mq.forecast_qty"})::int as qty
     from milgam_quantities mq join institution_groups g on g.id = mq.group_id join institutions i on i.id = g.institution_id
          join meal_types mt on mt.id = mq.meal_type_id left join menus m on m.id = i.menu_id
     where mq.day = $1::date and ${ordered ? "mq.ordered_qty" : "mq.forecast_qty"} is not null
     group by i.menu_id, m.name, i.id, mt.name order by m.name nulls last, mt.name`,
    [day],
  );
  const dishRows = await q<{ menu_id: number; category: MenuCategory; name: string }>("select menu_id, category, name from menu_dishes where day = $1::date order by position, id", [day]);
  const dishes = new Map<number, DayDishes>();
  for (const d of dishRows) {
    if (!dishes.has(d.menu_id)) dishes.set(d.menu_id, emptyDay());
    dishes.get(d.menu_id)![d.category].push(d.name);
  }
  const byMenu = new Map<number | null, { menu: string | null; institutions: Set<number>; meals: Map<string, number> }>();
  for (const r of rows) {
    if (!byMenu.has(r.menu_id)) byMenu.set(r.menu_id, { menu: r.menu, institutions: new Set(), meals: new Map() });
    const b = byMenu.get(r.menu_id)!;
    b.institutions.add(r.institution_id);
    b.meals.set(r.meal_type, (b.meals.get(r.meal_type) ?? 0) + r.qty);
  }
  const menus = [...byMenu.entries()].map(([menuId, b]) => {
    const meals = [...b.meals.entries()].map(([mealType, quantity]) => ({ mealType, quantity }));
    return { menuId, menu: b.menu, institutions: b.institutions.size, portions: meals.reduce((a, m) => a + m.quantity, 0), meals, dishes: menuId === null ? null : (dishes.get(menuId) ?? null) };
  });
  return { day, ordered, menus, total: menus.reduce((a, m) => a + m.portions, 0) };
}
