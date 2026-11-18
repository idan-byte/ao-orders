import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { canCancel, canEdit, canHold, nextStatus, STATUS_LABEL, type DeliveryChange, type DeliveryStatus } from "@/lib/orders-core";
import { deliveryTone } from "@/lib/status-tone";
import { StatusPill } from "@/components/status-pill";
import { SOURCE_LABEL } from "@/lib/orders-data";
import { computeTotals } from "@/lib/quote-totals";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { advanceAction, cancelAction, holdAction, releaseAction } from "../actions";

type Delivery = { id: string; delivery_date: string; window: string | null; status: DeliveryStatus; address: string | null; production_notes: string | null; shipping_notes: string | null; exception_note: string | null; cancel_reason: string | null };
type Line = { delivery_id: string; sku: string; name: string; quantity: number; unit_price: number; discount_pct: number; vat_exempt: boolean; department: string | null };
type History = { entity_id: string; action: string; before: { status?: string } | null; after: { status?: string; note?: string; reason?: string; changes?: DeliveryChange[] }; who: string | null; created_at: string };

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
const qty = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
const stamp = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm text-foreground";
const NEXT_LABEL: Partial<Record<DeliveryStatus, string>> = { draft: "אשר הזמנה", pending_approval: "אשר הזמנה", approved: "התחל ייצור", in_production: "מוכנה לשילוח", shipped: "סופקה ללקוח" };

export default function OrderPage({ params }: PageProps<"/orders/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <OrderContent params={params} />
    </Suspense>
  );
}

