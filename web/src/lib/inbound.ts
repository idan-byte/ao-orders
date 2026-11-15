// Runs the intake of incoming mail: reads what is new, has each message sorted, and keeps the recommendations.
// Runs from the scheduler and from the "check now" button; two runs never overlap.
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { query, systemTransaction } from "@/lib/db";
import { aiEnabled, analyzeMail } from "@/lib/inbound-ai";
import { isKnown, mailboxState, productCandidates, saveMailboxState, storeMail, customerOfSender, type Analysis, type MailboxState, type RawMail } from "@/lib/inbound-core";
import { fetchNewMail, readerConfig } from "@/lib/inbound-mail";

export type SyncResult = { read: number; recommendations: number; other: number; error: string | null };
const g = globalThis as unknown as { __aoInbound?: Promise<SyncResult> };

export type IntakeStatus = { mail: boolean; ai: boolean; mailbox: string | null; state: MailboxState | null };

export async function intakeStatus(): Promise<IntakeStatus> {
  const cfg = readerConfig();
  const mailbox = cfg ? `${cfg.user}/${cfg.mailbox}` : null;
  return { mail: !!cfg, ai: aiEnabled(), mailbox, state: mailbox ? await mailboxState(query, mailbox) : null };
}

// Outside production, a file dropped into web/.data/inbound-test is taken in as a message that was already
// sorted: { "mail": {...}, "analysis": {...} }. This is how the screens are tested without a mailbox or the AI.
async function takeTestFiles(result: SyncResult) {
  if (process.env.NODE_ENV === "production") return;
  const dir = path.join(process.cwd(), ".data", "inbound-test");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const { mail, analysis } = JSON.parse(await readFile(file, "utf8")) as { mail: RawMail; analysis: Analysis };
      const id = await systemTransaction((q) => storeMail(q, mail, analysis), (r) => r !== null);
      if (id) {
        result.read++;
        if (analysis.kind === "other") result.other++;
        else result.recommendations++;
      }
    } catch (e) {
      console.error("[inbound] test file", f, e);
    }
    await unlink(file).catch(() => {});
  }
}

async function run(): Promise<SyncResult> {
  const result: SyncResult = { read: 0, recommendations: 0, other: 0, error: null };
  await takeTestFiles(result);
  const cfg = readerConfig();
  if (!cfg || !aiEnabled()) return result;
  const mailbox = `${cfg.user}/${cfg.mailbox}`;
  let state = await mailboxState(query, mailbox);
  try {
    const fetched = await fetchNewMail(cfg, state ? { uidValidity: state.uidValidity, lastUid: state.lastUid } : null);
    let lastUid = state?.uidValidity === fetched.uidValidity ? state.lastUid : fetched.lastUid;
    for (const mail of fetched.mails) {
      if (!(await isKnown(query, mail.messageId))) {
        const customerId = await customerOfSender(query, mail.fromEmail);
        const analysis = await analyzeMail(mail, (text) => productCandidates(query, text, customerId));
        await systemTransaction((q) => storeMail(q, mail, analysis));
        result.read++;
        if (analysis.kind === "other") result.other++;
        else result.recommendations++;
      }
      // The place is saved after every message, so a failure later does not send the earlier ones to the AI again.
      lastUid = mail.uid;
      await systemTransaction((q) => saveMailboxState(q, mailbox, fetched.uidValidity, lastUid, null));
    }
    await systemTransaction((q) => saveMailboxState(q, mailbox, fetched.uidValidity, Math.max(lastUid, fetched.mails.length === 0 ? fetched.lastUid : lastUid), null));
  } catch (e) {
    // Only the kind of failure is kept and shown; a message's content never goes into the log.
    const name = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "unknown error";
    result.error = name;
    console.error("[inbound]", name);
    state = await mailboxState(query, mailbox);
    await systemTransaction((q) => saveMailboxState(q, mailbox, state?.uidValidity ?? null, state?.lastUid ?? 0, name)).catch(() => {});
  }
  return result;
}

/** Checks the mailbox now. A check that is already running is joined, not doubled. */
export function syncInbound(): Promise<SyncResult> {
  if (!g.__aoInbound) g.__aoInbound = run().finally(() => { g.__aoInbound = undefined; });
  return g.__aoInbound;
}
