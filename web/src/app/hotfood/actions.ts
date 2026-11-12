"use server";

import { refresh } from "next/cache";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { importMilgam, MilgamError, parseMilgam, setMealTypeSku } from "@/lib/milgam-core";
import { HotFoodError, linkInstitution, makeDeliveries } from "@/lib/hotfood-core";
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

export async function linkInstitutionAction(_prev: HotFoodState, fd: FormData): Promise<HotFoodState> {
  const user = await assertPermission("hotfood.manage");
  const id = String(fd.get("institution_id") ?? "");
  const customerId = String(fd.get("customer_id") ?? "");
  const addressId = String(fd.get("address_id") ?? "");
  const uuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
  if (!/^\d{1,9}$/.test(id) || (customerId !== "" && !uuid(customerId)) || (addressId !== "" && !uuid(addressId))) return { error: "המוסד לא נמצא." };
  try {
    await withTransaction((q) => linkInstitution(q, Number(id), customerId || null, addressId || null, user.id));
    refresh();
    return { ok: "נשמר." };
  } catch (e) {
    return { error: e instanceof HotFoodError ? e.message : message(e) };
  }
}

/** Makes (or updates) the deliveries of one day from Milgam's daily order. */
export async function makeDeliveriesAction(_prev: HotFoodState, fd: FormData): Promise<HotFoodState> {
  const user = await assertPermission("hotfood.manage");
  const day = String(fd.get("day") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "התאריך אינו תקין." };
  try {
    const r = await withTransaction((q) => makeDeliveries(q, day, user.id));
    refresh();
    const parts = [`נוצרו ${r.created} אספקות`, r.updated > 0 ? `עודכנו ${r.updated}` : null, r.unchanged > 0 ? `${r.unchanged} ללא שינוי` : null, r.blocked.length > 0 ? `${r.blocked.length} מוסדות עוד לא מוכנים` : null, r.frozen.length > 0 ? `${r.frozen.length} אספקות כבר בתנועה ולא עודכנו` : null];
    return { ok: parts.filter(Boolean).join(" · ") + "." };
  } catch (e) {
    if (!(e instanceof HotFoodError)) console.error("[milgam deliveries]", e);
    return { error: e instanceof HotFoodError ? e.message : message(e) };
  }
}
