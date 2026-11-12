"use server";

import { refresh } from "next/cache";
import { query, withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import type { SessionUser } from "@/lib/auth-core";
import { acknowledgeChanges, lockPlan, markProduced, moveShift, unlockPlan } from "@/lib/production-core";
import { isIsoDate } from "@/lib/production-access";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

/** The department a form refers to, forced to the user's own department when they have one. */
function target(user: SessionUser, fd: FormData): { date: string; departmentId: number } | null {
  const date = s(fd, "date");
  const departmentId = user.departmentId ?? Number(s(fd, "department_id"));
  if (!isIsoDate(date) || !Number.isInteger(departmentId)) return null;
  return { date, departmentId };
}
const variantOf = (fd: FormData) => (s(fd, "variant_id") === "" ? null : Number(s(fd, "variant_id")));

async function audit(userId: string, action: string, entityId: string, after: unknown) {
  await query("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'production_plan', $3, $4)", [userId, action, entityId, JSON.stringify(after)]);
}

export async function lockAction(fd: FormData): Promise<void> {
  const user = await assertPermission("production.lock");
  const t = target(user, fd);
  if (!t) return;
  try {
    const planId = await withTransaction((q) => lockPlan(q, t.date, t.departmentId, Number(s(fd, "shift")), user.id));
    await audit(user.id, "lock", planId, { ...t, shift: Number(s(fd, "shift")) });
  } catch {
    // Already locked by someone else: the refreshed screen shows it.
  }
  refresh();
}

export async function unlockAction(fd: FormData): Promise<void> {
  const user = await assertPermission("production.lock");
  const t = target(user, fd);
  if (!t) return;
  const [plan] = await query<{ id: string }>("select id::text from production_plans where id = $1 and plan_date = $2::date and department_id = $3", [s(fd, "plan_id"), t.date, t.departmentId]);
  if (!plan) return;
  await withTransaction((q) => unlockPlan(q, plan.id));
  await audit(user.id, "unlock", plan.id, t);
  refresh();
}

export async function acknowledgeAction(fd: FormData): Promise<void> {
  const user = await assertPermission("production.mark");
  const t = target(user, fd);
  if (!t) return;
  try {
    await withTransaction((q) => acknowledgeChanges(q, t.date, t.departmentId, s(fd, "plan_id"), user.id));
  } catch {
    // The plan was unlocked meanwhile.
  }
  refresh();
}

export async function markAction(fd: FormData): Promise<void> {
  const user = await assertPermission("production.mark");
  const t = target(user, fd);
  if (!t) return;
  await withTransaction((q) => markProduced(q, t.date, t.departmentId, Number(s(fd, "shift")), s(fd, "sku"), variantOf(fd), s(fd, "produced") === "true", user.id));
  refresh();
}

export async function moveShiftAction(fd: FormData): Promise<void> {
  const user = await assertPermission("production.lock");
  const t = target(user, fd);
  if (!t) return;
  try {
    const moved = await withTransaction((q) => moveShift(q, t.date, t.departmentId, Number(s(fd, "shift")), Number(s(fd, "to_shift")), s(fd, "sku"), variantOf(fd)));
    if (moved > 0) await audit(user.id, "move_shift", `${t.date}:${t.departmentId}`, { sku: s(fd, "sku"), from: Number(s(fd, "shift")), to: Number(s(fd, "to_shift")) });
  } catch {
    // Unknown shift value: nothing moved.
  }
  refresh();
}
