// Letterheads ("logo pages") for customer documents, and which one a quote uses. No dependency on Next.js.
import type { Q } from "./auth-core.ts";

export class LetterheadError extends Error {}

export const MAX_LOGO_BYTES = 1024 * 1024;
const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim().replace(/[ \t]+/g, " ");
  return t === "" ? null : t;
};

export type LetterheadInput = { name: string; title: string; subtitle: string | null; footer: string | null };
export type Letterhead = { id: number; name: string; title: string; subtitle: string | null; footer: string | null; hasLogo: boolean; logoVersion: string | null; isDefault: boolean; active: boolean; quotes: number };

export async function listLetterheads(q: Q): Promise<Letterhead[]> {
  const rows = await q<{ id: number; name: string; title: string; subtitle: string | null; footer: string | null; has_logo: boolean; logo_version: string | null; is_default: boolean; active: boolean; quotes: number }>(
    `select l.id, l.name, l.title, l.subtitle, l.footer, l.logo is not null as has_logo, extract(epoch from l.logo_updated_at)::bigint::text as logo_version, l.is_default, l.active,
            (select count(*)::int from quotes qt where qt.letterhead_id = l.id) as quotes
     from letterheads l order by l.is_default desc, l.active desc, l.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, title: r.title, subtitle: r.subtitle, footer: r.footer, hasLogo: r.has_logo, logoVersion: r.logo_version, isDefault: r.is_default, active: r.active, quotes: r.quotes }));
}

export async function saveLetterhead(q: Q, id: number | null, input: LetterheadInput, userId: string): Promise<number> {
  const name = clean(input.name);
  const title = clean(input.title);
  if (!name || name.length < 2) throw new LetterheadError("יש לתת שם לדף הלוגו.");
  if (name.length > 40) throw new LetterheadError("השם ארוך מדי (עד 40 תווים).");
  if (!title) throw new LetterheadError("יש למלא את שם העסק כפי שיופיע במסמך.");
  const [clash] = await q("select 1 from letterheads where name = $1 and id is distinct from $2::int", [name, id]);
  if (clash) throw new LetterheadError("כבר קיים דף לוגו בשם הזה.");
  let saved: number;
  if (id === null) {
    const [row] = await q<{ id: number }>("insert into letterheads (name, title, subtitle, footer) values ($1, $2, $3, $4) returning id", [name, title, clean(input.subtitle), clean(input.footer)]);
    saved = row.id;
  } else {
    const rows = await q("update letterheads set name = $2, title = $3, subtitle = $4, footer = $5 where id = $1 returning id", [id, name, title, clean(input.subtitle), clean(input.footer)]);
    if (rows.length === 0) throw new LetterheadError("דף הלוגו לא נמצא.");
    saved = id;
  }
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'letterhead', $3, $4)", [userId, id === null ? "create_letterhead" : "update_letterhead", String(saved), JSON.stringify({ name, title })]);
  return saved;
}

/** The file type is decided by the file's first bytes, not by what the browser claims. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => bytes[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

export async function setLogo(q: Q, id: number, bytes: Uint8Array | null, userId: string): Promise<void> {
  let mime: string | null = null;
  if (bytes !== null) {
    if (bytes.length === 0) throw new LetterheadError("יש לבחור קובץ תמונה.");
    if (bytes.length > MAX_LOGO_BYTES) throw new LetterheadError("הקובץ גדול מדי. הגודל המרבי הוא 1MB.");
    mime = sniffImage(bytes);
    if (!mime) throw new LetterheadError("הקובץ אינו תמונה מסוג PNG, JPG או WebP.");
  }
  const rows = await q("update letterheads set logo = $2, logo_mime = $3, logo_updated_at = now() where id = $1 returning id", [id, bytes, mime]);
  if (rows.length === 0) throw new LetterheadError("דף הלוגו לא נמצא.");
  await q("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'letterhead', $3, $4)", [userId, bytes ? "set_logo" : "remove_logo", String(id), JSON.stringify({ mime, bytes: bytes?.length ?? 0 })]);
}

export async function getLogo(q: Q, id: number): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const [r] = await q<{ logo: Uint8Array | null; logo_mime: string | null }>("select logo, logo_mime from letterheads where id = $1", [id]);
  return r?.logo && r.logo_mime ? { bytes: r.logo, mime: r.logo_mime } : null;
}

export async function setDefault(q: Q, id: number): Promise<void> {
  const [l] = await q<{ active: boolean }>("select active from letterheads where id = $1", [id]);
  if (!l) throw new LetterheadError("דף הלוגו לא נמצא.");
  if (!l.active) throw new LetterheadError("דף לוגו שאינו בשימוש אינו יכול להיות ברירת המחדל.");
  await q("update letterheads set is_default = false where is_default and id <> $1", [id]);
  await q("update letterheads set is_default = true where id = $1", [id]);
}

/** A letterhead is never deleted, because quotes refer to it. Switching it off only removes it from the choice list. */
export async function setActive(q: Q, id: number, active: boolean): Promise<void> {
  const [l] = await q<{ is_default: boolean }>("select is_default from letterheads where id = $1", [id]);
  if (!l) throw new LetterheadError("דף הלוגו לא נמצא.");
  if (!active && l.is_default) throw new LetterheadError("זה דף ברירת המחדל. יש לקבוע קודם דף אחר כברירת מחדל.");
  await q("update letterheads set active = $2 where id = $1", [id, active]);
}

/** Chooses the letterhead of a quote; null returns it to the default. */
export async function setQuoteLetterhead(q: Q, quoteId: string, letterheadId: number | null, userId: string): Promise<void> {
  const [quote] = await q<{ status: string; letterhead_id: number | null }>("select status::text, letterhead_id from quotes where id = $1", [quoteId]);
  if (!quote) throw new LetterheadError("ההצעה לא נמצאה.");
  if (quote.status === "approved" || quote.status === "rejected") throw new LetterheadError("ההצעה סגורה, ואי אפשר לשנות את דף הלוגו שלה.");
  if (letterheadId !== null) {
    const [l] = await q<{ active: boolean }>("select active from letterheads where id = $1", [letterheadId]);
    if (!l) throw new LetterheadError("דף הלוגו לא נמצא.");
    if (!l.active && letterheadId !== quote.letterhead_id) throw new LetterheadError("דף הלוגו שנבחר אינו בשימוש.");
  }
  if (letterheadId === quote.letterhead_id) return;
  await q("update quotes set letterhead_id = $2 where id = $1", [quoteId, letterheadId]);
  await q("insert into audit_log (user_id, action, entity_type, entity_id, before, after) values ($1, 'quote_letterhead', 'quote', $2, $3, $4)", [userId, quoteId, JSON.stringify({ letterheadId: quote.letterhead_id }), JSON.stringify({ letterheadId })]);
}
