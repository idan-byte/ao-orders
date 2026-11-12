// Production plan: aggregated quantities per department and shift, locking, late-change detection and marking done.
// No dependency on Next.js.
import type { Q } from "./auth-core.ts";

export class ProductionError extends Error {}

export const SHIFTS = ["ערב קודם", "לילה", "בוקר"] as const;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const key = (sku: string, variantId: number | null) => `${sku}|${variantId ?? ""}`;

export type PlanRow = { shift: number; sku: string; product: string; variantId: number | null; variant: string | null; quantity: number; lines: number; producedLines: number };

export async function planRows(q: Q, date: string, departmentId: number): Promise<PlanRow[]> {
  if (!isDate(date)) throw new ProductionError("התאריך אינו תקין.");
  const rows = await q<{ shift: number; sku: string; product: string; variant_id: number | null; variant: string | null; quantity: number; lines: number; produced_lines: number }>(
    `select shift, sku, product, variant_id, variant, quantity::float, lines, produced_lines
     from production_rows where delivery_date = $1::date and department_id = $2
     order by shift, quantity desc, product`,
    [date, departmentId],
  );
  return rows.map((r) => ({ shift: r.shift, sku: r.sku, product: r.product, variantId: r.variant_id, variant: r.variant, quantity: r.quantity, lines: r.lines, producedLines: r.produced_lines }));
}

type Snapshot = Record<string, { quantity: number; label: string }>;
const snapshotOf = (rows: PlanRow[]): Snapshot => Object.fromEntries(rows.map((r) => [key(r.sku, r.variantId), { quantity: r.quantity, label: r.variant ? `${r.product} · ${r.variant}` : r.product }]));

/** Locks one shift of one department for a delivery date, remembering exactly what the plan said at that moment. */
export async function lockPlan(q: Q, date: string, departmentId: number, shift: number, userId: string | null, auto = false): Promise<string> {
  if (!(shift in SHIFTS)) throw new ProductionError("המשמרת אינה מוכרת.");
  const rows = (await planRows(q, date, departmentId)).filter((r) => r.shift === shift);
  const [existing] = await q<{ id: string; locked_at: string | null }>("select id::text, locked_at::text from production_plans where plan_date = $1::date and department_id = $2 and shift = $3", [date, departmentId, shift]);
  if (existing?.locked_at) throw new ProductionError("המשמרת כבר נעולה.");
  const snapshot = JSON.stringify(snapshotOf(rows));
  if (existing) {
    await q("update production_plans set locked_at = now(), locked_by = $2, snapshot = $3, auto_locked_at = case when $4::boolean then now() else auto_locked_at end where id = $1", [existing.id, userId, snapshot, auto]);
    return existing.id;
  }
  const [plan] = await q<{ id: string }>("insert into production_plans (plan_date, department_id, shift, locked_at, locked_by, snapshot, auto_locked_at) values ($1::date, $2, $3, now(), $4, $5, case when $6::boolean then now() end) returning id::text", [date, departmentId, shift, userId, snapshot, auto]);
  return plan.id;
}

export async function unlockPlan(q: Q, planId: string): Promise<void> {
  await q("update production_plans set locked_at = null, locked_by = null, snapshot = null where id = $1", [planId]);
}

export type PlanChange = { key: string; sku: string; variantId: number | null; label: string; before: number; after: number };
export type LockedPlan = { planId: string; shift: number; lockedAt: string; lockedBy: string | null; changes: PlanChange[] };

/**
 * For every locked shift: what differs now from the moment of locking. Computed by comparing the live plan
 * with the locked snapshot, so a late change cannot slip by no matter how it was made.
 */
