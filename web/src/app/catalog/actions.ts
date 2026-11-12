"use server";

import { refresh } from "next/cache";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { addVariant, CatalogError, setVariantActive, updateProductOps } from "@/lib/catalog-core";

export type CatalogState = { error?: string; ok?: string };
const message = (e: unknown) => (e instanceof CatalogError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function updateOpsAction(_prev: CatalogState, fd: FormData): Promise<CatalogState> {
  const user = await assertPermission("catalog.edit");
  const dept = s(fd, "department_id");
  try {
    await withTransaction((q) =>
      updateProductOps(q, s(fd, "sku"), { orderable: fd.get("orderable") === "on", departmentId: dept === "" ? null : Number(dept), defaultShift: Number(s(fd, "default_shift")) }, user.id),
    );
    refresh();
    return { ok: "הפרטים נשמרו." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function addVariantAction(_prev: CatalogState, fd: FormData): Promise<CatalogState> {
  const user = await assertPermission("catalog.edit");
  try {
    await withTransaction((q) => addVariant(q, s(fd, "sku"), s(fd, "name"), user.id));
    refresh();
    return { ok: "הסוג נוסף. מעכשיו חובה לבחור סוג בכל שורה חדשה של המוצר." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function toggleVariantAction(fd: FormData): Promise<void> {
  const user = await assertPermission("catalog.edit");
  try {
    await withTransaction((q) => setVariantActive(q, s(fd, "sku"), Number(s(fd, "variant_id")), s(fd, "active") === "true", user.id));
  } catch {
    // The variant no longer exists; the refreshed screen shows the current list.
  }
  refresh();
}