async function OrderContent({ params }: { params: PageProps<"/orders/[id]">["params"] }) {
  const { user, allowed } = await requirePermission("orders.view");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const [order] = /^[0-9a-f-]{36}$/i.test(id)
    ? await query<{ id: string; number: number; customer_id: string; customer: string; vat_exempt: boolean; source: string; discount_pct: number; delivery_fee: number; vat_rate: number; status: string; owner: string | null; created_at: string; quote_id: string | null; quote_number: number | null }>(
        `select o.id::text, o.number, o.customer_id::text, c.name as customer, c.vat_exempt, o.source::text, o.discount_pct::float, o.delivery_fee::float, o.vat_rate::float,
                s.status, u.full_name as owner, o.created_at::text, qt.id::text as quote_id, qt.number as quote_number
         from orders o join customers c on c.id = o.customer_id join order_status s on s.order_id = o.id
         left join users u on u.id = o.owner_id left join quote_versions v on v.id = o.quote_version_id left join quotes qt on qt.id = v.quote_id
         where o.id = $1`,
        [id],
      )
    : [];
  if (!order) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold">ההזמנה לא נמצאה</h1>
        <Link href="/orders" className="text-accent underline">
          לכל ההזמנות
        </Link>
      </div>
    );
  }
  const deliveries = await query<Delivery>(
    `select id::text, delivery_date::text, nullif(concat_ws('–', to_char(window_from, 'HH24:MI'), to_char(window_to, 'HH24:MI')), '') as window, status::text as status,
            address_snapshot as address, production_notes, shipping_notes, exception_note, cancel_reason
     from deliveries where order_id = $1 order by delivery_date, id`,
    [id],
  );
  const lines = await query<Line>(
    `select l.delivery_id::text, l.sku, p.name || coalesce(' · ' || pv.name, '') as name, l.quantity::float, l.unit_price::float, l.discount_pct::float, p.vat_exempt, dp.name as department
     from delivery_lines l join deliveries d on d.id = l.delivery_id join products p on p.sku = l.sku
     left join product_ops o on o.sku = l.sku left join departments dp on dp.id = o.department_id
     left join product_variants pv on pv.id = l.variant_id
     where d.order_id = $1 order by l.id`,
    [id],
  );
  const history = await query<History>(
    `select a.entity_id, a.action, a.before, a.after, u.full_name as who, a.created_at::text
     from audit_log a left join users u on u.id = a.user_id
     where a.entity_type = 'delivery' and a.entity_id in (select id::text from deliveries where order_id = $1)
     order by a.created_at desc, a.id desc`,
    [id],
  );

  const showPrices = can(user.role, "prices.view");
  const mayEdit = can(user.role, "orders.edit");
  const mayCancel = can(user.role, "orders.cancel");
  const live = lines.filter((l) => deliveries.find((d) => d.id === l.delivery_id)?.status !== "cancelled");
  const totals = computeTotals(live.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, discountPct: l.discount_pct, vatExempt: l.vat_exempt })), order.discount_pct, order.delivery_fee, order.vat_rate, order.vat_exempt);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">
          הזמנה <span dir="ltr">{order.number}</span> · {order.customer}
        </h1>
        <div className="flex items-center gap-2">
          <StatusPill id="order-status" tone={deliveryTone(order.status)} className="px-3 py-1">
            {STATUS_LABEL[order.status] ?? order.status}
          </StatusPill>
          <Link href="/orders" className={small}>
            לכל ההזמנות
          </Link>
        </div>
      </div>

      <section className={panel}>
        <p className="text-sm text-muted">
          מקור: {SOURCE_LABEL[order.source] ?? order.source}
          {order.quote_id ? (
            <>
              {" "}
              (
              <Link href={`/quotes/${order.quote_id}`} className="text-accent underline-offset-2 hover:underline">
                הצעה {order.quote_number}
              </Link>
              )
            </>
          ) : null}
          {order.owner ? ` · אחראי: ${order.owner}` : ""} · נפתחה {stamp.format(new Date(order.created_at))} ·{" "}
          <Link href={`/customers/${order.customer_id}`} className="text-accent underline-offset-2 hover:underline">
            כרטיס הלקוח
          </Link>
        </p>
        {showPrices ? (
          <dl id="order-totals" className="mt-3 grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
            <dt>סה״כ פריטים</dt>
            <dd className="text-end">{money.format(totals.subtotal)}</dd>
            {totals.discount > 0 ? (
              <>
                <dt>הנחה {order.discount_pct}%</dt>
                <dd className="text-end" dir="ltr">
                  −{money.format(totals.discount)}
                </dd>
              </>
            ) : null}
            {totals.deliveryFee > 0 ? (
              <>
                <dt>דמי משלוח</dt>
                <dd className="text-end">{money.format(totals.deliveryFee)}</dd>
              </>
            ) : null}
            <dt>מע״מ {Math.round(order.vat_rate * 100)}%</dt>
            <dd className="text-end">{money.format(totals.vat)}</dd>
            <dt className="border-t border-line pt-1.5 font-display text-lg font-bold">לתשלום</dt>
            <dd id="order-total" className="border-t border-line pt-1.5 text-end font-display text-lg font-bold">
              {money.format(totals.total)}
            </dd>
          </dl>
        ) : null}
      </section>

      {deliveries.map((d, i) => {
        const dl = lines.filter((l) => l.delivery_id === d.id);
        const next = nextStatus(d.status);
        const held = d.status === "exception" || d.status === "delayed";
        const dh = history.filter((h) => h.entity_id === d.id);
        return (
          <section key={d.id} className={panel} data-delivery={i}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-base font-bold">
                אספקה {deliveries.length > 1 ? `${i + 1} מתוך ${deliveries.length} · ` : "· "}
                {dayFmt.format(new Date(d.delivery_date))}
                {d.window ? <span dir="ltr"> {d.window}</span> : null}
              </h2>
              <StatusPill data-delivery-status tone={deliveryTone(d.status)} className="px-3 py-1">
                {STATUS_LABEL[d.status]}
              </StatusPill>
            </div>
            <p className="text-sm text-muted">{d.address ?? "לא נבחרה כתובת אספקה"}</p>
            {held ? <p className="mt-2 rounded-lg bg-sunken px-3 py-2 text-sm font-medium">{d.status === "exception" ? "חריגה" : "עיכוב"}: {d.exception_note}</p> : null}
            {d.cancel_reason ? <p className="mt-2 rounded-lg bg-sunken px-3 py-2 text-sm">סיבת הביטול: {d.cancel_reason}</p> : null}

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse tabular-nums">
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <th className="px-2 py-1.5 text-start font-medium">מק״ט</th>
                    <th className="px-2 py-1.5 text-start font-medium">מוצר</th>
                    <th className="px-2 py-1.5 text-start font-medium">מחלקה</th>
                    <th className="px-2 py-1.5 text-end font-medium">כמות</th>
                    {showPrices ? <th className="px-2 py-1.5 text-end font-medium">מחיר</th> : null}
                    {showPrices ? <th className="px-2 py-1.5 text-end font-medium">סה״כ</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {dl.map((l, j) => (
                    <tr key={j} className="border-b border-line last:border-0">
                      <td className="px-2 py-2">{l.sku}</td>
                      <td className="px-2 py-2">{l.name}</td>
                      <td className="px-2 py-2">{l.department ?? "שירות"}</td>
                      <td className="px-2 py-2 text-end font-medium">{qty.format(l.quantity)}</td>
                      {showPrices ? (
                        <td className="px-2 py-2 text-end">
                          {money.format(l.unit_price)}
                          {l.discount_pct > 0 ? ` (−${l.discount_pct}%)` : ""}
                        </td>
                      ) : null}
                      {showPrices ? <td className="px-2 py-2 text-end">{money.format(Math.round(l.quantity * l.unit_price * (100 - l.discount_pct)) / 100)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.production_notes ? <p className="mt-2 text-sm">הערות לייצור: {d.production_notes}</p> : null}
            {d.shipping_notes ? <p className="mt-1 text-sm">הערות לשילוח: {d.shipping_notes}</p> : null}

            {mayEdit ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {next && NEXT_LABEL[d.status] ? (
                  <form action={advanceAction}>
                    <input type="hidden" name="delivery_id" value={d.id} />
                    <input type="hidden" name="expected" value={d.status} />
                    <button data-advance className="rounded-lg bg-accent px-4 py-2 font-medium text-surface">
                      {NEXT_LABEL[d.status]}
                    </button>
                  </form>
                ) : null}
                {d.status === "ready_to_ship" ? <span className="text-sm text-muted">היציאה לשילוח והפקת תעודת המשלוח ייבנו בשלב הבא.</span> : null}
                {held ? (
                  <form action={releaseAction}>
                    <input type="hidden" name="delivery_id" value={d.id} />
                    <button data-release className="rounded-lg bg-accent px-4 py-2 font-medium text-surface">
                      טופל, החזר למסלול
                    </button>
                  </form>
                ) : null}
                {canEdit(d.status) ? (
                  <Link data-edit href={`/orders/${id}/edit/${d.id}`} className="rounded-lg border border-line px-4 py-2">
                    שנה אספקה
                  </Link>
                ) : null}
              </div>
            ) : null}

            {mayEdit && canHold(d.status) ? (
              <div className="mt-3 border-t border-line pt-3">
                <ActionForm action={holdAction} submit="סמן" primary={false}>
                  <input type="hidden" name="delivery_id" value={d.id} />
                  <label className="flex flex-col gap-1 text-sm text-muted">
                    סימון
                    <select name="kind" defaultValue="exception" className={field} data-hold-kind>
                      <option value="exception">חריגה לטיפול</option>
                      <option value="delayed">עיכוב</option>
                    </select>
                  </label>
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-muted">
                    מה הבעיה
                    <input name="note" required className={field} data-hold-note />
                  </label>
                </ActionForm>
              </div>
            ) : null}
            {mayCancel && canCancel(d.status) ? (
              <div className="mt-3 border-t border-line pt-3">
                <ActionForm action={cancelAction} submit="בטל אספקה" primary={false}>
                  <input type="hidden" name="delivery_id" value={d.id} />
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-muted">
                    סיבת הביטול
                    <input name="reason" required className={field} data-cancel-reason />
                  </label>
                </ActionForm>
              </div>
            ) : null}

            {dh.length > 0 ? (
              <div className="mt-3 border-t border-line pt-3">
                <h3 className="mb-1.5 text-sm font-medium">היסטוריית שינויים</h3>
                <ul className="flex flex-col gap-1.5 text-sm" data-history>
                  {dh.map((h, k) => (
                    <li key={k}>
                      <span className="text-muted">
                        {stamp.format(new Date(h.created_at))}
                        {h.who ? ` · ${h.who}` : ""} ·{" "}
                      </span>
                      {h.action === "delivery_status" ? (
                        <>
                          {STATUS_LABEL[h.before?.status ?? ""] ?? ""} ← {STATUS_LABEL[h.after.status ?? ""] ?? ""}
                          {h.after.note ? `: ${h.after.note}` : ""}
                          {h.after.reason ? `: ${h.after.reason}` : ""}
                        </>
                      ) : (
                        (h.after.changes ?? []).map((c) => `${c.what}: ${c.before ?? "ריק"} ← ${c.after ?? "ריק"}`).join(" · ")
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
