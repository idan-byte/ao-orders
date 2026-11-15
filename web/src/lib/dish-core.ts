// The dish table: every dish of Milgam with its portion weight per age group. The numbers start from Milgam's
// own settings and can be changed here. No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { CELL_CATEGORIES } from "./menu-parse-core.ts";

export class DishError extends Error {}

export const DISH_CATEGORIES = CELL_CATEGORIES.map((c) => ({ key: c.key as string, label: c.key === "grain" ? "פחמימה" : c.key === "hot_side" ? "ירקני (תוספת חמה)" : c.key === "main" ? "עיקרי" : c.key === "vegetarian" ? "צמחוני" : c.key === "fruit" ? "פרי" : c.label }));

export type Dish = {
  id: number;
  code: number | null;
  category: string;
  name: string;
  weightGan: string | null;
  weightAb: string | null;
  weightGv: string | null;
  weightHigh: string | null;
  kiloBoxWeight: string | null;
  rawRatio: string | null;
  routineBreaker: boolean;
  active: boolean;
};

const COLUMNS = `id, code, category, name, weight_gan::float8::text as "weightGan", weight_ab::float8::text as "weightAb", weight_gv::float8::text as "weightGv", weight_high::float8::text as "weightHigh",
  kilo_box_weight::float8::text as "kiloBoxWeight", raw_ratio::float8::text as "rawRatio", routine_breaker as "routineBreaker", active`;

export type DishFilter = { search?: string; category?: string; breakerOnly?: boolean; limit?: number; offset?: number };

export async function listDishes(q: Q, f: DishFilter = {}): Promise<{ dishes: Dish[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.category) { params.push(f.category); where.push(`category = $${params.length}`); }
  if (f.breakerOnly) where.push("routine_breaker");
  const s = f.search?.trim();
  if (s) {
    params.push(`%${s.replace(/[%_\\]/g, "\\$&")}%`);
    where.push(`(name ilike $${params.length} or code::text like $${params.length})`);
  }
  const w = where.length > 0 ? `where ${where.join(" and ")}` : "";
  const [{ n }] = await q<{ n: number }>(`select count(*)::int as n from dishes ${w}`, params);
  const dishes = await q<Dish>(`select ${COLUMNS} from dishes ${w} order by active desc, array_position(array['main','grain','hot_side','vegetarian','allergen_free','vegetable','fruit','bread','other'], category), name, id limit ${Math.min(Math.max(f.limit ?? 50, 1), 500)} offset ${Math.max(f.offset ?? 0, 0)}`, params);
  return { dishes, total: n };
}

export async function getDish(q: Q, id: number): Promise<Dish | null> {
  const [d] = await q<Dish>(`select ${COLUMNS} from dishes where id = $1`, [id]);
  return d ?? null;
}

export type DishInput = { code: string; category: string; name: string; weightGan: string; weightAb: string; weightGv: string; weightHigh: string; kiloBoxWeight: string; rawRatio: string; routineBreaker: boolean; active: boolean };

function number(label: string, v: string, max: number): number | null {
  const t = v.trim().replace(",", ".");
  if (t === "") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) throw new DishError(`${label}: יש להקליד מספר.`);
  const n = Number(t);
  if (n > max) throw new DishError(`${label}: המספר גדול מדי (עד ${max}).`);
  return n;
}

function clean(input: DishInput) {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) throw new DishError("יש לתת למנה שם.");
  if (name.length > 120) throw new DishError("שם המנה ארוך מדי (עד 120 תווים).");
  if (!DISH_CATEGORIES.some((c) => c.key === input.category)) throw new DishError("הקטגוריה אינה מוכרת.");
  const code = input.code.trim();
  if (code !== "" && !/^\d{1,9}$/.test(code)) throw new DishError("קוד המנה הוא מספר.");
  return {
    code: code === "" ? null : Number(code),
    category: input.category,
    name,
    weight_gan: number("משקל גן", input.weightGan, 99),
    weight_ab: number("משקל א-ב", input.weightAb, 99),
    weight_gv: number("משקל ג-ו", input.weightGv, 99),
    weight_high: number("משקל על יסודי", input.weightHigh, 99),
    kilo_box_weight: number("משקל בקופסת קילו", input.kiloBoxWeight, 999),
    raw_ratio: number("יחס חומר גולמי", input.rawRatio, 1000),
    routine_breaker: input.routineBreaker,
    active: input.active,
  };
}

const FIELDS = ["code", "category", "name", "weight_gan", "weight_ab", "weight_gv", "weight_high", "kilo_box_weight", "raw_ratio", "routine_breaker", "active"] as const;

export async function createDish(q: Q, input: DishInput, userId: string): Promise<number> {
  const c = clean(input);
  if (c.code !== null) {
    const [taken] = await q("select 1 from dishes where code = $1", [c.code]);
    if (taken) throw new DishError("כבר קיימת מנה עם הקוד הזה.");
  }
  const [d] = await q<{ id: number }>(`insert into dishes (${FIELDS.join(", ")}) values (${FIELDS.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, FIELDS.map((f) => c[f]));
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'create', 'dish', $2, $3)", [userId, String(d.id), JSON.stringify(c)]);
  return d.id;
}

export async function updateDish(q: Q, id: number, input: DishInput, userId: string): Promise<boolean> {
  const [row] = await q<Record<string, unknown>>(`select code, category, name, weight_gan::float8, weight_ab::float8, weight_gv::float8, weight_high::float8, kilo_box_weight::float8, raw_ratio::float8, routine_breaker, active from dishes where id = $1 for update`, [id]);
  if (!row) throw new DishError("המנה לא נמצאה.");
  const c = clean(input);
  if (c.code !== null && c.code !== row.code) {
    const [taken] = await q("select 1 from dishes where code = $1 and id <> $2", [c.code, id]);
    if (taken) throw new DishError("כבר קיימת מנה עם הקוד הזה.");
  }
  const before = Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? null]));
  const changed = FIELDS.filter((f) => before[f] !== c[f]);
  if (changed.length === 0) return false;
  await q(`update dishes set ${FIELDS.map((f, i) => `${f} = $${i + 2}`).join(", ")} where id = $1`, [id, ...FIELDS.map((f) => c[f])]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'update', 'dish', $2, $3, $4)", [userId, String(id), JSON.stringify(Object.fromEntries(changed.map((f) => [f, before[f]]))), JSON.stringify(Object.fromEntries(changed.map((f) => [f, c[f]])))]);
  return true;
}
