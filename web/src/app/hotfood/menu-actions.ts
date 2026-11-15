"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { buildMenu, CELL_CATEGORIES, MenuParseError } from "@/lib/menu-parse-core";
import { PdfReadError, readPdfPages } from "@/lib/menu-pdf";
import { clearUploadWarnings, createMenu, extendCycle, MenuError, saveParsedMenu, setInstitutionMenu, setMealTypeGroup, setMenuDay, setWeekStarts, updateMenu } from "@/lib/menu-core";
import { createDish, DishError, updateDish, type DishInput } from "@/lib/dish-core";
import { CookError, setPhraseDish } from "@/lib/menu-cook-core";

export type MenuState = { error?: string; ok?: string };
const known = (e: unknown) => e instanceof MenuError || e instanceof MenuParseError || e instanceof PdfReadError || e instanceof DishError || e instanceof CookError;
function message(where: string, e: unknown): string {
  if (known(e)) return (e as Error).message;
  console.error(`[${where}]`, e);
  return "הפעולה נכשלה. שום דבר לא נשמר.";
}
const id = (fd: FormData, key: string) => {
  const v = String(fd.get(key) ?? "");
  return /^\d{1,9}$/.test(v) ? Number(v) : null;
};
const text = (fd: FormData, key: string) => String(fd.get(key) ?? "");

/** Builds a menu from the approved menu document (PDF): a table per week of the cycle. */
export async function uploadMenuAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "יש לבחור קובץ PDF של התפריט." };
  if (file.size > 1.5 * 1024 * 1024) return { error: "הקובץ גדול מדי (עד 1.5MB)." };
  let menuId: number;
  try {
    const parsed = buildMenu(await readPdfPages(new Uint8Array(await file.arrayBuffer())));
    const name = text(fd, "name").trim() || [parsed.title, parsed.period].filter(Boolean).join(" · ") || file.name.replace(/\.pdf$/i, "");
    menuId = await withTransaction((q) => saveParsedMenu(q, parsed, name, file.name, user.id));
  } catch (e) {
    return { error: message("menu upload", e) };
  }
  redirect(`/hotfood/menus/${menuId}`);
}

export async function createMenuAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const weeks = id(fd, "weeks") ?? 4;
  let menuId: number;
  try {
    menuId = await withTransaction((q) => createMenu(q, text(fd, "name"), user.id, weeks));
  } catch (e) {
    return { error: message("menu create", e) };
  }
  redirect(`/hotfood/menus/${menuId}`);
}

export async function updateMenuAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const menuId = id(fd, "menu_id");
  if (menuId === null) return { error: "התפריט לא נמצא." };
  try {
    await withTransaction((q) => updateMenu(q, menuId, { name: text(fd, "name"), active: fd.get("active") === "on", period: text(fd, "period"), approvedBy: text(fd, "approved_by"), approvedOn: text(fd, "approved_on") || null, notes: text(fd, "notes") }, user.id));
    refresh();
    return { ok: "נשמר." };
  } catch (e) {
    return { error: message("menu update", e) };
  }
}

export async function clearWarningsAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const menuId = id(fd, "menu_id");
  if (menuId === null) return { error: "התפריט לא נמצא." };
  try {
    await withTransaction((q) => clearUploadWarnings(q, menuId, user.id));
    refresh();
    return {};
  } catch (e) {
    return { error: message("menu warnings", e) };
  }
}

/** Saves what one weekday of one week of the cycle serves. */
export async function menuDayAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const menuId = id(fd, "menu_id"), week = id(fd, "week"), weekday = id(fd, "weekday");
  if (menuId === null || week === null || weekday === null) return { error: "התפריט לא נמצא." };
  const cells = CELL_CATEGORIES.map((c) => ({ category: c.key, text: text(fd, `text_${c.key}`), sku: text(fd, `sku_${c.key}`) }));
  try {
    await withTransaction((q) => setMenuDay(q, menuId, week, weekday, text(fd, "note"), cells, user.id));
  } catch (e) {
    return { error: message("menu day", e) };
  }
  redirect(`/hotfood/menus/${menuId}?week=${week}`);
}

