import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getInbound, KIND_LABEL } from "@/lib/inbound-core";
import { ActionForm } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { approveAction, dismissAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";
const stamp = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// One incoming message with the recommendation made from it. A person corrects it and approves, or dismisses it.
export default function InboundPage({ params }: PageProps<"/inbox/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Inbound params={params} />
    </Suspense>
  );
}

async function Inbound({ params }: Pick<PageProps<"/inbox/[id]">, "params">) {
  const { user, allowed } = await requirePermission("leads.view");
  if (!allowed) return <NoAccess />;
  const mail = await getInbound(query, (await params).id);
  if (!mail || mail.kind === "other") {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">ההודעה לא נמצאה</h1>
        <Link href="/inbox" className={small}>
          חזרה לדואר הנכנס
        </Link>
      </div>
    );
  }
  const canQuote = can(user.role, "quotes.edit"), canOrder = can(user.role, "orders.edit");
  const open = mail.status === "new" && (canQuote || canOrder);
  const customers = open ? await query<{ id: string; name: string }>("select id::text, name from customers where active order by name") : [];
  const items = mail.analysis?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">{mail.subject || "(בלי נושא)"}</h1>
        <Link href="/inbox" className={small}>
          דואר נכנס
        </Link>
      </div>
      <p className="text-muted" id="inbound-head">
        {KIND_LABEL[mail.kind]} · {mail.fromName ? `${mail.fromName} · ` : ""}
        <span dir="ltr">{mail.fromEmail}</span> · {stamp.format(new Date(mail.receivedAt))}
      </p>

      {mail.status !== "new" ? (
        <section className={`${panel} border-2`} id="inbound-done" data-status={mail.status}>
          {mail.status === "approved" ? (
            <p>
              ההמלצה אושרה{mail.handledBy ? ` על ידי ${mail.handledBy}` : ""}
              {mail.handledAt ? ` ב-${stamp.format(new Date(mail.handledAt))}` : ""}.{" "}
              {mail.quoteId ? (
                <Link href={`/quotes/${mail.quoteId}`} className="underline">
                  הצעת מחיר {mail.quoteNumber}
                </Link>
              ) : null}
              {mail.orderId ? (
                <Link href={`/orders/${mail.orderId}`} className="underline">
                  הזמנה {mail.orderNumber}
                </Link>
              ) : null}
            </p>
          ) : (
            <p>
              ההמלצה נדחתה{mail.handledBy ? ` על ידי ${mail.handledBy}` : ""}
              {mail.dismissReason ? `: ${mail.dismissReason}` : "."}
            </p>
          )}
        </section>
      ) : null}

      <section className={panel} id="inbound-mail">
        <h2 className="mb-2 font-display text-lg font-bold">ההודעה</h2>
        <p className="whitespace-pre-line" dir="auto">
          {mail.body || "להודעה אין תוכן טקסט."}
        </p>
        {mail.attachments.length > 0 ? (
          <p className="mt-3 text-sm font-bold" id="inbound-attachments">
            קבצים מצורפים (לא נקראו, יש לפתוח אותם בתיבת הדואר): <span dir="auto">{mail.attachments.map((a) => a.name).join(", ")}</span>
          </p>
        ) : null}
      </section>

      <section className={panel} id="inbound-recommendation">
        <h2 className="font-display text-lg font-bold">ההמלצה</h2>
        {mail.analysis?.summary ? <p className="mt-1">{mail.analysis.summary}</p> : null}
        {mail.analysis?.deliveryNote ? <p className="mt-1 text-sm">פרטי אספקה מההודעה: {mail.analysis.deliveryNote}</p> : null}
        <p className="mb-3 mt-1 text-sm text-muted">ההמלצה נוצרה ב-AI מתוך ההודעה ויכולה לטעות. המחירים אינם מההודעה ואינם מה-AI: כל שורה מתומחרת לפי הסכם המחיר של הלקוח, ואם אין, לפי מחיר הבסיס. שורה בלי סימון לא נכנסת למסמך.</p>

        {open ? (
          <ActionForm action={approveAction} submit="אשר וצור מסמך" pendingLabel="יוצר…" keep className="flex flex-col items-start gap-4">
            <input type="hidden" name="id" value={mail.id} />
            <input type="hidden" name="count" value={items.length} />
            <div className="flex flex-wrap gap-3">
              <CustomerPicker customers={customers} defaultValue={mail.customerId ?? ""} allowNew={canQuote} />
              <label className={label}>
                מה לפתוח
                <select name="target" defaultValue={mail.kind === "order" && canOrder ? "order" : canQuote ? "quote" : "order"} className={field}>
                  {canQuote ? <option value="quote">טיוטת הצעת מחיר</option> : null}
                  {canOrder ? <option value="order">הזמנה</option> : null}
                </select>
              </label>
              <label className={label}>
                תאריך אספקה
                <input name="delivery_date" type="date" defaultValue={mail.analysis?.deliveryDate ?? ""} className={field} />
              </label>
            </div>
            {mail.customerId ? null : <p className="text-sm font-bold">כתובת השולח אינה רשומה אצל אף לקוח, או רשומה אצל יותר מאחד. יש לבחור את הלקוח.</p>}

            {items.length === 0 ? (
              <p className="font-bold">בהודעה לא זוהו מוצרים. אפשר לדחות את ההמלצה ולפתוח את המסמך ביד.</p>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[46rem] text-start text-sm" id="inbound-lines">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 text-start font-normal">במסמך</th>
                      <th className="py-1 text-start font-normal">כפי שנכתב בהודעה</th>
                      <th className="py-1 text-start font-normal">מוצר בקטלוג</th>
                      <th className="py-1 text-start font-normal">מק״ט אחר</th>
                      <th className="py-1 text-start font-normal">כמות</th>
                      <th className="py-1 text-start font-normal">מחיר ליחידה (ידני, לא חובה)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={i} data-line={it.text} data-certain={String(it.certain)} className="border-t border-line align-top">
                        <td className="py-2">
                          <input type="checkbox" name={`use_${i}`} defaultChecked={!!it.sku && it.quantity !== null} aria-label={`לכלול את ${it.text}`} />
                        </td>
                        <td className="py-2">
                          {it.text}
                          {it.unit ? <span className="text-muted"> · {it.unit}</span> : null}
                          {it.sku && !it.certain ? <div className="font-bold">ההתאמה אינה ודאית, יש לבדוק</div> : null}
                          {!it.sku ? <div className="font-bold">לא נמצא מוצר מתאים</div> : null}
                        </td>
                        <td className="py-2">
                          <select name={`sku_${i}`} defaultValue={it.sku ?? ""} aria-label={`מוצר עבור ${it.text}`} className={`${field} max-w-72`}>
                            <option value="">לא נבחר</option>
                            {it.candidates.map((c) => (
                              <option key={c.sku} value={c.sku}>
                                {c.name} · {c.sku}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2">
                          <input name={`other_${i}`} dir="ltr" maxLength={30} aria-label={`מק״ט אחר עבור ${it.text}`} className={`${field} w-28`} />
                        </td>
                        <td className="py-2">
                          <input name={`qty_${i}`} inputMode="decimal" defaultValue={it.quantity ?? ""} aria-label={`כמות עבור ${it.text}`} className={`${field} w-24`} />
                        </td>
                        <td className="py-2">
                          <input name={`price_${i}`} inputMode="decimal" dir="ltr" placeholder="לפי הסכם" aria-label={`מחיר ידני עבור ${it.text}`} className={`${field} w-28`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-sm text-muted">מחיר ידני נכנס רק למסמך הזה, ולא משנה את הסכם המחיר של הלקוח. בלי מחיר ידני, המחיר נלקח מהסכם הלקוח, ואם אין הסכם, ממחיר הבסיס.</p>
            <p className="text-sm text-muted">הצעת מחיר נפתחת כטיוטה שלא נשלחה, וממשיכים לערוך אותה במסך ההצעות. הזמנה נפתחת מאושרת, כמו הזמנה שהוקלדה ביד, ולכן היא דורשת תאריך אספקה.</p>
          </ActionForm>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {items.map((it, i) => (
              <li key={i}>
                {it.quantity ?? "?"} {it.unit ?? ""} · {it.text}
                {it.sku ? ` · ${it.candidates.find((c) => c.sku === it.sku)?.name ?? ""} (${it.sku})` : " · בלי מוצר מתאים"}
              </li>
            ))}
          </ul>
        )}
      </section>

      {mail.status === "new" ? (
        <section className={panel} id="inbound-dismiss">
          <h2 className="mb-2 font-display text-lg font-bold">דחיית ההמלצה</h2>
          <ActionForm action={dismissAction} submit="דחה" primary={false}>
            <input type="hidden" name="id" value={mail.id} />
            <label className={label}>
              סיבה (לא חובה)
              <input name="reason" maxLength={300} className={`${field} w-80`} />
            </label>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
