// Hot food: linking an institution to the customer that is billed and to a delivery address, and turning
// Milgam's daily order into deliveries with a hot box and a cold box for every group. No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { resolvePrice } from "./customers-core.ts";
import { VAT_RATE } from "./quote-totals.ts";

export class HotFoodError extends Error {}

// ---------- an institution's customer and address

export type InstitutionCard = {
  id: number;
  symbol: string;
  name: string;
  kind: string | null;
  authority: string | null;
  address: string | null;
  kosher: string | null;
  notes: string | null;
  lifeThreatening: boolean;
  customerId: string | null;
  customer: string | null;
  addressId: string | null;
  linkedAddress: string | null;
  route: string | null;
  groups: { id: number; className: string; program: string | null }[];
};

export async function getInstitution(q: Q, id: number): Promise<InstitutionCard | null> {
  const [i] = await q<Omit<InstitutionCard, "groups">>(
    `select i.id, i.symbol, i.name, i.kind, i.authority, i.address, i.kosher, i.notes, i.life_threatening as "lifeThreatening",
            i.customer_id::text as "customerId", c.name as customer, i.address_id::text as "addressId",
            nullif(concat_ws(', ', a.street, a.city), '') as "linkedAddress", r.name as route
     from institutions i left join customers c on c.id = i.customer_id left join customer_addresses a on a.id = i.address_id left join routes r on r.id = a.route_id
     where i.id = $1`,
    [id],
  );
  if (!i) return null;
  const groups = await q<{ id: number; className: string; program: string | null }>(
    `select g.id, g.class_name as "className", p.name as program from institution_groups g left join feeding_programs p on p.id = g.program_id where g.institution_id = $1 order by g.class_name`,
    [id],
  );
  return { ...i, groups };
}

/**
 * Says who is billed for an institution and where it is delivered. Both are chosen by a person:
 * the address must be one of that customer's addresses, and the route comes from the address.
 */
export async function linkInstitution(q: Q, institutionId: number, customerId: string | null, addressId: string | null, userId: string): Promise<void> {
  const [before] = await q<{ customer_id: string | null; address_id: string | null }>("select customer_id::text, address_id::text from institutions where id = $1 for update", [institutionId]);
  if (!before) throw new HotFoodError("המוסד לא נמצא.");
  if (!customerId && addressId) throw new HotFoodError("כתובת אספקה נבחרת רק יחד עם לקוח.");
  if (customerId) {
    const [c] = await q("select 1 from customers where id = $1 and active", [customerId]);
    if (!c) throw new HotFoodError("הלקוח לא נמצא.");
  }
  if (addressId) {
    const [a] = await q("select 1 from customer_addresses where id = $1 and customer_id = $2", [addressId, customerId]);
    if (!a) throw new HotFoodError("כתובת האספקה אינה שייכת ללקוח שנבחר.");
  }
  if (before.customer_id === customerId && before.address_id === addressId) return;
  await q("update institutions set customer_id = $2, address_id = $3 where id = $1", [institutionId, customerId, addressId]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'institution_link', 'institution', $2, $3, $4)", [userId, String(institutionId), JSON.stringify(before), JSON.stringify({ customer_id: customerId, address_id: addressId })]);
}

// ---------- from the daily order to deliveries

export type GroupOrder = { groupId: number; className: string; meals: { mealType: string; quantity: number }[] };
export type DayInstitution = {
  institutionId: number;
  symbol: string;
  name: string;
  portions: number;
  groups: GroupOrder[];
  blocked: string[]; // why a delivery cannot be made yet; empty when it can
  deliveryId: string | null;
  orderNumber: number | null;
  deliveryStatus: string | null;
  route: string | null;
};
export type DayPlan = { day: string; ordered: boolean; institutions: DayInstitution[] };

type Line = { sku: string; quantity: number };
type Source = { institution_id: number; symbol: string; name: string; customer_id: string | null; address_id: string | null; notes: string | null; group_id: number; class_name: string; meal_type: string; sku: string | null; qty: number; has_variants: boolean; orderable: boolean | null };

