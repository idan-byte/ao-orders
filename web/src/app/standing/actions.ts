"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { query, withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { generateStanding, saveStanding, setClosedDay, setPause, setSkip, StandingError, type StandingInput } from "@/lib/standing-core";

export type StandingState = { error?: string; ok?: string };
const message = (e: unknown) => (e instanceof StandingError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export async function saveStandingAction(_prev: StandingState, fd: FormData): Promise<StandingState> {
  const user = await assertPermission("orders.edit");
  const id = isUuid(s(fd, "standing_id")) ? s(fd, "standing_id") : null;
  let input: StandingInput;
  try {
    const p = JSON.parse(s(fd, "payload")) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
    const rows = Array.isArray(p.rows) ? (p.rows as { sku?: unknown; qty?: unknown }[]) : [];
    input = {
      customerId: s(fd, "customer_id"),
      addressId: str(p.addressId),
      windowFrom: str(p.windowFrom),
      windowTo: str(p.windowTo),
      validFrom: str(p.validFrom) ?? "",
      validTo: str(p.validTo),
      productionNotes: str(p.productionNotes),
      shippingNotes: str(p.shippingNotes),
      lines: rows.flatMap((r) => (Array.isArray(r.qty) ? r.qty : []).map((q, weekday) => ({ weekday, sku: String(r.sku ?? ""), quantity: Number(q) || 0 }))).filter((l) => l.sku && l.quantity > 0),
    };
  } catch {
    return { error: "הנתונים שנשלחו אינם תקינים." };
  }
  let saved: string;
  try {
    saved = await withTransaction((q) => saveStanding(q, id, input, user.id));
  } catch (e) {
    return { error: message(e) };
  }
  if (!id) redirect(`/standing/${saved}`);
  refresh();
  return { ok: "ההזמנה הקבועה נשמרה. הזמנות שכבר נוצרו ממנה לא השתנו." };
}

export async function skipDayAction(_prev: StandingState, fd: FormData): Promise<StandingState> {
  await assertPermission("orders.edit");
  try {
    await withTransaction((q) => setSkip(q, s(fd, "standing_id"), s(fd, "day"), true, s(fd, "reason")));
    refresh();
    return { ok: "היום סומן לדילוג." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function restoreDayAction(fd: FormData): Promise<void> {
  await assertPermission("orders.edit");
  try {
    await withTransaction((q) => setSkip(q, s(fd, "standing_id"), s(fd, "day"), false, null));
  } catch {
    // The day already has an order; the refreshed screen shows it.
  }
  refresh();
}

export async function pauseAction(_prev: StandingState, fd: FormData): Promise<StandingState> {
  await assertPermission("orders.edit");
  try {
    await withTransaction((q) => setPause(q, s(fd, "standing_id"), s(fd, "until") || null));
    refresh();
    return { ok: s(fd, "until") ? "ההזמנה הקבועה הושהתה." : "ההשהיה בוטלה." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function generateAction(_prev: StandingState, fd: FormData): Promise<StandingState> {
  const user = await assertPermission("orders.edit");
  const from = s(fd, "from");
  const to = s(fd, "to");
  const [t] = await query<{ today: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today");
  if (from < t.today) return { error: "אי אפשר ליצור הזמנות לתאריך שעבר." };
  try {
    const r = await withTransaction((q) => generateStanding(q, from, to, user.id));
    refresh();
    const parts = [`נוצרו ${r.created} הזמנות.`];
    if (r.skipped.existing) parts.push(`${r.skipped.existing} כבר היו קיימות.`);
    if (r.skipped.closed) parts.push(`${r.skipped.closed} דולגו בגלל יום סגור.`);
    if (r.skipped.paused) parts.push(`${r.skipped.paused} דולגו בגלל השהיה.`);
    if (r.skipped.excluded) parts.push(`${r.skipped.excluded} דולגו לפי סימון ללקוח.`);
    return { ok: parts.join(" ") };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function closedDayAction(_prev: StandingState, fd: FormData): Promise<StandingState> {
  await assertPermission("orders.edit");
  try {
    await withTransaction((q) => setClosedDay(q, s(fd, "day"), s(fd, "reason")));
    refresh();
    return { ok: "היום נוסף." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function removeClosedDayAction(fd: FormData): Promise<void> {
  await assertPermission("orders.edit");
  try {
    await withTransaction((q) => setClosedDay(q, s(fd, "day"), null));
  } catch {
    // Bad date: nothing to remove.
  }
  refresh();
}
