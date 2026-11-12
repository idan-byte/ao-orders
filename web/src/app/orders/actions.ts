"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { query, withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { resolvePrice } from "@/lib/customers-core";
import { isLockedFor } from "@/lib/production-core";
import { advanceDelivery, cancelDelivery, createOrder, holdDelivery, OrderError, releaseDelivery, updateDelivery, type DeliveryStatus } from "@/lib/orders-core";
import type { DraftInput } from "@/lib/quotes-core";

export type OrderActionState = { error?: string; ok?: string };
const message = (e: unknown) => (e instanceof OrderError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const LOCKED = "תוכנית הייצור ליום הזה כבר נעולה. שינוי אחרי נעילה דורש אישור מנהל.";

type RawLine = { sku: string; variantId: number | null; quantity: number; unitPrice: number; discountPct: number; deliveryDate: string | null };
type Parsed = { lines: RawLine[]; discountPct: number; deliveryFee: number; deliveryDate: string | null; windowFrom: string | null; windowTo: string | null; addressId: string | null; shippingNotes: string | null; productionNotes: string | null };

function parse(raw: string): Parsed | null {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
    return {
      lines: (Array.isArray(p.lines) ? p.lines : []).map((l: Record<string, unknown>) => ({ sku: String(l.sku ?? ""), variantId: Number.isInteger(l.variantId) ? (l.variantId as number) : null, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct ?? 0), deliveryDate: str(l.deliveryDate) })),
      discountPct: Number(p.discountPct ?? 0),
      deliveryFee: Number(p.deliveryFee ?? 0),
      deliveryDate: str(p.deliveryDate),
      windowFrom: str(p.windowFrom),
      windowTo: str(p.windowTo),
      addressId: str(p.addressId),
      shippingNotes: str(p.customerNotes),
      productionNotes: str(p.internalNotes),
    };
  } catch {
    return null;
  }
}

export async function createOrderAction(_prev: OrderActionState, fd: FormData): Promise<OrderActionState> {
  const user = await assertPermission("orders.edit");
  const customerId = s(fd, "customer_id");
  const p = parse(s(fd, "payload"));
  if (!isUuid(customerId) || !p) return { error: "הנתונים שנשלחו אינם תקינים." };

  // Only someone allowed to set prices may type a price or a discount. For everyone else the server
  // prices each line itself, from the customer's agreement or the base price, and ignores what the browser sent.
  const mayPrice = can(user.role, "prices.edit");
  if (!mayPrice) {
    for (const l of p.lines) {
      const onDate = l.deliveryDate ?? p.deliveryDate;
      const resolved = onDate && /^\d{4}-\d{2}-\d{2}$/.test(onDate) ? await resolvePrice(query, customerId, l.sku, onDate) : null;
      l.unitPrice = resolved?.price ?? 0;
      l.discountPct = 0;
    }
    p.discountPct = 0;
  }
  const draft: DraftInput = {
    lines: p.lines.map((l) => ({ sku: l.sku, variantId: l.variantId, description: l.sku, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, deliveryDate: l.deliveryDate })),
    discountPct: p.discountPct,
    deliveryFee: p.deliveryFee,
    deliveryDate: p.deliveryDate,
    windowFrom: p.windowFrom,
    windowTo: p.windowTo,
    addressId: p.addressId,
    customerNotes: p.shippingNotes,
    internalNotes: p.productionNotes,
    validUntil: null,
    paymentTerms: null,
  };
  if (!can(user.role, "orders.change_locked")) {
    for (const l of p.lines) {
      const onDate = l.deliveryDate ?? p.deliveryDate;
      if (onDate && (await isLockedFor(query, onDate, [l.sku]))) return { error: LOCKED };
    }
  }
  let orderId: string;
  try {
    orderId = (await withTransaction((q) => createOrder(q, customerId, user.id, draft))).orderId;
  } catch (e) {
    return { error: message(e) };
  }
  redirect(`/orders/${orderId}`);
}