async function daySource(q: Q, day: string): Promise<Source[]> {
  return q<Source>(
    `select i.id as institution_id, i.symbol, i.name, i.customer_id::text, i.address_id::text, i.notes, g.id as group_id, g.class_name, mt.name as meal_type, mt.sku,
            mq.ordered_qty as qty, exists (select 1 from product_variants v where v.sku = mt.sku and v.active) as has_variants,
            (select po.orderable from product_ops po where po.sku = mt.sku) as orderable
     from milgam_quantities mq join institution_groups g on g.id = mq.group_id join institutions i on i.id = g.institution_id join meal_types mt on mt.id = mq.meal_type_id
     where mq.day = $1::date and mq.ordered_qty is not null order by i.name, i.symbol, g.class_name, mt.name`,
    [day],
  );
}

function blockers(rows: Source[]): string[] {
  const out: string[] = [];
  if (!rows[0].customer_id) out.push("המוסד לא שויך ללקוח לחיוב");
  else if (!rows[0].address_id) out.push("למוסד לא נבחרה כתובת אספקה");
  const unmapped = [...new Set(rows.filter((r) => !r.sku).map((r) => r.meal_type))];
  if (unmapped.length > 0) out.push(`סוגי מנה בלי מק״ט: ${unmapped.join(", ")}`);
  const variants = [...new Set(rows.filter((r) => r.sku && r.has_variants).map((r) => r.sku!))];
  if (variants.length > 0) out.push(`למק״ט ${variants.join(", ")} מוגדרים סוגים, ואין עדיין תפריט שבוחר ביניהם`);
  const closed = [...new Set(rows.filter((r) => r.sku && r.orderable === false).map((r) => r.sku!))];
  if (closed.length > 0) out.push(`מק״ט ${closed.join(", ")} אינו פתוח להזמנה בקטלוג`);
  return out;
}

const byInstitution = (rows: Source[]) => {
  const map = new Map<number, Source[]>();
  for (const r of rows) map.set(r.institution_id, [...(map.get(r.institution_id) ?? []), r]);
  return [...map.values()];
};
const groupsOf = (rows: Source[]): GroupOrder[] => {
  const map = new Map<number, GroupOrder>();
  for (const r of rows) {
    const g = map.get(r.group_id) ?? { groupId: r.group_id, className: r.class_name, meals: [] };
    g.meals.push({ mealType: r.meal_type, quantity: r.qty });
    map.set(r.group_id, g);
  }
  return [...map.values()];
};

/** The day as Milgam ordered it, institution by institution: what can become a delivery, what cannot and why, and what already has. */
export async function dayPlan(q: Q, day: string): Promise<DayPlan> {
  const [od] = await q("select 1 from milgam_order_days where day = $1::date", [day]);
  const made = new Map(
    (
      await q<{ institution_id: number; delivery_id: string; number: number; status: string; route: string | null }>(
        `select md.institution_id, md.delivery_id::text, o.number, d.status::text, (select r.name from daily_routes dr join routes r on r.id = dr.route_id where dr.id = d.daily_route_id) as route
         from milgam_deliveries md join deliveries d on d.id = md.delivery_id join orders o on o.id = d.order_id where md.day = $1::date`,
        [day],
      )
    ).map((r) => [r.institution_id, r]),
  );
  const institutions = byInstitution(await daySource(q, day)).map((rows): DayInstitution => {
    const m = made.get(rows[0].institution_id);
    return {
      institutionId: rows[0].institution_id,
      symbol: rows[0].symbol,
      name: rows[0].name,
      portions: rows.reduce((a, r) => a + r.qty, 0),
      groups: groupsOf(rows),
      blocked: blockers(rows),
      deliveryId: m?.delivery_id ?? null,
      orderNumber: m?.number ?? null,
      deliveryStatus: m?.status ?? null,
      route: m?.route ?? null,
    };
  });
  return { day, ordered: !!od, institutions };
}

