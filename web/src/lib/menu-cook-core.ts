// From the menu to kilograms. A menu cell is text; its lines are read as items ("אורז לבן", "גנים: בורגול"),
// every item's phrase is tied to a dish of the dish table, and the dish's portion weight per age group times the
// day's portions gives what the kitchen has to cook. No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { AGE_GROUPS, menuDayReport, type AgeGroup, type Diet, type MenuDayReport } from "./menu-core.ts";
import { CELL_CATEGORIES, type CellCategory } from "./menu-parse-core.ts";

export class CookError extends Error {}

/** Who an item of a cell is for. 'other' is a condition the system cannot count by ("גוננים", "מעלה אדומים"). */
export type Scope = "all" | "gan" | "school" | "other";
export type CellItem = { scope: Scope; label: string | null; phrase: string };

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/[.,;]+$/, "").trim();

/**
 * Reads a cell's text as items. A line with a heading before a colon starts an item for that population
 * ("גנים: בורגול"); a line without one continues the item above it, because the document wraps long texts.
 */
export function cellItems(text: string): CellItem[] {
  const items: CellItem[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const head = /^([^:]{2,40}):\s*(.*)$/.exec(line);
    if (head) {
      const label = tidy(head[1]);
      const scope: Scope = /^גנים( בלבד)?$/.test(label) ? "gan" : /^בתי? ספר( בלבד)?$/.test(label) ? "school" : "other";
      items.push({ scope, label, phrase: tidy(head[2]) });
    } else if (items.length > 0) {
      const last = items[items.length - 1];
      last.phrase = tidy(`${last.phrase} ${line}`);
    } else items.push({ scope: "all", label: null, phrase: tidy(line) });
  }
  return items.filter((i) => i.phrase !== "");
}

// The categories whose cells are weighed, and the dish categories a phrase of each may be tied to.
export const COOK_CATEGORIES: Partial<Record<CellCategory, string[]>> = {
  main: ["main"],
  grain: ["grain"],
  hot_side: ["hot_side", "grain"],
  vegetarian: ["vegetarian", "main"],
  allergen_free: ["allergen_free"],
  vegetable: ["vegetable"],
  fruit: ["fruit"],
};
// Whose portions a category feeds. A vegetarian plate keeps the grain and the hot side; an allergen-free meal is its own.
const DIETS_OF: Partial<Record<CellCategory, Diet[]>> = {
  main: ["regular"],
  grain: ["regular", "vegetarian"],
  hot_side: ["regular", "vegetarian"],
  vegetarian: ["vegetarian"],
  allergen_free: ["allergen_free"],
  vegetable: ["regular", "vegetarian", "allergen_free"],
  fruit: ["regular", "vegetarian", "allergen_free"],
};
const AGES_OF: Record<Exclude<Scope, "other">, AgeGroup[]> = { all: ["gan", "ab", "gv", "high"], gan: ["gan"], school: ["ab", "gv", "high"] };

type DishRow = { id: number; code: number | null; category: string; name: string; gan: number | null; ab: number | null; gv: number | null; high: number | null; raw_ratio: number | null; active: boolean };
type Resolver = (category: CellCategory, phrase: string) => { dish: DishRow; how: "tied" | "name" } | null;

async function resolver(q: Q): Promise<Resolver> {
  const dishes = await q<DishRow>("select id, code, category, name, weight_gan::float8 as gan, weight_ab::float8 as ab, weight_gv::float8 as gv, weight_high::float8 as high, raw_ratio::float8 as raw_ratio, active from dishes");
  const byId = new Map(dishes.map((d) => [d.id, d]));
  const tied = new Map((await q<{ category: string; phrase: string; dish_id: number }>("select category, phrase, dish_id from menu_phrases")).map((r) => [`${r.category}\n${r.phrase}`, r.dish_id]));
  return (category, phrase) => {
    const id = tied.get(`${category}\n${phrase}`);
    if (id !== undefined) return byId.has(id) ? { dish: byId.get(id)!, how: "tied" } : null;
    // Without a tie: a phrase that is exactly the name of one active dish of the cell's own category.
    const same = dishes.filter((d) => d.active && d.category === category && tidy(d.name) === phrase);
    return same.length === 1 ? { dish: same[0], how: "name" } : null;
  };
}

