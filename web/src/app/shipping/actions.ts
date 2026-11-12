"use server";

import { refresh } from "next/cache";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { assignDelivery, moveAddress, moveStop, planDay, saveDriver, saveRoute, setAddressRoute, setDailyDriver, setDriverActive, setRouteActive, ShippingError } from "@/lib/shipping-core";

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
