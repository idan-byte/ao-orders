"use server";

import { refresh } from "next/cache";
import { query } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { approvePrices, removePrice, setAgreedPrice } from "@/lib/customers-core";
import { syncFromHashavshevet } from "@/lib/hashavshevet-sync";

export type ActionState = { error?: string; ok?: string };

async function audit(userId: string, action: string, entityType: string, entityId: string, after: unknown) {
  await query("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, $3, $4, $5)", [userId, action, entityType, entityId, JSON.stringify(after)]);
}

export async function syncAction(): Promise<ActionState> {
  const user = await assertPermission("sync.run");
  try {
    const s = await syncFromHashavshevet();
    await audit(user.id, "sync", "hashavshevet", "all", s);
    refresh();
    return {
      ok: `הסנכרון הושלם. לקוחות: ${s.customers.created} חדשים, ${s.customers.updated} עודכנו. מוצרים: ${s.catalog.created} חדשים, ${s.catalog.updated} עודכנו. מחירים לבדיקה: ${s.prices.created} חדשים, ${s.prices.refreshed} עודכנו.`,
    };
  } catch (e) {
    return { error: `הסנכרון נכשל ושום דבר לא נמחק. ${e instanceof Error ? e.message.split("\n")[0] : ""}` };
  }
}

export async function approveAllPricesAction(formData: FormData): Promise<void> {
  const user = await assertPermission("prices.edit");
  const customerId = String(formData.get("customer_id") ?? "");
  const n = await approvePrices(query, customerId, user.id);
  if (n > 0) await audit(user.id, "approve_prices", "customer", customerId, { approved: n });
  refresh();
}

export async function approvePriceAction(formData: FormData): Promise<void> {
  const user = await assertPermission("prices.edit");
  const customerId = String(formData.get("customer_id") ?? "");
  const id = String(formData.get("price_id") ?? "");
  const n = await approvePrices(query, customerId, user.id, [id]);
  if (n > 0) await audit(user.id, "approve_price", "customer_price", id, { customerId });
  refresh();
}

export async function removePriceAction(formData: FormData): Promise<void> {
  const user = await assertPermission("prices.edit");
  const customerId = String(formData.get("customer_id") ?? "");
  const id = String(formData.get("price_id") ?? "");
  await removePrice(query, customerId, id);
  await audit(user.id, "remove_price", "customer_price", id, { customerId });
  refresh();
}

export async function setPriceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await assertPermission("prices.edit");
  const customerId = String(formData.get("customer_id") ?? "");
  const sku = String(formData.get("sku") ?? "").trim();
  const price = Number(String(formData.get("price") ?? "").replace(",", "."));
  const from = String(formData.get("valid_from") ?? "");

  if (!sku) return { error: "יש לבחור מוצר." };
  if (!Number.isFinite(price) || price < 0) return { error: "המחיר אינו תקין." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return { error: "יש לבחור תאריך תחילה." };
  const [product] = await query("select 1 from products where sku = $1", [sku]);
  if (!product) return { error: "המק״ט אינו קיים בקטלוג." };

  await setAgreedPrice(query, customerId, sku, price, user.id, from);
  await audit(user.id, "set_price", "customer", customerId, { sku, price, from });
  refresh();
  return { ok: "המחיר נשמר." };
}

export async function addAddressAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await assertPermission("customers.edit");
  const customerId = String(formData.get("customer_id") ?? "");
  const street = String(formData.get("street") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const area = String(formData.get("delivery_area") ?? "").trim();
  if (street.length < 2) return { error: "יש להזין כתובת." };

  const [first] = await query<{ n: number }>("select count(*)::int as n from customer_addresses where customer_id = $1", [customerId]);
  const [created] = await query<{ id: string }>(
    "insert into customer_addresses (customer_id, label, street, city, delivery_area, is_default) values ($1, $2, $3, $4, $5, $6) returning id::text",
    [customerId, label || null, street, city || null, area || null, first.n === 0],
  );
  await audit(user.id, "add_address", "customer", customerId, { addressId: created.id, street, city });
  refresh();
  return { ok: "הכתובת נוספה." };
}

export async function addContactAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await assertPermission("customers.edit");
  const customerId = String(formData.get("customer_id") ?? "");
  const fullName = String(formData.get("full_name") ?? "").trim();
  const roleLabel = String(formData.get("role_label") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  if (fullName.length < 2) return { error: "יש להזין שם." };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "כתובת המייל אינה תקינה." };

  const [created] = await query<{ id: string }>(
    "insert into customer_contacts (customer_id, full_name, role_label, phone, email) values ($1, $2, $3, $4, $5) returning id::text",
    [customerId, fullName, roleLabel || null, phone || null, email || null],
  );
  await audit(user.id, "add_contact", "customer", customerId, { contactId: created.id });
  refresh();
  return { ok: "איש הקשר נוסף." };
}