// ---------- tying phrases to dishes

export type MenuPhrase = { category: CellCategory; phrase: string; cells: number; scopes: Scope[]; dishId: number | null; dish: string | null; code: number | null; how: "tied" | "name" | null; hasWeights: boolean };

/** Every distinct phrase of a menu's weighed cells, with the dish it is tied to, most used first within its category. */
export async function menuPhrases(q: Q, menuId: number): Promise<MenuPhrase[]> {
  const resolve = await resolver(q);
  const cells = await q<{ category: CellCategory; text: string }>("select category, text from menu_cells where menu_id = $1 and category = any($2)", [menuId, Object.keys(COOK_CATEGORIES)]);
  const found = new Map<string, MenuPhrase>();
  for (const c of cells) {
    for (const item of cellItems(c.text)) {
      const key = `${c.category}\n${item.phrase}`;
      if (!found.has(key)) {
        const r = resolve(c.category, item.phrase);
        found.set(key, { category: c.category, phrase: item.phrase, cells: 0, scopes: [], dishId: r?.dish.id ?? null, dish: r?.dish.name ?? null, code: r?.dish.code ?? null, how: r?.how ?? null, hasWeights: !!r && AGE_GROUPS.some((g) => r.dish[g.key] !== null) });
      }
      const p = found.get(key)!;
      p.cells++;
      if (!p.scopes.includes(item.scope)) p.scopes.push(item.scope);
    }
  }
  const order = CELL_CATEGORIES.map((c) => c.key as string);
  return [...found.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || b.cells - a.cells || a.phrase.localeCompare(b.phrase, "he"));
}

/** Ties a phrase of a category to a dish, for every menu; null removes the tie. */
export async function setPhraseDish(q: Q, category: string, phrase: string, dishId: number | null, userId: string): Promise<void> {
  const allowed = COOK_CATEGORIES[category as CellCategory];
  if (!allowed) throw new CookError("הקטגוריה הזאת אינה נשקלת.");
  const p = tidy(phrase);
  if (!p || p.length > 300) throw new CookError("הביטוי אינו תקין.");
  const [before] = await q<{ dish_id: number }>("select dish_id from menu_phrases where category = $1 and phrase = $2 for update", [category, p]);
  if (dishId === null) {
    if (!before) return;
    await q("delete from menu_phrases where category = $1 and phrase = $2", [category, p]);
  } else {
    const [dish] = await q<{ category: string }>("select category from dishes where id = $1", [dishId]);
    if (!dish) throw new CookError("המנה לא נמצאה בטבלת המנות.");
    if (!allowed.includes(dish.category)) throw new CookError("המנה שנבחרה שייכת לקטגוריה אחרת.");
    if (before?.dish_id === dishId) return;
    await q("insert into menu_phrases (category, phrase, dish_id) values ($1, $2, $3) on conflict (category, phrase) do update set dish_id = excluded.dish_id", [category, p, dishId]);
  }
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'menu_phrase', 'dish', $2, $3, $4)", [userId, String(dishId ?? before?.dish_id ?? ""), JSON.stringify({ category, phrase: p, dish_id: before?.dish_id ?? null }), JSON.stringify({ category, phrase: p, dish_id: dishId })]);
}

// ---------- the day's quantities

