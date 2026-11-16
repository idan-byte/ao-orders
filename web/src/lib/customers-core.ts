// Import from Hashavshevet and price-agreement logic. No dependency on Next.js, so it is tested directly.
import type { Q } from "./auth-core.ts";

export type HashProduct = {
  sku: string;
  name: string | null;
  sort_group: number | null;
  base_price_ex_vat: number | null;
  sales_unit: string | null;
  vat_exempt: number | null;
  lines_12m: number | null;
};
export type HashCustomer = {
  account_key: string;
  name: string | null;
  tax_id: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  fixed_discount_pct: number | null;
  vat_exempt: number | null;
  last_document_date: string | null;
};
export type HashLastPrice = {
  account_key: string;
  sku: string;
  last_price_ex_vat: number;
  charged_on: string | null;
  source_document_type: number | null;
  source_document_number: number | null;
};

const DEPARTMENT_BY_SORT_GROUP: Record<number, string | null> = { 500: "כריכים", 600: "מטבח חם", 630: "מגשי אירוח", 650: null };
const SHIFT_BY_SORT_GROUP: Record<number, number> = { 500: 1, 600: 2, 630: 2, 650: 2 };
export const DEPARTMENTS = ["כריכים", "מטבח חם", "מגשי אירוח", "אריזה"];
const DOC_TYPE: Record<number, string> = { 1: "חשבונית מס", 4: "תעודת משלוח", 37: "חשבונית ריכוז" };

const text = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** Hashavshevet owns sku, name and base price. Operational data (product_ops) is created once and never overwritten. */
export async function importCatalog(q: Q, rows: HashProduct[]): Promise<{ created: number; updated: number }> {
  for (const name of DEPARTMENTS) await q("insert into departments (name) values ($1) on conflict (name) do nothing", [name]);
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    if (!text(r.sku)) continue;
    const g = r.sort_group ?? 0;
    const [res] = await q<{ inserted: boolean }>(
      `insert into products (sku, name, sort_group, base_price, sales_unit, vat_exempt, hash_active, synced_at)
       values ($1, $2, $3, $4, $5, $6, true, now())
       on conflict (sku) do update set name = excluded.name, sort_group = excluded.sort_group, base_price = excluded.base_price,
         sales_unit = excluded.sales_unit, vat_exempt = excluded.vat_exempt, hash_active = true, synced_at = now()
       returning (xmax = 0) as inserted`,
      [r.sku.trim(), text(r.name) ?? r.sku.trim(), g, r.base_price_ex_vat ?? 0, text(r.sales_unit), r.vat_exempt === 1],
    );
    if (res.inserted) created++;
    else updated++;
    await q(
      `insert into product_ops (sku, orderable, department_id, default_shift)
       values ($1, $2, (select id from departments where name = $3), $4)
       on conflict (sku) do nothing`,
      [r.sku.trim(), (r.lines_12m ?? 0) > 0, DEPARTMENT_BY_SORT_GROUP[g] ?? null, SHIFT_BY_SORT_GROUP[g] ?? 2],
    );
  }
  return { created, updated };
}

export class CustomerError extends Error {}

/**
 * A customer typed in here, before it exists in Hashavshevet. Only the name is needed now; the rest can follow.
 * It is marked as waiting for Hashavshevet, and it has no account key until it is entered there.
 */
export async function createLocalCustomer(q: Q, input: { name: string; taxId: string | null; phone: string | null; email: string | null }): Promise<{ customerId: string }> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (name.length < 2) throw new CustomerError("יש להזין שם לקוח.");
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new CustomerError("כתובת המייל אינה תקינה.");
  const [c] = await q<{ id: string }>("insert into customers (name, tax_id, pending_hash_sync) values ($1, $2, true) returning id::text", [name, input.taxId?.trim() || null]);
  if (input.phone || input.email) {
    await q("insert into customer_contacts (customer_id, full_name, phone, email) values ($1, $2, $3, $4)", [c.id, name, input.phone?.trim() || null, input.email?.trim() || null]);
  }
  return { customerId: c.id };
}

/**
 * Customers are matched by their Hashavshevet account key. Fields that mirror Hashavshevet are refreshed on
 * every sync; data entered in this system (delivery addresses, contacts, notes, billing policy) is never touched.
 */
export async function importCustomers(q: Q, rows: HashCustomer[]): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const key = text(r.account_key);
    if (!key) continue;
    const [res] = await q<{ id: string; inserted: boolean }>(
      `insert into customers (name, tax_id, hash_account_key, fixed_discount_pct, vat_exempt, hash_phone, hash_address, hash_city, last_document_date, synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, now())
       on conflict (hash_account_key) do update set name = excluded.name, tax_id = excluded.tax_id,
         fixed_discount_pct = excluded.fixed_discount_pct, vat_exempt = excluded.vat_exempt, hash_phone = excluded.hash_phone,
         hash_address = excluded.hash_address, hash_city = excluded.hash_city, last_document_date = excluded.last_document_date, synced_at = now()
       returning id::text, (xmax = 0) as inserted`,
      [text(r.name) ?? key, text(r.tax_id), key, r.fixed_discount_pct ?? 0, r.vat_exempt === 1, text(r.phone), text(r.address), text(r.city), r.last_document_date],
    );
    if (res.inserted) {
      created++;
      // A first delivery address is created from the Hashavshevet address. After that, addresses belong to this system.
      if (text(r.address)) {
        await q("insert into customer_addresses (customer_id, label, street, city, is_default) values ($1, 'כתובת מחשבשבת', $2, $3, true)", [res.id, text(r.address), text(r.city)]);
      }
    } else updated++;
  }
  return { created, updated };
}

