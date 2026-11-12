// Communication management: the incoming sources of the leads and quotes inbox, and the identity
// documents are sent from. No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { isEmail } from "./mail-core.ts";

export class CommError extends Error {}

export const CHANNEL_KINDS = { email: "מייל", whatsapp: "וואטסאפ" } as const;
export type ChannelKind = keyof typeof CHANNEL_KINDS;
export const isChannelKind = (v: string): v is ChannelKind => v === "email" || v === "whatsapp";

const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};
const audit = (q: Q, userId: string, action: string, entityId: string, after: unknown) =>
  q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'communication', $3, $4)", [userId, action, entityId, JSON.stringify(after)]);

/** An Israeli phone number, mobile or landline, as digits starting with 0. Accepts +972 and separators. */
export function normalizePhone(input: string): string | null {
  let d = String(input ?? "").replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  return /^0[2-9]\d{7,8}$/.test(d) ? d : null;
}
/** 0521234567 -> 052-1234567, 026336530 -> 02-6336530. */
export const formatPhone = (d: string) => (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3)}` : `${d.slice(0, 2)}-${d.slice(2)}`);

function normalizeAddress(kind: ChannelKind, input: string): string {
  if (kind === "email") {
    const email = input.trim().toLowerCase();
    if (!isEmail(email)) throw new CommError("כתובת המייל אינה תקינה.");
    return email;
  }
  const phone = normalizePhone(input);
  if (!phone) throw new CommError("מספר הטלפון אינו תקין. יש להזין מספר ישראלי, למשל 052-1234567.");
  return phone;
}

// ---------- incoming sources

export type Channel = { id: number; kind: ChannelKind; address: string; label: string | null; active: boolean; leads: number };

export async function listChannels(q: Q): Promise<Channel[]> {
  return q<Channel>(
    `select c.id, c.kind, c.address, c.label, c.active, (select count(*)::int from leads l where l.channel_id = c.id) as leads
     from comm_channels c order by c.kind, c.active desc, c.address`,
  );
}

export async function addChannel(q: Q, input: { kind: string; address: string; label: string | null }, userId: string): Promise<number> {
  if (!isChannelKind(input.kind)) throw new CommError("יש לבחור מייל או וואטסאפ.");
  const address = normalizeAddress(input.kind, input.address);
  const label = clean(input.label);
  if (label && label.length > 80) throw new CommError("התיאור ארוך מדי (עד 80 תווים).");
  const [exists] = await q("select 1 from comm_channels where kind = $1 and address = $2", [input.kind, address]);
  if (exists) throw new CommError(input.kind === "email" ? "כתובת המייל הזו כבר ברשימה." : "המספר הזה כבר ברשימה.");
  const [row] = await q<{ id: number }>("insert into comm_channels (kind, address, label, created_by) values ($1, $2, $3, $4) returning id", [input.kind, address, label, userId]);
  await audit(q, userId, "channel_added", String(row.id), { kind: input.kind, address, label });
  return row.id;
}

/** An inactive source stays on the inquiries that arrived at it, and is no longer offered for new ones. */
export async function setChannelActive(q: Q, id: number, active: boolean, userId: string): Promise<void> {
  const rows = await q("update comm_channels set active = $2 where id = $1 and active <> $2 returning id", [id, active]);
  if (rows.length > 0) await audit(q, userId, active ? "channel_activated" : "channel_deactivated", String(id), {});
}

/** Only a source that no inquiry arrived at can be deleted; otherwise it is switched off instead. */
export async function removeChannel(q: Q, id: number, userId: string): Promise<void> {
  const [c] = await q<{ kind: string; address: string; leads: number }>("select kind, address, (select count(*)::int from leads l where l.channel_id = c.id) as leads from comm_channels c where id = $1", [id]);
  if (!c) throw new CommError("המקור לא נמצא.");
  if (c.leads > 0) throw new CommError(`${c.leads} פניות רשומות על המקור הזה, ולכן אי אפשר למחוק אותו. אפשר להפסיק להשתמש בו.`);
  await q("delete from comm_channels where id = $1", [id]);
  await audit(q, userId, "channel_removed", String(id), { kind: c.kind, address: c.address });
}

export const channelText = (c: { kind: ChannelKind; address: string; label: string | null }) => `${CHANNEL_KINDS[c.kind]} · ${c.kind === "whatsapp" ? formatPhone(c.address) : c.address}${c.label ? ` · ${c.label}` : ""}`;

/** The sources offered when an inquiry is opened. */
export async function activeChannels(q: Q): Promise<{ id: number; text: string }[]> {
  const rows = await q<{ id: number; kind: ChannelKind; address: string; label: string | null }>("select id, kind, address, label from comm_channels where active order by kind, address");
  return rows.map((r) => ({ id: r.id, text: channelText(r) }));
}

// ---------- the sender of documents

export type Outgoing = { email: string | null; emailName: string | null; whatsapp: string | null };

export async function getOutgoing(q: Q): Promise<Outgoing> {
  const [row] = await q<{ value: Partial<Outgoing> | null }>("select value from settings where key = 'comm_outgoing'");
  const v = row?.value ?? {};
  const text = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);
  return { email: text(v.email), emailName: text(v.emailName), whatsapp: text(v.whatsapp) };
}

export async function setOutgoing(q: Q, input: { email: string | null; emailName: string | null; whatsapp: string | null }, userId: string): Promise<Outgoing> {
  const email = clean(input.email) ? normalizeAddress("email", input.email!) : null;
  const whatsapp = clean(input.whatsapp) ? normalizeAddress("whatsapp", input.whatsapp!) : null;
  const emailName = clean(input.emailName);
  // The name goes into a mail header: no line breaks, quotes or angle brackets.
  if (emailName && (emailName.length > 60 || /[\r\n"<>]/.test(emailName))) throw new CommError("שם השולח יכול להכיל עד 60 תווים, בלי מירכאות ובלי סוגריים זוויתיים.");
  if (emailName && !email) throw new CommError("שם שולח נשמר רק יחד עם כתובת מייל.");
  const value: Outgoing = { email, emailName, whatsapp };
  const [before] = await q<{ value: unknown }>("select value from settings where key = 'comm_outgoing'");
  await q("insert into settings (key, value, updated_by) values ('comm_outgoing', $1, $2) on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by", [JSON.stringify(value), userId]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'outgoing_sender', 'settings', 'comm_outgoing', $2, $3)", [userId, before ? JSON.stringify(before.value) : null, JSON.stringify(value)]);
  return value;
}

/** The From and Reply-To of outgoing email, or null when no sender was chosen (the server's own default is then used). */
export function mailSender(o: Outgoing): { from: string; replyTo: string } | null {
  if (!o.email) return null;
  return { from: o.emailName ? `"${o.emailName}" <${o.email}>` : o.email, replyTo: o.email };
}
