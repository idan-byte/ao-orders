// CRM logic: leads, follow-up tasks and the activity log. No dependency on Next.js.
import type { Q } from "./auth-core.ts";

export const LEAD_STAGES = ["new", "quote_in_progress", "sent", "follow_up", "won", "lost"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  new: "פנייה חדשה",
  quote_in_progress: "הצעה בהכנה",
  sent: "נשלחה",
  follow_up: "במעקב",
  won: "אושרה",
  lost: "נדחתה",
};
export const LEAD_SOURCES = ["טלפון", "מייל", "וואטסאפ", "אתר", "הפניה", "אחר"];
export const ACTIVITY_KINDS = { call: "שיחה", email: "מייל", message: "הודעה", note: "הערה", system: "מערכת" } as const;
export type ActivityKind = keyof typeof ACTIVITY_KINDS;

export class CrmError extends Error {}

const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};
const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isUuid = (s: string | null | undefined): s is string => !!s && /^[0-9a-f-]{36}$/i.test(s);

export type NewLead = {
  customerId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  source: string;
  summary: string;
  ownerId: string;
  followUpDate?: string | null;
  /** The incoming source (mailbox or WhatsApp number) the inquiry arrived at, when it is known. */
  channelId?: number | null;
};

/** A lead belongs either to an existing customer or to a named person who is not a customer yet. */
export async function createLead(q: Q, input: NewLead): Promise<string> {
  const summary = clean(input.summary);
  const contactName = clean(input.contactName);
  if (!summary) throw new CrmError("יש לתאר את הפנייה.");
  if (!LEAD_SOURCES.includes(input.source)) throw new CrmError("יש לבחור את מקור הפנייה.");
  if (!isUuid(input.customerId) && !contactName) throw new CrmError("יש לבחור לקוח קיים או להזין את שם הפונה.");
  if (input.followUpDate && !isDate(input.followUpDate)) throw new CrmError("תאריך המעקב אינו תקין.");
  if (isUuid(input.customerId)) {
    const [c] = await q("select 1 from customers where id = $1 and active", [input.customerId]);
    if (!c) throw new CrmError("הלקוח לא נמצא.");
  }
  const channelId = input.channelId ?? null;
  if (channelId !== null) {
    const [ch] = await q("select 1 from comm_channels where id = $1 and active", [channelId]);
    if (!ch) throw new CrmError("מקור הקליטה שנבחר אינו פעיל.");
  }
  const [lead] = await q<{ id: string }>(
    "insert into leads (customer_id, contact_name, contact_phone, source, summary, owner_id, channel_id) values ($1, $2, $3, $4, $5, $6, $7) returning id::text",
    [isUuid(input.customerId) ? input.customerId : null, contactName, clean(input.contactPhone), input.source, summary, input.ownerId, channelId],
  );
  await addActivity(q, { leadId: lead.id, customerId: isUuid(input.customerId) ? input.customerId : null, kind: "system", body: `פנייה נפתחה (${input.source})`, userId: input.ownerId });
  if (input.followUpDate) await addTask(q, { leadId: lead.id, title: "לחזור לפונה", dueDate: input.followUpDate, ownerId: input.ownerId, createdBy: input.ownerId });
  return lead.id;
}

export async function getLeadStage(q: Q, leadId: string): Promise<LeadStage | null> {
  const [r] = await q<{ stage: LeadStage }>("select stage from lead_board where id = $1", [leadId]);
  return r?.stage ?? null;
}

/** Marks an open lead as "in follow-up" or back to its natural stage. Closed leads are not touched. */
export async function setFollowUp(q: Q, leadId: string, on: boolean): Promise<void> {
  const stage = await getLeadStage(q, leadId);
  if (!stage) throw new CrmError("הפנייה לא נמצאה.");
  if (stage === "won" || stage === "lost") throw new CrmError("הפנייה כבר נסגרה.");
  await q("update leads set stage = $2 where id = $1", [leadId, on ? "follow_up" : "new"]);
}

/** Closes a lead that will not turn into an order. A lead whose quote was approved cannot be closed as lost. */
export async function closeLead(q: Q, leadId: string, reason: string, userId: string): Promise<void> {
  const stage = await getLeadStage(q, leadId);
  if (!stage) throw new CrmError("הפנייה לא נמצאה.");
  if (stage === "won") throw new CrmError("ההצעה של הפנייה הזו אושרה, ולכן אי אפשר לסגור אותה כנדחתה.");
  if (!clean(reason)) throw new CrmError("יש לבחור סיבה.");
  await q("update leads set stage = 'lost', lost_reason = $2, closed_at = now() where id = $1", [leadId, reason.trim()]);
  await q("update tasks set done_at = now() where lead_id = $1 and done_at is null", [leadId]);
  await addActivity(q, { leadId, kind: "system", body: `הפנייה נסגרה: ${reason.trim()}`, userId });
}