export async function lockedPlans(q: Q, date: string, departmentId: number): Promise<LockedPlan[]> {
  const plans = await q<{ id: string; shift: number; locked_at: string; locked_by: string | null; snapshot: Snapshot | null }>(
    `select pp.id::text, pp.shift, pp.locked_at::text, u.full_name as locked_by, pp.snapshot
     from production_plans pp left join users u on u.id = pp.locked_by
     where pp.plan_date = $1::date and pp.department_id = $2 and pp.locked_at is not null order by pp.shift`,
    [date, departmentId],
  );
  if (plans.length === 0) return [];
  const live = await planRows(q, date, departmentId);
  return plans.map((p) => {
    const snap = p.snapshot ?? {};
    const now = snapshotOf(live.filter((r) => r.shift === p.shift));
    const changes: PlanChange[] = [];
    for (const k of new Set([...Object.keys(snap), ...Object.keys(now)])) {
      const before = snap[k]?.quantity ?? 0;
      const after = now[k]?.quantity ?? 0;
      if (before === after) continue;
      const [sku, variant] = k.split("|");
      changes.push({ key: k, sku, variantId: variant ? Number(variant) : null, label: now[k]?.label ?? snap[k]?.label ?? sku, before, after });
    }
    changes.sort((a, b) => a.label.localeCompare(b.label, "he"));
    return { planId: p.id, shift: p.shift, lockedAt: p.locked_at, lockedBy: p.locked_by, changes };
  });
}

/** The department confirms it saw the late changes: they are written to the change log and the locked plan catches up. */
export async function acknowledgeChanges(q: Q, date: string, departmentId: number, planId: string, userId: string): Promise<number> {
  const plan = (await lockedPlans(q, date, departmentId)).find((p) => p.planId === planId);
  if (!plan) throw new ProductionError("התוכנית הנעולה לא נמצאה.");
  if (plan.changes.length === 0) return 0;
  for (const c of plan.changes) {
    await q("insert into production_changes (plan_id, sku, variant_id, old_quantity, new_quantity, acknowledged_by, acknowledged_at) values ($1, $2, $3, $4, $5, $6, now())", [planId, c.sku, c.variantId, c.before, c.after, userId]);
  }
  const live = (await planRows(q, date, departmentId)).filter((r) => r.shift === plan.shift);
  await q("update production_plans set snapshot = $2 where id = $1", [planId, JSON.stringify(snapshotOf(live))]);
  return plan.changes.length;
}

/** True when any shift of a department that makes one of these products is locked for the date. */
export async function isLockedFor(q: Q, date: string, skus: string[]): Promise<boolean> {
  if (skus.length === 0 || !isDate(date)) return false;
  const [r] = await q<{ locked: boolean }>(
    `select exists (
       select 1 from production_plans pp
       where pp.plan_date = $1::date and pp.locked_at is not null
         and pp.department_id in (select department_id from product_ops where sku = any($2::text[]))
     ) as locked`,
    [date, skus],
  );
  return r.locked;
}

/**
 * Marks one aggregated row (a product, in a shift) as made or not made. Deliveries follow: the first made line
 * moves a delivery to "in production", and when every line that needs production is made it becomes "ready to ship".
 */