/**
 * The last price each customer was charged becomes a pending row for a person to review.
 * An approved or manually entered price is never changed by the import.
 * Hashavshevet documents are sometimes dated ahead (tomorrow's delivery note), so the start date is capped
 * at today: a price that was already charged must apply now, not from a future date.
 */
export async function importLastPrices(q: Q, rows: HashLastPrice[]): Promise<{ created: number; refreshed: number; skipped: number }> {
  let created = 0;
  let refreshed = 0;
  let skipped = 0;
  for (const r of rows) {
    const [c] = await q<{ id: string }>("select id::text from customers where hash_account_key = $1", [text(r.account_key)]);
    const [p] = await q("select 1 from products where sku = $1", [text(r.sku)]);
    if (!c || !p || !(r.last_price_ex_vat > 0)) {
      skipped++;
      continue;
    }
    const note = `${DOC_TYPE[r.source_document_type ?? 0] ?? "מסמך"} ${r.source_document_number ?? ""}`.trim();
    const existing = await q<{ id: string; approved_at: string | null; source: string }>(
      "select id::text, approved_at::text, source from customer_prices where customer_id = $1 and sku = $2",
      [c.id, r.sku.trim()],
    );
    if (existing.length === 0) {
      await q(
        `insert into customer_prices (customer_id, sku, price, valid_from, source, source_note)
         values ($1, $2, $3, least(coalesce($4::date, current_date), current_date), 'hashavshevet_last_price', $5)`,
        [c.id, r.sku.trim(), r.last_price_ex_vat, r.charged_on, note],
      );
      created++;
      continue;
    }
    const pending = existing.find((e) => e.approved_at === null && e.source === "hashavshevet_last_price");
    if (pending && existing.every((e) => e.approved_at === null)) {
      await q("update customer_prices set price = $2, valid_from = least(coalesce($3::date, valid_from), current_date), source_note = $4 where id = $1", [pending.id, r.last_price_ex_vat, r.charged_on, note]);
      refreshed++;
    } else skipped++;
  }
  return { created, refreshed, skipped };
}

/** A pending price that deserves a second look before approval. */
export function isSuspiciousPrice(price: number, basePrice: number): boolean {
  if (price > 1000) return true;
  if (basePrice > 0 && (price > basePrice * 3 || price < basePrice / 3)) return true;
  return false;
}

export type ResolvedPrice = { price: number; source: "agreement" | "base" };

/** The price to offer a customer for a product on a date: an approved agreement if one applies, otherwise the base price. */
export async function resolvePrice(q: Q, customerId: string, sku: string, onDate: string): Promise<ResolvedPrice | null> {
  const [agreed] = await q<{ price: string }>(
    `select price::text from customer_prices
     where customer_id = $1 and sku = $2 and approved_at is not null
       and valid_from <= $3::date and (valid_to is null or valid_to >= $3::date)
     order by valid_from desc, id desc limit 1`,
    [customerId, sku, onDate],
  );
  if (agreed) return { price: Number(agreed.price), source: "agreement" };
  const [base] = await q<{ base_price: string }>("select base_price::text from products where sku = $1", [sku]);
  if (!base) return null;
  return { price: Number(base.base_price), source: "base" };
}

/** Approves pending prices of one customer: all of them, or only the given row ids. */
export async function approvePrices(q: Q, customerId: string, userId: string, ids?: string[]): Promise<number> {
  const rows = ids
    ? await q("update customer_prices set approved_at = now(), approved_by = $2 where customer_id = $1 and approved_at is null and id = any($3::bigint[]) returning id", [customerId, userId, ids])
    : await q("update customer_prices set approved_at = now(), approved_by = $2 where customer_id = $1 and approved_at is null returning id", [customerId, userId]);
  return rows.length;
}

/** Sets an agreed price from a given date. Earlier approved prices stay as history and stop applying from that date. */
export async function setAgreedPrice(q: Q, customerId: string, sku: string, price: number, userId: string, fromDate: string): Promise<void> {
  if (!(price >= 0) || !Number.isFinite(price)) throw new Error("invalid price");
  await q("delete from customer_prices where customer_id = $1 and sku = $2 and approved_at is null", [customerId, sku]);
  await q(
    `insert into customer_prices (customer_id, sku, price, valid_from, source, approved_at, approved_by)
     values ($1, $2, $3, $4::date, 'manual', now(), $5)
     on conflict (customer_id, sku, valid_from) do update set price = excluded.price, source = 'manual', approved_at = now(), approved_by = excluded.approved_by, source_note = null`,
    [customerId, sku, price, fromDate, userId],
  );
}

export async function removePrice(q: Q, customerId: string, id: string): Promise<void> {
  await q("delete from customer_prices where customer_id = $1 and id = $2", [customerId, id]);
}
