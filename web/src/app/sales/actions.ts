"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { addActivity, addTask, closeLead, completeTask, convertLeadToCustomer, createLead, CrmError, setFollowUp, type ActivityKind } from "@/lib/crm-core";

export type CrmActionState = { error?: string; ok?: string };
const message = (e: unknown) => (e instanceof CrmError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function createLeadAction(_prev: CrmActionState, fd: FormData): Promise<CrmActionState> {
  const user = await assertPermission("leads.edit");
  let leadId: string;
  try {
    leadId = await withTransaction((q) =>
      createLead(q, { customerId: s(fd, "customer_id") || null, contactName: s(fd, "contact_name"), contactPhone: s(fd, "contact_phone"), source: s(fd, "source"), summary: s(fd, "summary"), ownerId: user.id, followUpDate: s(fd, "follow_up") || null, channelId: /^\d{1,9}$/.test(s(fd, "channel_id")) ? Number(s(fd, "channel_id")) : null }),
    );
  } catch (e) {
    return { error: message(e) };
  }
  redirect(`/sales/${leadId}`);
}

export async function followUpAction(fd: FormData): Promise<void> {
  await assertPermission("leads.edit");
  try {
    await withTransaction((q) => setFollowUp(q, s(fd, "lead_id"), s(fd, "on") === "true"));
  } catch {
    // A closed lead simply stays as it is; the refreshed screen shows its real state.
  }
  refresh();
}

export async function closeLeadAction(_prev: CrmActionState, fd: FormData): Promise<CrmActionState> {
  const user = await assertPermission("leads.edit");
  try {
    await withTransaction((q) => closeLead(q, s(fd, "lead_id"), s(fd, "reason"), user.id));
    refresh();
    return { ok: "הפנייה נסגרה." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function convertLeadAction(_prev: CrmActionState, fd: FormData): Promise<CrmActionState> {
  const user = await assertPermission("leads.edit");
  try {
    await withTransaction((q) => convertLeadToCustomer(q, s(fd, "lead_id"), user.id));
    refresh();
    return { ok: "נפתח כרטיס לקוח. אפשר לפתוח הצעת מחיר." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function addActivityAction(_prev: CrmActionState, fd: FormData): Promise<CrmActionState> {
  const user = await assertPermission("leads.edit");
  const kind = s(fd, "kind") as ActivityKind;
  if (kind === "system") return { error: "סוג הפעילות אינו מוכר." };
  try {
    await withTransaction((q) => addActivity(q, { leadId: s(fd, "lead_id") || null, customerId: s(fd, "customer_id") || null, kind, body: s(fd, "body"), userId: user.id }));
    refresh();
    return { ok: "נרשם." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function addTaskAction(_prev: CrmActionState, fd: FormData): Promise<CrmActionState> {
  const user = await assertPermission("leads.edit");
  try {
    await withTransaction((q) => addTask(q, { leadId: s(fd, "lead_id") || null, customerId: s(fd, "customer_id") || null, title: s(fd, "title"), dueDate: s(fd, "due_date"), ownerId: user.id, createdBy: user.id }));
    refresh();
    return { ok: "המשימה נוספה." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function completeTaskAction(fd: FormData): Promise<void> {
  await assertPermission("leads.edit");
  await withTransaction((q) => completeTask(q, s(fd, "task_id")));
  refresh();
}