export type MakeResult = { created: number; updated: number; unchanged: number; blocked: { name: string; symbol: string; reasons: string[] }[]; frozen: { name: string; symbol: string; reason: string }[] };

/**
 * Makes one delivery for every institution of the day's order: a line per catalogue item, priced by the
 * customer's price agreement, and for every group one hot box and one cold box, each with its own scan code.
 * Running it again after a corrected order updates the deliveries that have not started moving, and leaves
 * the others alone, saying so. An institution that is not ready is skipped with the reason.
 */
export async function makeDeliveries(q: Q, day: string, userId: string): Promise<MakeResult> {
  const [od] = await q("select 1 from milgam_order_days where day = $1::date", [day]);
  if (!od) throw new HotFoodError("ליום הזה עוד לא נטענה ההזמנה היומית של מילגם. אספקות נוצרות מההזמנה, לא מהצפי.");
  const result: MakeResult = { created: 0, updated: 0, unchanged: 0, blocked: [], frozen: [] };
  for (const rows of byInstitution(await daySource(q, day))) {
    const inst = rows[0];
    const reasons = blockers(rows);
    if (reasons.length > 0) {
      result.blocked.push({ name: inst.name, symbol: inst.symbol, reasons });
      continue;
    }
    const lineMap = new Map<string, number>();
    for (const r of rows) lineMap.set(r.sku!, (lineMap.get(r.sku!) ?? 0) + r.qty);
    const lines: Line[] = [...lineMap.entries()].sort().map(([sku, quantity]) => ({ sku, quantity }));
    const groups = groupsOf(rows);
    const [existing] = await q<{ delivery_id: string; status: string; daily_route_id: string | null; mode: string | null; loaded: number }>(
      `select md.delivery_id::text, d.status::text, d.daily_route_id::text, (select dr.mode from daily_routes dr where dr.id = d.daily_route_id) as mode,
              (select count(*)::int from delivery_boxes b where b.delivery_id = d.id and b.loaded_at is not null) as loaded
       from milgam_deliveries md join deliveries d on d.id = md.delivery_id where md.institution_id = $1 and md.day = $2::date for update of d`,
      [inst.institution_id, day],
    );
    if (!existing) {
      const [a] = await q<{ street: string; city: string | null }>("select street, city from customer_addresses where id = $1 and customer_id = $2", [inst.address_id, inst.customer_id]);
      if (!a) {
        result.blocked.push({ name: inst.name, symbol: inst.symbol, reasons: ["כתובת האספקה אינה שייכת ללקוח"] });
        continue;
      }
      const [order] = await q<{ id: string; number: number }>("insert into orders (customer_id, source, owner_id, discount_pct, vat_rate, delivery_fee) values ($1, 'milgam', $2, 0, $3, 0) returning id::text, number", [inst.customer_id, userId, VAT_RATE]);
      // The institution's remarks are its allergy instructions: they go whole to production and to the driver.
      const [delivery] = await q<{ id: string }>(
        `insert into deliveries (order_id, delivery_date, address_id, address_snapshot, status, production_notes, shipping_notes) values ($1, $2::date, $3, $4, 'approved', $5, $5) returning id::text`,
        [order.id, day, inst.address_id, [a.street, a.city].filter(Boolean).join(", "), inst.notes],
      );
      for (const l of lines) {
        const price = (await resolvePrice(q, inst.customer_id!, l.sku, day))?.price ?? 0;
        await q("insert into delivery_lines (delivery_id, sku, quantity, unit_price) values ($1, $2, $3, $4)", [delivery.id, l.sku, l.quantity, price]);
      }
      // The box every delivery starts with gives way to the groups' boxes.
      await q("delete from delivery_boxes where delivery_id = $1", [delivery.id]);
      await setBoxes(q, delivery.id, groups.map((g) => g.groupId));
      await q("insert into milgam_deliveries (institution_id, day, delivery_id) values ($1, $2::date, $3)", [inst.institution_id, day, delivery.id]);
      await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'create_order', 'order', $2, $3)", [userId, order.id, JSON.stringify({ number: order.number, source: "milgam", institution: inst.symbol, day, portions: rows.reduce((x, r) => x + r.qty, 0), groups: groups.length })]);
      result.created++;
      continue;
    }
    // An existing delivery: is anything different?
    const current = await q<{ sku: string; quantity: number }>("select sku, quantity::float as quantity from delivery_lines where delivery_id = $1 order by sku", [existing.delivery_id]);
    const currentGroups = (await q<{ group_id: number }>("select distinct group_id from delivery_boxes where delivery_id = $1 and group_id is not null order by group_id", [existing.delivery_id])).map((r) => r.group_id);
    const wantedGroups = groups.map((g) => g.groupId).sort((x, y) => x - y);
    const same = JSON.stringify(current) === JSON.stringify(lines) && JSON.stringify(currentGroups) === JSON.stringify(wantedGroups);
    if (same) {
      result.unchanged++;
      continue;
    }
    const frozen = existing.status !== "approved" ? "האספקה כבר בתהליך" : existing.mode === "unloading" ? "הקו כבר יצא" : existing.loaded > 0 ? "כבר הועמסו ארגזים" : null;
    if (frozen) {
      result.frozen.push({ name: inst.name, symbol: inst.symbol, reason: `${frozen}, ולכן היא לא עודכנה לפי ההזמנה החדשה` });
      continue;
    }
    await q("delete from delivery_lines where delivery_id = $1", [existing.delivery_id]);
    for (const l of lines) {
      const price = (await resolvePrice(q, inst.customer_id!, l.sku, day))?.price ?? 0;
      await q("insert into delivery_lines (delivery_id, sku, quantity, unit_price) values ($1, $2, $3, $4)", [existing.delivery_id, l.sku, l.quantity, price]);
    }
    await q("update deliveries set production_notes = $2, shipping_notes = $2, loaded_at = null, loaded_by = null where id = $1", [existing.delivery_id, inst.notes]);
    await setBoxes(q, existing.delivery_id, wantedGroups);
    await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'milgam_update', 'delivery', $2, $3, $4)", [userId, existing.delivery_id, JSON.stringify({ lines: current, groups: currentGroups }), JSON.stringify({ lines, groups: wantedGroups })]);
    result.updated++;
  }
  return result;
}