export type CookLine = {
  category: CellCategory;
  scope: Scope;
  label: string | null;
  phrase: string;
  dishId: number | null;
  dish: string | null;
  code: number | null;
  /** The portions this line feeds. */
  portions: number;
  /** Served weight in kilograms: portions times the dish's portion weight per age group. null when nothing could be weighed. */
  kg: number | null;
  /** Raw material in kilograms, by the dish's raw ratio (percent of the served weight). null when the dish has no ratio. */
  rawKg: number | null;
  /** Portions that were not weighed: their meal type has no age group, or the dish has no weight for it. */
  unweighed: number;
};
export type CookMenu = { menuId: number | null; menu: string | null; lines: CookLine[] };
export type CookTotal = { dishId: number; dish: string; code: number | null; category: string; portions: number; kg: number; rawKg: number | null };
export type DayCooking = { report: MenuDayReport; menus: CookMenu[]; totals: CookTotal[]; untied: number; unweighed: number };

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The day's report with what has to be cooked: kilograms per dish for every menu, and the totals over all menus. */
export async function dayCooking(q: Q, day: string): Promise<DayCooking> {
  const report = await menuDayReport(q, day);
  const resolve = await resolver(q);
  const totals = new Map<number, CookTotal>();
  let untied = 0, unweighed = 0;

  const menus: CookMenu[] = report.menus.map((m) => {
    const byDiet = new Map(m.plates.map((p) => [p.diet, p.byAge]));
    const cells = new Map<CellCategory, string>();
    for (const p of m.plates) for (const part of p.parts) cells.set(part.category, part.text);
    for (const e of m.extras) cells.set(e.category, e.text);
    const lines: CookLine[] = [];
    for (const { key: category } of CELL_CATEGORIES) {
      const diets = DIETS_OF[category];
      const text = cells.get(category);
      if (!diets || !text) continue;
      const qty = (age: AgeGroup | "unknown") => diets.reduce((a, d) => a + (byDiet.get(d)?.[age] ?? 0), 0);
      const items = cellItems(text);
      // An item for everyone gives way, per age group, to an item written for that population.
      const special = new Set(items.filter((i) => i.scope === "gan" || i.scope === "school").flatMap((i) => AGES_OF[i.scope as "gan" | "school"]));
      for (const item of items) {
        const r = resolve(category, item.phrase);
        const line: CookLine = { category, scope: item.scope, label: item.label, phrase: item.phrase, dishId: r?.dish.id ?? null, dish: r?.dish.name ?? null, code: r?.dish.code ?? null, portions: 0, kg: null, rawKg: null, unweighed: 0 };
        if (item.scope !== "other") {
          const ages = AGES_OF[item.scope].filter((a) => item.scope !== "all" || !special.has(a));
          const unknown = item.scope === "all" ? qty("unknown") : 0;
          line.portions = ages.reduce((a, age) => a + qty(age), 0) + unknown;
          if (r) {
            let kg = 0, weighed = 0;
            for (const age of ages) {
              const n = qty(age), w = r.dish[age];
              if (n === 0) continue;
              if (w === null) line.unweighed += n;
              else { kg += n * w; weighed += n; }
            }
            line.unweighed += unknown;
            if (weighed > 0) {
              line.kg = round(kg);
              line.rawKg = r.dish.raw_ratio && r.dish.raw_ratio > 0 ? round((kg * r.dish.raw_ratio) / 100) : null;
              const t = totals.get(r.dish.id) ?? { dishId: r.dish.id, dish: r.dish.name, code: r.dish.code, category: r.dish.category, portions: 0, kg: 0, rawKg: null };
              t.portions += weighed;
              t.kg = round(t.kg + kg);
              if (line.rawKg !== null) t.rawKg = round((t.rawKg ?? 0) + line.rawKg);
              totals.set(r.dish.id, t);
            }
            unweighed += line.unweighed;
          } else if (line.portions > 0) untied++;
        }
        lines.push(line);
      }
    }
    return { menuId: m.menuId, menu: m.menu, lines };
  });
  const order = CELL_CATEGORIES.map((c) => c.key as string);
  return { report, menus, totals: [...totals.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.dish.localeCompare(b.dish, "he")), untied, unweighed };
}