export async function markProduced(q: Q, date: string, departmentId: number, shift: number, sku: string, variantId: number | null, produced: boolean, userId: string): Promise<number> {
  if (!isDate(date)) throw new ProductionError("התאריך אינו תקין.");
  const touched = await q<{ delivery_id: string }>(
    `update delivery_lines l set produced_at = case when $6::boolean then coalesce(l.produced_at, now()) else null end,
                                 produced_by = case when $6::boolean then coalesce(l.produced_by, $7::uuid) else null end
     from deliveries d, product_ops o
     where d.id = l.delivery_id and o.sku = l.sku
       and d.delivery_date = $1::date and o.department_id = $2 and coalesce(l.shift, o.default_shift, 2) = $3
       and l.sku = $4 and l.variant_id is not distinct from $5::int
       and d.status in ('approved', 'in_production', 'ready_to_ship')
     returning l.delivery_id::text`,
    [date, departmentId, shift, sku, variantId, produced, userId],
  );
  for (const deliveryId of new Set(touched.map((t) => t.delivery_id))) {
    const [s] = await q<{ status: string; pending: number; made: number }>(
      `select d.status::text,
              count(*) filter (where o.department_id is not null and l.produced_at is null)::int as pending,
              count(*) filter (where o.department_id is not null and l.produced_at is not null)::int as made
       from deliveries d join delivery_lines l on l.delivery_id = d.id join product_ops o on o.sku = l.sku
       where d.id = $1 group by d.status`,
      [deliveryId],
    );
    const target = s.pending === 0 && s.made > 0 ? "ready_to_ship" : s.made > 0 ? "in_production" : "approved";
    if (target !== s.status) {
      await q("update deliveries set status = $2::delivery_status where id = $1", [deliveryId, target]);
      await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'delivery_status', 'delivery', $2, $3, $4)", [userId, deliveryId, JSON.stringify({ status: s.status }), JSON.stringify({ status: target, note: "לפי סימון במסך הייצור" })]);
    }
  }
  return touched.length;
}

/** Moves a product's production for one delivery date to another shift. */
export async function moveShift(q: Q, date: string, departmentId: number, fromShift: number, toShift: number, sku: string, variantId: number | null): Promise<number> {
  if (!(toShift in SHIFTS) || !(fromShift in SHIFTS)) throw new ProductionError("המשמרת אינה מוכרת.");
  if (fromShift === toShift) return 0;
  const rows = await q(
    `update delivery_lines l set shift = $4
     from deliveries d, product_ops o
     where d.id = l.delivery_id and o.sku = l.sku
       and d.delivery_date = $1::date and o.department_id = $2 and coalesce(l.shift, o.default_shift, 2) = $3
       and l.sku = $5 and l.variant_id is not distinct from $6::int
       and d.status in ('approved', 'in_production', 'ready_to_ship')
     returning l.id`,
    [date, departmentId, fromShift, toShift, sku, variantId],
  );
  return rows.length;
}

export type SourceRow = { shift: number; sku: string; variantId: number | null; orderId: string; orderNumber: number; customer: string; quantity: number; window: string | null; notes: string | null };

/** The individual orders behind the aggregated rows, with their production notes. */
export async function planSources(q: Q, date: string, departmentId: number): Promise<SourceRow[]> {
  const rows = await q<{ shift: number; sku: string; variant_id: number | null; order_id: string; number: number; customer: string; quantity: number; window: string | null; notes: string | null }>(
    `select coalesce(l.shift, o.default_shift, 2)::int as shift, l.sku, l.variant_id, ord.id::text as order_id, ord.number, c.name as customer, sum(l.quantity)::float as quantity,
            nullif(concat_ws('–', to_char(d.window_from, 'HH24:MI'), to_char(d.window_to, 'HH24:MI')), '') as window, d.production_notes as notes
     from delivery_lines l join deliveries d on d.id = l.delivery_id join orders ord on ord.id = d.order_id join customers c on c.id = ord.customer_id
     join product_ops o on o.sku = l.sku
     where d.delivery_date = $1::date and o.department_id = $2 and d.status in ('approved', 'in_production', 'ready_to_ship', 'shipped', 'delivered')
     group by coalesce(l.shift, o.default_shift, 2), l.sku, l.variant_id, ord.id, ord.number, c.name, d.window_from, d.window_to, d.production_notes
     order by d.window_from nulls last, ord.number`,
    [date, departmentId],
  );
  return rows.map((r) => ({ shift: r.shift, sku: r.sku, variantId: r.variant_id, orderId: r.order_id, orderNumber: r.number, customer: r.customer, quantity: r.quantity, window: r.window, notes: r.notes }));
}

export type LockTime = { shift: number; dayOffset: number; time: string };
export const MAX_LOCK_OFFSET = 3;

