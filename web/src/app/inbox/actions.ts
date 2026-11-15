"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { approveInbound, dismissInbound, InboundError, type ApprovalLine } from "@/lib/inbound-core";
import { syncInbound } from "@/lib/inbound";
import { OrderError } from "@/lib/orders-core";
import { QuoteError } from "@/lib/quotes-core";
import { CatalogError } from "@/lib/catalog-core";

export type InboxState = { error?: string; ok?: string };
function message(where: string, e: unknown): string {
  if (e instanceof InboundError || e instanceof OrderError || e instanceof QuoteError || e instanceof CatalogError) return e.message;
  console.error(`[${where}]`, e instanceof Error ? e.name : "error");
  return "הפעולה נכשלה. שום דבר לא נשמר.";
}
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

/** Checks the mailbox now, without waiting for the next automatic check. */
export async function checkNowAction(_prev: InboxState, _fd: FormData): Promise<InboxState> {
  await assertPermission("leads.view");
  const r = await syncInbound();
  refresh();
  if (r.error) return { error: "הבדיקה נכשלה. הסיבה מוצגת למעלה, והבדיקה הבאה תנסה שוב מאותו מקום." };
  return { ok: r.read === 0 ? "אין הודעות חדשות." : `נקראו ${r.read} הודעות חדשות: ${r.recommendations} המלצות, ${r.other} לא רלוונטיות.` };
}

/** A person approves a recommendation as it stands on the screen: the customer, the date and the ticked lines. */
export async function approveAction(_prev: InboxState, fd: FormData): Promise<InboxState> {
  const target = String(fd.get("target") ?? "");
  if (target !== "quote" && target !== "order") return { error: "יש לבחור אם לפתוח הצעת מחיר או הזמנה." };
  const user = await assertPermission(target === "quote" ? "quotes.edit" : "orders.edit");
  const id = String(fd.get("id") ?? "");
  const count = Math.min(Number(fd.get("count")) || 0, 80);
  const lines: ApprovalLine[] = [];
  for (let i = 0; i < count; i++) {
    if (fd.get(`use_${i}`) !== "on") continue;
    const sku = String(fd.get(`other_${i}`) ?? "").trim() || String(fd.get(`sku_${i}`) ?? "").trim();
    if (!sku) return { error: `שורה ${i + 1} מסומנת אבל לא נבחר לה מוצר. בוחרים מוצר, או מורידים את הסימון.` };
    lines.push({ sku, quantity: Number(String(fd.get(`qty_${i}`) ?? "").replace(",", ".")) });
  }
  let where: string;
  try {
    const r = await withTransaction((q) => approveInbound(q, id, { target, customerId: String(fd.get("customer_id") ?? ""), deliveryDate: String(fd.get("delivery_date") ?? "") || null, lines }, user.id, today()));
    where = r.quoteId ? `/quotes/${r.quoteId}` : `/orders/${r.orderId}`;
  } catch (e) {
    return { error: message("inbox approve", e) };
  }
  redirect(where);
}

export async function dismissAction(_prev: InboxState, fd: FormData): Promise<InboxState> {
  const user = await assertPermission("leads.view");
  try {
    await withTransaction((q) => dismissInbound(q, String(fd.get("id") ?? ""), String(fd.get("reason") ?? ""), user.id));
  } catch (e) {
    return { error: message("inbox dismiss", e) };
  }
  redirect("/inbox");
}
