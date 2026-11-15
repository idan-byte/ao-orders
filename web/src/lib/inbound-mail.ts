// Reads new messages from the mailbox over IMAP. The mailbox is opened read-only: nothing is marked as read,
// moved or deleted. Reading is off until INBOUND_MAIL_ENABLED=1 is set.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { RawMail } from "./inbound-core.ts";

export type ReaderConfig = { host: string; port: number; user: string; pass: string; mailbox: string };

/** The mailbox to read, or null when reading is switched off or not fully configured. */
export function readerConfig(): ReaderConfig | null {
  if (process.env.INBOUND_MAIL_ENABLED !== "1") return null;
  const user = process.env.INBOUND_IMAP_USER || process.env.SMTP_USER;
  const pass = process.env.INBOUND_IMAP_PASSWORD || process.env.SMTP_PASSWORD;
  const host = process.env.INBOUND_IMAP_HOST || (process.env.SMTP_HOST === "smtp.gmail.com" ? "imap.gmail.com" : "");
  if (!user || !pass || !host) return null;
  return { host, port: Number(process.env.INBOUND_IMAP_PORT) || 993, user, pass, mailbox: process.env.INBOUND_IMAP_MAILBOX || "INBOX" };
}

export type Fetched = { uidValidity: number; lastUid: number; mails: (RawMail & { uid: number })[] };

const MAX_SOURCE = 5 * 1024 * 1024;

/**
 * The messages that arrived after the last one read, oldest first, at most `max` of them.
 * The first time a mailbox is read (or after the server renumbered it) nothing is taken: reading starts from
 * the messages that arrive from then on.
 */
export async function fetchNewMail(cfg: ReaderConfig, known: { uidValidity: number | null; lastUid: number } | null, max = 25): Promise<Fetched> {
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.mailbox, { readOnly: true });
    try {
      const box = client.mailbox;
      if (!box) throw new Error("the mailbox could not be opened");
      const uidValidity = Number(box.uidValidity);
      const newest = box.uidNext - 1;
      if (!known || known.uidValidity !== uidValidity) return { uidValidity, lastUid: newest, mails: [] };
      if (newest <= known.lastUid) return { uidValidity, lastUid: known.lastUid, mails: [] };

      const heads = await client.fetchAll(`${known.lastUid + 1}:*`, { uid: true, size: true }, { uid: true });
      const todo = heads.filter((h) => h.uid > known.lastUid).sort((a, b) => a.uid - b.uid).slice(0, max);
      const mails: Fetched["mails"] = [];
      let lastUid = known.lastUid;
      for (const h of todo) {
        lastUid = h.uid;
        if ((h.size ?? 0) > MAX_SOURCE) continue; // a very large message is skipped, not half-read
        const full = await client.fetchOne(String(h.uid), { uid: true, source: true }, { uid: true });
        if (!full || !full.source) continue;
        const parsed = await simpleParser(full.source);
        const from = parsed.from?.value?.[0];
        const fromEmail = (from?.address ?? "").toLowerCase();
        if (!fromEmail || fromEmail === cfg.user.toLowerCase()) continue; // our own messages are not incoming mail
        mails.push({
          uid: h.uid,
          mailbox: `${cfg.user}/${cfg.mailbox}`,
          messageId: parsed.messageId || `${uidValidity}-${h.uid}@${cfg.host}`,
          fromEmail,
          fromName: from?.name?.trim() || null,
          subject: parsed.subject ?? "",
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          body: (parsed.text ?? "").replace(/\r/g, "").trim(),
          attachments: (parsed.attachments ?? []).map((a) => ({ name: a.filename ?? "קובץ בלי שם", size: a.size ?? 0 })),
        });
      }
      return { uidValidity, lastUid, mails };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
