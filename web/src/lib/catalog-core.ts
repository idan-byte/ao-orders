// Operational catalog data that Hashavshevet does not hold: department, shift, whether a product can be
// ordered, and its variants (fillings, meal kinds). No dependency on Next.js.
import type { Q } from "./auth-core.ts";

export class CatalogError extends Error {}

const clean = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ");

export type ProductOpsInput = { orderable: boolean; departmentId: number | null; defaultShift: number };

export async function updateProductOps(q: Q, sku: string, input: ProductOpsInput, userId: string): Promise<void> {
  if (![0, 1, 2].includes(input.defaultShift)) throw new CatalogError("המשמרת אינה מוכרת.");
  const [p] = await q("select 1 from products where sku = $1", [sku]);
  if (!p) throw new CatalogError("המוצר לא נמצא.");
  if (input.departmentId !== null) {
    const [d] = await q("select 1 from departments where id = $1", [input.departmentId]);
    if (!d) throw new CatalogError("המחלקה לא נמצאה.");
  }
  const [before] = await q<{ orderable: boolean; department_id: number | null; default_shift: number | null }>("select orderable, department_id, default_shift from product_ops where sku = $1", [sku]);
  await q(
    `insert into product_ops (sku, orderable, department_id, default_shift) values ($1, $2, $3, $4)
     on conflict (sku) do update set orderable = excluded.orderable, department_id = excluded.department_id, default_shift = excluded.default_shift`,
    [sku, input.orderable, input.departmentId, input.defaultShift],
  );
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'update_product_ops', 'product', $2, $3, $4)", [userId, sku, before ? JSON.stringify(before) : null, JSON.stringify(input)]);
}

/** Adds a variant to a product. A name that already exists (even if it was switched off) is switched back on instead of duplicated. */
export async function addVariant(q: Q, sku: string, name: string, userId: string): Promise<number> {
  const n = clean(name);
  if (n.length < 2) throw new CatalogError("יש להזין שם לסוג.");
  if (n.length > 40) throw new CatalogError("שם הסוג ארוך מדי (עד 40 תווים).");
  const [p] = await q("select 1 from products where sku = $1", [sku]);
  if (!p) throw new CatalogError("המוצר לא נמצא.");
  const [row] = await q<{ id: number }>("insert into product_variants (sku, name, active) values ($1, $2, true) on conflict (sku, name) do update set active = true returning id", [sku, n]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'add_variant', 'product', $2, $3)", [userId, sku, JSON.stringify({ variantId: row.id, name: n })]);
  return row.id;
}

/** Variants are never deleted, because past orders refer to them. Switching one off removes it from new orders only. */
export async function setVariantActive(q: Q, sku: string, variantId: number, active: boolean, userId: string): Promise<void> {
  const rows = await q("update product_variants set active = $3 where id = $2 and sku = $1 returning id", [sku, variantId, active]);
  if (rows.length === 0) throw new CatalogError("הסוג לא נמצא.");
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'product', $3, $4)", [userId, active ? "activate_variant" : "deactivate_variant", sku, JSON.stringify({ variantId })]);
}

/**
 * The rule that makes the production plan useful: a product that has variants cannot be ordered without one,
 * so the plan never shows an anonymous "100 sandwiches". A variant must belong to the product on the line.
 * `allowInactive` lets an existing line keep a variant that was switched off after it was ordered.
 */
export async function checkVariants(q: Q, lines: { sku: string; variantId?: number | null }[], allowInactive: Set<string> = new Set()): Promise<void> {
  for (const [i, l] of lines.entries()) {
    const variants = await q<{ id: number; active: boolean }>("select id, active from product_variants where sku = $1", [l.sku]);
    const active = variants.filter((v) => v.active);
    if (l.variantId === null || l.variantId === undefined) {
      if (active.length > 0) throw new CatalogError(`שורה ${i + 1}: למוצר ${l.sku} יש סוגים, ויש לבחור אחד מהם.`);
      continue;
    }
    const v = variants.find((x) => x.id === l.variantId);
    if (!v) throw new CatalogError(`שורה ${i + 1}: הסוג שנבחר אינו שייך למוצר ${l.sku}.`);
    if (!v.active && !allowInactive.has(`${l.sku}|${l.variantId}`)) throw new CatalogError(`שורה ${i + 1}: הסוג שנבחר כבר אינו פעיל.`);
  }
}