/** dd/mm/yyyy or yyyy-mm-dd, separated by commas, spaces or new lines. */
function parseDates(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[\s,;]+/).filter(Boolean)) {
    const il = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(piece);
    if (il) out.push(`${il[3]}-${il[2].padStart(2, "0")}-${il[1].padStart(2, "0")}`);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(piece)) out.push(piece);
    else throw new MenuError(`התאריך אינו תקין: ${piece}. כותבים יום/חודש/שנה, למשל 06/12/2026.`);
  }
  return out;
}

export async function weekStartsAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const menuId = id(fd, "menu_id"), week = id(fd, "week");
  if (menuId === null || week === null) return { error: "התפריט לא נמצא." };
  try {
    const starts = await withTransaction((q) => setWeekStarts(q, menuId, week, parseDates(text(fd, "dates")), user.id));
    refresh();
    return { ok: starts.length === 0 ? "לשבוע הזה אין עכשיו תאריכים." : `נשמרו ${starts.length} שבועות. כל תאריך נשמר כיום ראשון של השבוע שלו.` };
  } catch (e) {
    return { error: message("menu weeks", e) };
  }
}

export async function extendCycleAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const menuId = id(fd, "menu_id");
  if (menuId === null) return { error: "התפריט לא נמצא." };
  try {
    const added = await withTransaction((q) => extendCycle(q, menuId, text(fd, "until"), user.id));
    refresh();
    return { ok: added === 0 ? "המחזור כבר מגיע עד התאריך הזה." : `המחזור הומשך ב-${added} שבועות.` };
  } catch (e) {
    return { error: message("menu extend", e) };
  }
}

export async function institutionMenuAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const institutionId = id(fd, "institution_id");
  const raw = text(fd, "menu_id");
  if (institutionId === null || (raw !== "" && id(fd, "menu_id") === null)) return { error: "המוסד לא נמצא." };
  try {
    await withTransaction((q) => setInstitutionMenu(q, institutionId, raw === "" ? null : Number(raw), user.id));
    refresh();
    return { ok: "נשמר." };
  } catch (e) {
    return { error: message("institution menu", e) };
  }
}

export async function mealTypeGroupAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const mealTypeId = id(fd, "meal_type_id");
  if (mealTypeId === null) return { error: "סוג המנה לא נמצא." };
  try {
    await withTransaction((q) => setMealTypeGroup(q, mealTypeId, text(fd, "age_group") || null, text(fd, "diet"), user.id));
    refresh();
    return { ok: "נשמר." };
  } catch (e) {
    return { error: message("meal type group", e) };
  }
}

function dishInput(fd: FormData): DishInput {
  return { code: text(fd, "code"), category: text(fd, "category"), name: text(fd, "name"), weightGan: text(fd, "weight_gan"), weightAb: text(fd, "weight_ab"), weightGv: text(fd, "weight_gv"), weightHigh: text(fd, "weight_high"), kiloBoxWeight: text(fd, "kilo_box_weight"), rawRatio: text(fd, "raw_ratio"), routineBreaker: fd.get("routine_breaker") === "on", active: fd.get("active") === "on" };
}

/** Saves a dish of the dish table: a new one, or a change to an existing one. */
export async function dishAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const raw = text(fd, "dish_id");
  const dishId = id(fd, "dish_id");
  if (raw !== "" && dishId === null) return { error: "המנה לא נמצאה." };
  try {
    if (dishId === null) {
      await withTransaction((q) => createDish(q, dishInput(fd), user.id));
      refresh();
      return { ok: "המנה נוספה." };
    }
    const changed = await withTransaction((q) => updateDish(q, dishId, dishInput(fd), user.id));
    refresh();
    return { ok: changed ? "נשמר." : "לא היה מה לשנות." };
  } catch (e) {
    return { error: message("dish", e) };
  }
}

/** Ties what a menu cell says to a dish of the dish table, for every menu. An empty choice removes the tie. */
export async function phraseDishAction(_prev: MenuState, fd: FormData): Promise<MenuState> {
  const user = await assertPermission("hotfood.manage");
  const raw = text(fd, "dish_id");
  const dishId = id(fd, "dish_id");
  if (raw !== "" && dishId === null) return { error: "המנה לא נמצאה." };
  try {
    await withTransaction((q) => setPhraseDish(q, text(fd, "category"), text(fd, "phrase"), dishId, user.id));
    refresh();
    return { ok: "נשמר." };
  } catch (e) {
    return { error: message("menu phrase", e) };
  }
}
