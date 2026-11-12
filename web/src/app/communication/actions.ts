"use server";

import { refresh } from "next/cache";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { addChannel, CommError, removeChannel, setChannelActive, setOutgoing } from "@/lib/comm-core";

export type CommState = { error?: string; ok?: string };
const message = (e: unknown) => (e instanceof CommError ? e.message : "הפעולה נכשלה. שום דבר לא נשמר.");
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const idOf = (fd: FormData) => (/^\d{1,9}$/.test(s(fd, "channel_id")) ? Number(s(fd, "channel_id")) : null);

export async function addChannelAction(_prev: CommState, fd: FormData): Promise<CommState> {
  const user = await assertPermission("settings.manage");
  try {
    await withTransaction((q) => addChannel(q, { kind: s(fd, "kind"), address: s(fd, "address"), label: s(fd, "label") }, user.id));
    refresh();
    return { ok: "המקור נוסף." };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function channelCommandAction(_prev: CommState, fd: FormData): Promise<CommState> {
  const user = await assertPermission("settings.manage");
  const id = idOf(fd);
  const command = s(fd, "command");
  if (id === null) return { error: "המקור לא נמצא." };
  try {
    await withTransaction(async (q) => {
      if (command === "remove") await removeChannel(q, id, user.id);
      else await setChannelActive(q, id, command === "activate", user.id);
    });
    refresh();
    return {};
  } catch (e) {
    return { error: message(e) };
  }
}

export async function outgoingAction(_prev: CommState, fd: FormData): Promise<CommState> {
  const user = await assertPermission("settings.manage");
  try {
    await withTransaction((q) => setOutgoing(q, { email: s(fd, "email"), emailName: s(fd, "email_name"), whatsapp: s(fd, "whatsapp") }, user.id));
    refresh();
    return { ok: "פרטי השולח נשמרו." };
  } catch (e) {
    return { error: message(e) };
  }
}