export async function updateDeliveryAction(_prev: OrderActionState, fd: FormData): Promise<OrderActionState> {
  const user = await assertPermission("orders.edit");
  const deliveryId = s(fd, "delivery_id");
  const p = parse(s(fd, "payload"));
  if (!isUuid(deliveryId) || !p || !p.deliveryDate) return { error: "יש לקבוע תאריך אספקה." };

  const [del] = await query<{ order_id: string; customer_id: string; delivery_date: string }>("select d.order_id::text, o.customer_id::text, d.delivery_date::text from deliveries d join orders o on o.id = d.order_id where d.id = $1", [deliveryId]);
  if (!del) return { error: "האספקה לא נמצאה." };
  if (!can(user.role, "orders.change_locked")) {
    const before = (await query<{ sku: string }>("select sku from delivery_lines where delivery_id = $1", [deliveryId])).map((l) => l.sku);
    const skus = [...new Set([...before, ...p.lines.map((l) => l.sku)])];
    if ((await isLockedFor(query, del.delivery_date, skus)) || (await isLockedFor(query, p.deliveryDate, skus))) return { error: LOCKED };
  }
  if (!can(user.role, "prices.edit")) {
    // Existing lines keep the price they already have; a newly added product gets the customer's price.
    const existing = new Map((await query<{ sku: string; unit_price: number; discount_pct: number }>("select sku, unit_price::float, discount_pct::float from delivery_lines where delivery_id = $1 order by id desc", [deliveryId])).map((l) => [l.sku, l]));
    for (const l of p.lines) {
      const old = existing.get(l.sku);
      if (old) {
        l.unitPrice = old.unit_price;
        l.discountPct = old.discount_pct;
      } else {
        l.unitPrice = (await resolvePrice(query, del.customer_id, l.sku, p.deliveryDate))?.price ?? 0;
        l.discountPct = 0;
      }
    }
  }
  try {
    const changes = await withTransaction((q) =>
      updateDelivery(q, deliveryId, { lines: p.lines, deliveryDate: p.deliveryDate!, windowFrom: p.windowFrom, windowTo: p.windowTo, addressId: p.addressId, productionNotes: p.productionNotes, shippingNotes: p.shippingNotes }, user.id),
    );
    if (changes.length === 0) return { ok: "לא היה מה לשנות." };
  } catch (e) {
    return { error: message(e) };
  }
  redirect(`/orders/${del.order_id}`);
}

export async function advanceAction(fd: FormData): Promise<void> {
  const user = await assertPermission("orders.edit");
  try {
    await withTransaction((q) => advanceDelivery(q, s(fd, "delivery_id"), s(fd, "expected") as DeliveryStatus, user.id));
  } catch {
    // Someone else already moved it: the refreshed screen shows the real state.
  }
  refresh();
}

export async function holdAction(_prev: OrderActionState, fd: FormData): Promise<OrderActionState> {
  const user = await assertPermission("orders.edit");
  const kind = s(fd, "kind") === "delayed" ? "delayed" : "exception";
  try {
    await withTransaction((q) => holdDelivery(q, s(fd, "delivery_id"), kind, s(fd, "note"), user.id));
    refresh();
    return { ok: "סומן." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function releaseAction(fd: FormData): Promise<void> {
  const user = await assertPermission("orders.edit");
  try {
    await withTransaction((q) => releaseDelivery(q, s(fd, "delivery_id"), user.id));
  } catch {
    // Already released.
  }
  refresh();
}

export async function cancelAction(_prev: OrderActionState, fd: FormData): Promise<OrderActionState> {
  const user = await assertPermission("orders.cancel");
  if (!can(user.role, "orders.change_locked")) {
    const [d] = await query<{ delivery_date: string }>("select delivery_date::text from deliveries where id = $1", [s(fd, "delivery_id")]);
    const skus = (await query<{ sku: string }>("select sku from delivery_lines where delivery_id = $1", [s(fd, "delivery_id")])).map((l) => l.sku);
    if (d && (await isLockedFor(query, d.delivery_date, skus))) return { error: LOCKED };
  }
  try {
    await withTransaction((q) => cancelDelivery(q, s(fd, "delivery_id"), s(fd, "reason"), user.id));
    refresh();
    return { ok: "האספקה בוטלה." };
  } catch (e) {
    return { error: message(e) };
  }
}