export async function lockTimes(q: Q, departmentId: number): Promise<LockTime[]> {
  const rows = await q<{ shift: number; day_offset: number; time: string }>("select shift, day_offset, to_char(lock_time, 'HH24:MI') as time from production_lock_times where department_id = $1 order by shift", [departmentId]);
  return rows.map((r) => ({ shift: r.shift, dayOffset: r.day_offset, time: r.time }));
}

/** Sets when a shift of a department locks by itself, or (with null) returns it to locking by hand only. */
export async function setLockTime(q: Q, departmentId: number, shift: number, value: { dayOffset: number; time: string } | null, userId: string): Promise<void> {
  if (!(shift in SHIFTS)) throw new ProductionError("המשמרת אינה מוכרת.");
  const [d] = await q("select 1 from departments where id = $1", [departmentId]);
  if (!d) throw new ProductionError("המחלקה לא נמצאה.");
  const [before] = await q<{ day_offset: number; time: string }>("select day_offset, to_char(lock_time, 'HH24:MI') as time from production_lock_times where department_id = $1 and shift = $2", [departmentId, shift]);
  if (value === null) {
    if (!before) return;
    await q("delete from production_lock_times where department_id = $1 and shift = $2", [departmentId, shift]);
  } else {
    if (!Number.isInteger(value.dayOffset) || value.dayOffset < 0 || value.dayOffset > MAX_LOCK_OFFSET) throw new ProductionError("יום הנעילה אינו תקין.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new ProductionError(`משמרת ${SHIFTS[shift]}: יש לבחור שעת נעילה.`);
    if (before && before.day_offset === value.dayOffset && before.time === value.time) return;
    await q(
      `insert into production_lock_times (department_id, shift, day_offset, lock_time, updated_by) values ($1, $2, $3, $4::time, $5)
       on conflict (department_id, shift) do update set day_offset = excluded.day_offset, lock_time = excluded.lock_time, updated_at = now(), updated_by = excluded.updated_by`,
      [departmentId, shift, value.dayOffset, value.time, userId],
    );
  }
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'lock_time', 'department', $2, $3, $4)", [userId, `${departmentId}:${shift}`, before ? JSON.stringify(before) : null, value ? JSON.stringify(value) : null]);
}

/**
 * Locks every plan whose lock time has passed: delivery dates from today on, for the shifts that have a lock time.
 * A plan is locked automatically once only. If a manager unlocks it afterwards it stays open until someone locks it by hand.
 * An empty plan is locked too, so that an order arriving after the lock time is reported as a late change.
 * `now` exists for tests.
 */
export async function runAutoLock(q: Q, now: string | null = null): Promise<{ date: string; departmentId: number; shift: number }[]> {
  const due = await q<{ department_id: number; shift: number; day: string }>(
    `with local as (select (coalesce($1::timestamptz, now()) at time zone 'Asia/Jerusalem') as ts)
     select t.department_id, t.shift, g.d::date::text as day
     from local
     cross join production_lock_times t
     cross join lateral generate_series(local.ts::date::timestamp, (local.ts::date + t.day_offset)::timestamp, interval '1 day') g(d)
     where (g.d::date - t.day_offset) + t.lock_time <= local.ts
       and not exists (select 1 from production_plans pp
                       where pp.plan_date = g.d::date and pp.department_id = t.department_id and pp.shift = t.shift
                         and (pp.locked_at is not null or pp.auto_locked_at is not null))
     order by day, t.department_id, t.shift`,
    [now],
  );
  const locked = [];
  for (const p of due) {
    const planId = await lockPlan(q, p.day, p.department_id, p.shift, null, true);
    await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values (null, 'auto_lock', 'production_plan', $1, $2)", [planId, JSON.stringify({ date: p.day, departmentId: p.department_id, shift: p.shift })]);
    locked.push({ date: p.day, departmentId: p.department_id, shift: p.shift });
  }
  return locked;
}