/** Makes the boxes of a delivery match its groups: a hot box and a cold box each. Boxes of groups that stay keep their codes. */
async function setBoxes(q: Q, deliveryId: string, groupIds: number[]): Promise<void> {
  await q("delete from delivery_boxes where delivery_id = $1 and (group_id is null or group_id <> all($2::int[]))", [deliveryId, groupIds]);
  const have = new Set((await q<{ group_id: number; kind: string }>("select group_id, kind from delivery_boxes where delivery_id = $1", [deliveryId])).map((b) => `${b.group_id}|${b.kind}`));
  let [{ seq }] = await q<{ seq: number }>("select coalesce(max(seq), 0)::int as seq from delivery_boxes where delivery_id = $1", [deliveryId]);
  const names = new Map((await q<{ id: number; class_name: string }>("select id, class_name from institution_groups where id = any($1::int[])", [groupIds])).map((g) => [g.id, g.class_name]));
  for (const groupId of [...groupIds].sort((a, b) => (names.get(a) ?? "").localeCompare(names.get(b) ?? "", "he"))) {
    for (const kind of ["hot", "cold"]) {
      if (!have.has(`${groupId}|${kind}`)) await q("insert into delivery_boxes (delivery_id, seq, kind, group_id) values ($1, $2, $3, $4)", [deliveryId, ++seq, kind, groupId]);
    }
  }
}
