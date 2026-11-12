"use server";

import { refresh } from "next/cache";
import { query, withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { resolveEvent } from "@/lib/alerts-core";
import { clearLocation, GeoError, pendingForRoute, recordSearch, setManualLocation } from "@/lib/geo-core";
import { geocoderEnabled, searchAddress } from "@/lib/geo";
import { assignDelivery, moveAddress, moveStop, planDay, saveDriver, saveRoute, setAddressRoute, setDailyDriver, setDriverActive, setRouteActive, ShippingError } from "@/lib/shipping-core";
import { setPackageCount } from "@/lib/loading-core";

export type ShippingState = { error?: string; ok?: string };
const message = (e: unknown) => (e instanceof ShippingError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const int = (fd: FormData, k: string) => (/^\d{1,9}$/.test(s(fd, k)) ? Number(s(fd, k)) : null);
const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export async function planDayAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  try {
    const r = await withTransaction((q) => planDay(q, s(fd, "date"), user.id));
    refresh();
    const parts = [r.assigned > 0 ? `שובצו ${r.assigned} אספקות.` : "לא היו אספקות חדשות לשבץ."];
    if (r.unassigned > 0) parts.push(`${r.unassigned} אספקות ממתינות לשיבוץ ידני.`);
    return { ok: parts.join(" ") };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function assignDeliveryAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  const deliveryId = s(fd, "delivery_id");
  if (!isUuid(deliveryId)) return { error: "האספקה לא נמצאה." };
  const routeId = int(fd, "route_id");
  if (routeId === null && s(fd, "route_id") !== "none") return { error: "יש לבחור קו." };
  try {
    await withTransaction((q) => assignDelivery(q, deliveryId, routeId, fd.get("permanent") === "on", user.id));
    refresh();
    return {};
  } catch (e) {
    return { error: message(e) };
  }
}

export async function moveStopAction(fd: FormData): Promise<void> {
  await assertPermission("shipping.manage");
  const dailyRouteId = s(fd, "daily_route_id");
  const stop = int(fd, "stop");
  if (isUuid(dailyRouteId) && stop !== null) await withTransaction((q) => moveStop(q, dailyRouteId, stop, s(fd, "direction") === "up" ? -1 : 1));
  refresh();
}

export async function dailyDriverAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  const dailyRouteId = s(fd, "daily_route_id");
  if (!isUuid(dailyRouteId)) return { error: "הקו היומי לא נמצא." };
  try {
    await withTransaction((q) => setDailyDriver(q, dailyRouteId, int(fd, "driver_id"), user.id));
    refresh();
    return { ok: "הנהג של היום עודכן." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function saveRouteAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  const id = int(fd, "route_id");
  try {
    await withTransaction((q) => saveRoute(q, id, { name: s(fd, "name"), description: s(fd, "description"), defaultDriverId: int(fd, "driver_id") }, user.id));
    refresh();
    return { ok: id === null ? "הקו נוסף." : "הקו נשמר." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function routeActiveAction(fd: FormData): Promise<void> {
  await assertPermission("shipping.manage");
  const id = int(fd, "route_id");
  if (id !== null) await withTransaction((q) => setRouteActive(q, id, s(fd, "active") === "true")).catch(() => {});
  refresh();
}

export async function addressRouteAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  const addressId = s(fd, "address_id");
  if (!isUuid(addressId)) return { error: "יש לבחור כתובת." };
  try {
    await withTransaction((q) => setAddressRoute(q, addressId, int(fd, "route_id"), user.id));
    refresh();
    return {};
  } catch (e) {
    return { error: message(e) };
  }
}

export async function addressCommandAction(fd: FormData): Promise<void> {
  const user = await assertPermission("shipping.manage");
  const addressId = s(fd, "address_id");
  const command = s(fd, "command");
  if (isUuid(addressId)) {
    await withTransaction(async (q) => {
      if (command === "up") await moveAddress(q, addressId, -1);
      else if (command === "down") await moveAddress(q, addressId, 1);
      else if (command === "remove") await setAddressRoute(q, addressId, null, user.id);
    }).catch(() => {});
  }
  refresh();
}

export async function saveDriverAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  const id = int(fd, "driver_id");
  try {
    await withTransaction((q) => saveDriver(q, id, { name: s(fd, "name"), phone: s(fd, "phone"), vehicleRegistration: s(fd, "registration"), vehicleDescription: s(fd, "vehicle_description") }, user.id));
    refresh();
    return { ok: id === null ? "הנהג נוסף." : "הפרטים נשמרו." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function driverActiveAction(fd: FormData): Promise<void> {
  await assertPermission("shipping.manage");
  const id = int(fd, "driver_id");
  if (id !== null) await withTransaction((q) => setDriverActive(q, id, s(fd, "active") === "true")).catch(() => {});
  refresh();
}

export async function resolveAlertAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  const eventId = int(fd, "event_id");
  if (eventId === null) return { error: "ההתראה לא נמצאה." };
  try {
    await withTransaction((q) => resolveEvent(q, eventId, user.id, s(fd, "note")));
    refresh();
    return {};
  } catch (e) {
    return { error: message(e) };
  }
}

// ---------- route map

/** Searches the addresses of one daily route that are not on the map yet. Only street and city are sent out. */
export async function locateAddressesAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  await assertPermission("shipping.manage");
  const dailyRouteId = s(fd, "daily_route_id");
  if (!isUuid(dailyRouteId)) return { error: "הקו היומי לא נמצא." };
  if (!geocoderEnabled()) return { error: "איתור הכתובות כבוי בהגדרות השרת. אפשר למקם כתובות על המפה ידנית." };
  const BATCH = 20;
  const pending = await pendingForRoute(query, dailyRouteId);
  let found = 0;
  let missing = 0;
  let failures = 0;
  let done = 0;
  // Not inside one transaction: each search takes a second, and every answer is kept even if a later one fails.
  for (const a of pending.slice(0, BATCH)) {
    if (a.query === null) {
      await recordSearch(query, a.id, null, null);
      missing++;
      done++;
      continue;
    }
    const answer = await searchAddress(a.query);
    if (answer.failed) {
      if (++failures >= 2) break;
      continue;
    }
    await recordSearch(query, a.id, a.query, answer.point);
    if (answer.point) found++;
    else missing++;
    done++;
  }
  refresh();
  if (pending.length === 0) return { ok: "אין כתובות שמחכות לאיתור." };
  const parts = [`אותרו ${found} כתובות.`];
  if (missing > 0) parts.push(`${missing} לא אותרו, ואפשר למקם אותן ידנית.`);
  if (failures > 0) parts.push("שירות האיתור לא ענה לחלק מהבקשות. אפשר לנסות שוב בעוד כמה דקות.");
  const left = pending.length - done;
  if (left > 0 && failures === 0) parts.push(`נותרו ${left} כתובות. יש ללחוץ שוב כדי להמשיך.`);
  return found === 0 && failures > 0 ? { error: parts.slice(1).join(" ") } : { ok: parts.join(" ") };
}

export async function placeAddressAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  const addressId = s(fd, "address_id");
  const lat = Number(s(fd, "lat"));
  const lng = Number(s(fd, "lng"));
  if (!isUuid(addressId)) return { error: "הכתובת לא נמצאה." };
  if (s(fd, "lat") === "" || s(fd, "lng") === "") return { error: "יש ללחוץ על המפה במקום של הכתובת." };
  try {
    await withTransaction((q) => setManualLocation(q, addressId, { lat, lng }, user.id));
    refresh();
    return { ok: "המיקום נשמר." };
  } catch (e) {
    return { error: e instanceof GeoError ? e.message : message(e) };
  }
}

export async function clearLocationAction(fd: FormData): Promise<void> {
  const user = await assertPermission("shipping.manage");
  const addressId = s(fd, "address_id");
  if (isUuid(addressId)) await withTransaction((q) => clearLocation(q, addressId, user.id)).catch(() => {});
  refresh();
}

export async function packageCountAction(_prev: ShippingState, fd: FormData): Promise<ShippingState> {
  const user = await assertPermission("shipping.manage");
  const deliveryId = s(fd, "delivery_id");
  const count = int(fd, "packages");
  if (!isUuid(deliveryId) || count === null) return { error: "מספר האריזות צריך להיות בין 1 ל-99." };
  try {
    await withTransaction((q) => setPackageCount(q, deliveryId, count, user.id));
    refresh();
    return { ok: "נשמר." };
  } catch (e) {
    return { error: message(e) };
  }
}
