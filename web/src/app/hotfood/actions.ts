"use server";

import { refresh } from "next/cache";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { importMilgam, MilgamError, parseMilgam, setMealTypeSku } from "@/lib/milgam-core";
import { readXlsx, XlsxError } from "@/lib/xlsx-read";

export type HotFoodState = { error?: string; ok?: string };
const message = (e: unknown) => (e instanceof MilgamError || e instanceof XlsxError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");
const nf = new Intl.NumberFormat("he-IL");

/** Loads a Milgam Excel file: the forecast or the daily order. Either the whole file is taken in or nothing is. */
export async function importMilgamAction(_prev: HotFoodState, fd: FormData): Promise<HotFoodState> {
  const user = await assertPermission("hotfood.manage");
  const kind = String(fd.get("kind") ?? "");
  const file = fd.get("file");
  if (kind !== "forecast" && kind !== "daily") return { error: "יש לבחור אם זה קובץ צפי או הזמנה יומית." };
  if (!(file instanceof File) || file.size === 0) return { error: "יש לבחור קובץ אקסל." };
  if (file.size > 1.5 * 1024 * 1024) return { error: "הקובץ גדול מדי (עד 1.5MB)." };
  try {
    const parsed = parseMilgam(readXlsx(new Uint8Array(await file.arrayBuffer())));
    const r = await withTransaction((q) => importMilgam(q, parsed, { kind, fileName: file.name, userId: user.id, addNew: fd.get("add_new") === "on" }));
    refresh();
    const skipped = r.held.length + r.problems.length;
    return { ok: `נקלטו ${nf.format(r.portions)} מנות ב-${r.days.length} ימים.${skipped > 0 ? ` ${skipped} שורות לא נקלטו ומחכות לבדיקה, ראו למטה.` : ""}` };
  } catch (e) {
    if (!(e instanceof MilgamError || e instanceof XlsxError)) console.error("[milgam import]", e);
    return { error: message(e) };
  }
}

export async function mealTypeSkuAction(_prev: HotFoodState, fd: FormData): Promise<HotFoodState> {
  const user = await assertPermission("hotfood.manage");
  const id = String(fd.get("meal_type_id") ?? "");
  const sku = String(fd.get("sku") ?? "").trim();
  if (!/^\d{1,9}$/.test(id)) return { error: "סוג המנה לא נמצא." };
  try {
    await withTransaction((q) => setMealTypeSku(q, Number(id), sku === "" ? null : sku, user.id));
    refresh();
    return { ok: "נשמר." };
  } catch (e) {
    return { error: message(e) };
  }
}