/** Turns the person behind a lead into a customer, so a quote can be opened. The customer is not yet linked to Hashavshevet. */
export async function convertLeadToCustomer(q: Q, leadId: string, userId: string): Promise<string> {
  const [lead] = await q<{ customer_id: string | null; contact_name: string | null; contact_phone: string | null }>("select customer_id::text, contact_name, contact_phone from leads where id = $1", [leadId]);
  if (!lead) throw new CrmError("הפנייה לא נמצאה.");
  if (lead.customer_id) return lead.customer_id;
  if (!lead.contact_name) throw new CrmError("לפנייה אין שם פונה.");
  const [customer] = await q<{ id: string }>("insert into customers (name) values ($1) returning id::text", [lead.contact_name]);
  if (lead.contact_phone) await q("insert into customer_contacts (customer_id, full_name, phone) values ($1, $2, $3)", [customer.id, lead.contact_name, lead.contact_phone]);
  await q("update leads set customer_id = $2 where id = $1", [leadId, customer.id]);
  await q("update activities set customer_id = $2 where lead_id = $1 and customer_id is null", [leadId, customer.id]);
  await q("update tasks set customer_id = $2 where lead_id = $1 and customer_id is null", [leadId, customer.id]);
  await addActivity(q, { leadId, customerId: customer.id, kind: "system", body: "נפתח כרטיס לקוח מהפנייה", userId });
  return customer.id;
}

export type NewActivity = { leadId?: string | null; customerId?: string | null; kind: ActivityKind; body: string; userId?: string | null; entityType?: string | null; entityId?: string | null };

export async function addActivity(q: Q, a: NewActivity): Promise<void> {
  const body = clean(a.body);
  if (!body) throw new CrmError("יש לכתוב מה היה.");
  if (!Object.hasOwn(ACTIVITY_KINDS, a.kind)) throw new CrmError("סוג הפעילות אינו מוכר.");
  let customerId = isUuid(a.customerId) ? a.customerId : null;
  const leadId = isUuid(a.leadId) ? a.leadId : null;
  if (!customerId && !leadId) throw new CrmError("פעילות חייבת להיות משויכת ללקוח או לפנייה.");
  if (!customerId && leadId) {
    const [l] = await q<{ customer_id: string | null }>("select customer_id::text from leads where id = $1", [leadId]);
    if (!l) throw new CrmError("הפנייה לא נמצאה.");
    customerId = l.customer_id;
  }
  await q("insert into activities (customer_id, lead_id, kind, body, entity_type, entity_id, user_id) values ($1, $2, $3, $4, $5, $6, $7)", [customerId, leadId, a.kind, body, a.entityType ?? null, a.entityId ?? null, a.userId ?? null]);
}

export type NewTask = { leadId?: string | null; customerId?: string | null; title: string; dueDate: string; ownerId: string; createdBy: string };

export async function addTask(q: Q, t: NewTask): Promise<string> {
  const title = clean(t.title);
  if (!title) throw new CrmError("יש לכתוב מה צריך לעשות.");
  if (!isDate(t.dueDate)) throw new CrmError("יש לבחור תאריך למשימה.");
  let customerId = isUuid(t.customerId) ? t.customerId : null;
  const leadId = isUuid(t.leadId) ? t.leadId : null;
  if (!customerId && !leadId) throw new CrmError("משימה חייבת להיות משויכת ללקוח או לפנייה.");
  if (!customerId && leadId) {
    const [l] = await q<{ customer_id: string | null }>("select customer_id::text from leads where id = $1", [leadId]);
    customerId = l?.customer_id ?? null;
  }
  const [row] = await q<{ id: string }>("insert into tasks (customer_id, lead_id, title, due_date, owner_id, created_by) values ($1, $2, $3, $4::date, $5, $6) returning id::text", [customerId, leadId, title, t.dueDate, t.ownerId, t.createdBy]);
  return row.id;
}

export async function completeTask(q: Q, taskId: string): Promise<boolean> {
  const rows = await q("update tasks set done_at = now() where id = $1 and done_at is null returning id", [taskId]);
  return rows.length > 0;
}

/** Records a quote event on the customer's timeline, and on the lead when the quote came from one. */
export async function logQuoteEvent(q: Q, quoteId: string, body: string, userId: string | null): Promise<void> {
  const [qt] = await q<{ customer_id: string; lead_id: string | null }>("select customer_id::text, lead_id::text from quotes where id = $1", [quoteId]);
  if (!qt) return;
  await addActivity(q, { customerId: qt.customer_id, leadId: qt.lead_id, kind: "system", body, userId, entityType: "quote", entityId: quoteId });
}
