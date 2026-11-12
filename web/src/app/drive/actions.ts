"use server";

import { refresh } from "next/cache";
import { query, withTransaction } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { depart, processDeliveryAction, recordRefusal, RefusedError, routeAccess, type Action } from "@/lib/loading-core";
import { ShippingError } from "@/lib/shipping-core";

type State = { error?: string; ok?: string };
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const ACTIONS: Action[] = ["load", "unload", "reverse_load", "reverse_unload"];

async function context(fd: FormData) {
  const user = await getCurrentUser();
  const dailyRouteId = s(fd, "daily_route_id");
  if (!user || !isUuid(dailyRouteId)) return null;
  const access = await routeAccess(query, user, dailyRouteId, (p) => can(user.role, p));
  return access.view ? { user, dailyRouteId, access } : null;
}

export async function deliveryAction(_prev: State, fd: FormData): Promise<State> {
  const ctx = await context(fd);
  if (!ctx) return { error: "אין הרשאה לקו הזה." };
  const action = s(fd, "action") as Action;
  const deliveryId = s(fd, "delivery_id");
  if (!ACTIONS.includes(action) || !isUuid(deliveryId)) return { error: "הפעולה אינה מוכרת." };
  // Reversing a mark is a manager's decision. Loading and handing over follow the role.
  const allowed = action === "load" ? ctx.access.load : action === "unload" ? ctx.access.unload : ctx.access.manage;
  if (!allowed) return { error: "אין הרשאה לפעולה הזו." };
  try {
    const result = await withTransaction((q) => processDeliveryAction(q, { deliveryId, dailyRouteId: ctx.dailyRouteId, action, userId: ctx.user.id, source: "manual" }));
    refresh();
    return result.changed ? {} : { error: result.message };
  } catch (e) {
    // The failed transaction was rolled back, so the refused attempt is recorded on its own.
    if (e instanceof RefusedError) await withTransaction((q) => recordRefusal(q, e, ctx.user.id, "manual")).catch(() => {});
    refresh();
    return { error: e instanceof ShippingError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר." };
  }
}

export async function departAction(_prev: State, fd: FormData): Promise<State> {
  const ctx = await context(fd);
  if (!ctx || !ctx.access.load) return { error: "אין הרשאה לקו הזה." };
  // Leaving without everything is decided by a manager only, whatever the form says.
  const withMissing = s(fd, "with_missing") === "yes";
  if (withMissing && !ctx.access.manage) return { error: "יציאה בלי כל האספקות דורשת אישור מנהל שילוח." };
  try {
    await withTransaction((q) => depart(q, ctx.dailyRouteId, ctx.user.id, { allowMissing: withMissing, reason: s(fd, "reason") }));
    refresh();
    return { ok: "הקו יצא להפצה. המסך עבר למצב פריקה." };
  } catch (e) {
    return { error: e instanceof ShippingError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר." };
  }
}
