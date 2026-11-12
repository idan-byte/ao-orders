"use server";

import { refresh } from "next/cache";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { LetterheadError, MAX_LOGO_BYTES, saveLetterhead, setActive, setDefault, setLogo, setQuoteLetterhead } from "@/lib/letterheads-core";

export type LetterheadState = { error?: string; ok?: string };
const message = (e: unknown) => (e instanceof LetterheadError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const idOf = (fd: FormData) => (/^\d+$/.test(s(fd, "letterhead_id")) ? Number(s(fd, "letterhead_id")) : null);

export async function saveLetterheadAction(_prev: LetterheadState, fd: FormData): Promise<LetterheadState> {
  const user = await assertPermission("settings.manage");
  const id = idOf(fd);
  try {
    await withTransaction((q) => saveLetterhead(q, id, { name: s(fd, "name"), title: s(fd, "title"), subtitle: s(fd, "subtitle"), footer: s(fd, "footer") }, user.id));
    refresh();
    return { ok: id === null ? "דף הלוגו נוסף. עכשיו אפשר להעלות לו תמונת לוגו." : "הפרטים נשמרו." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function uploadLogoAction(_prev: LetterheadState, fd: FormData): Promise<LetterheadState> {
  const user = await assertPermission("settings.manage");
  const id = idOf(fd);
  const file = fd.get("logo");
  if (id === null) return { error: "דף הלוגו לא נמצא." };
  if (!(file instanceof File) || file.size === 0) return { error: "יש לבחור קובץ תמונה." };
  if (file.size > MAX_LOGO_BYTES) return { error: "הקובץ גדול מדי. הגודל המרבי הוא 1MB." };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await withTransaction((q) => setLogo(q, id, bytes, user.id));
    refresh();
    return { ok: "הלוגו הועלה." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function letterheadCommandAction(_prev: LetterheadState, fd: FormData): Promise<LetterheadState> {
  const user = await assertPermission("settings.manage");
  const id = idOf(fd);
  if (id === null) return { error: "דף הלוגו לא נמצא." };
  const command = s(fd, "command");
  try {
    await withTransaction(async (q) => {
      if (command === "default") await setDefault(q, id);
      else if (command === "deactivate") await setActive(q, id, false);
      else if (command === "activate") await setActive(q, id, true);
      else if (command === "remove_logo") await setLogo(q, id, null, user.id);
    });
    refresh();
    return {};
  } catch (e) {
    return { error: message(e) };
  }
}

export async function setQuoteLetterheadAction(_prev: LetterheadState, fd: FormData): Promise<LetterheadState> {
  const user = await assertPermission("quotes.edit");
  try {
    await withTransaction((q) => setQuoteLetterhead(q, s(fd, "quote_id"), idOf(fd), user.id));
    refresh();
    return { ok: "דף הלוגו של ההצעה עודכן." };
  } catch (e) {
    return { error: message(e) };
  }
}
